// Reliable Playwright scraper for the INE mock store.
// Why browser (not fetch): price/stock is gated behind JS challenge —
// canvas fingerprint + WASM PoW + mouse-dwell (8 moves, 600ms) + trusted click,
// plus randomised DOM (classes/order/order, price formatting, stock strings,
// delayed/async content, 35% flaky nav, popups, slow/5xx). fetch alone can't pass.
//
// Reliability strategy:
//  - up to 6 attempts per product with exponential backoff (300ms * n)
//  - fresh browser context per run; headed mode supported via HEADED=1 for observation
//  - handle cookie-consent popup (Allow/Reject) whichever appears
//  - select the tracked variant/option before revealing price
//  - human-like hover: >=12 mouse moves over .offer-panel + 800ms dwell, then trusted click
//  - explicit waits for async content (loading -> success), never store on failure
//  - robust number parsing: fullwidth digits, nbsp/zero-width, lakh/euro/spaced formats
//  - per-attempt outcome: success | retried | failed, all logged honestly
//  - manifest change detection: compare /api/v2/ui/manifest revision vs last run
const { STORE, getManifest } = require('./storeApi');
let _chromium = null;
function chromium() {
  if (!_chromium) _chromium = require('playwright').chromium;
  return _chromium;
}

const MAX_ATTEMPTS = 6;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Map fullwidth digits to ascii, strip everything except digits/dot, parse.
function parsePriceToNumber(raw) {
  if (raw == null) return null;
  let s = String(raw);
  s = s.replace(/[\uFF10-\uFF19]/g, ch => String(ch.charCodeAt(0) - 0xFF10)); // fullwidth
  s = s.replace(/[०-९]/g, ch => String('०१२३४५६७८९'.indexOf(ch))); // devanagari just in case
  s = s.replace(/[\u200B\u200C\u200D\uFEFF\u00A0]/g, ''); // zero-width + nbsp
  const m = s.match(/[\d.,]+/);
  if (!m) return null;
  let num = m[0];
  // euro "1.234,00" -> 1234 ; lakh "Rs.1,234.00" fine; spaced "1 234" fine
  if (/^\d{1,3}(\.\d{3})+,\d{2}$/.test(num)) num = num.replace(/\./g, '').replace(',', '.');
  else num = num.replace(/,/g, '').replace(/ /g, '');
  const v = Number(num);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

function parseStockToInt(raw) {
  if (raw == null) return null;
  const m = String(raw).replace(/[\u200B-\u200D\uFEFF]/g, '').match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

async function dismissPopups(page) {
  // Cookie consent: buttons Allow / Reject; also random modal positions.
  for (const label of ['Allow', 'Reject']) {
    try {
      const btn = page.getByRole('button', { name: label });
      if (await btn.count() > 0 && await btn.first().isVisible({ timeout: 1500 })) {
        await btn.first().click({ timeout: 2000 }).catch(() => {});
        await sleep(300);
      }
    } catch {}
  }
  // Generic dialog close if it blocks
  try {
    await page.keyboard.press('Escape').catch(() => {});
  } catch {}
}

async function scrapeOneWithBrowser(browser, { storeId, optionId }, manifest) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(25000);
  let lastError = null;
  let attemptsUsed = 0;

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      attemptsUsed = attempt;
      const t0 = Date.now();
      try {
        await page.goto(`${STORE}/item/${storeId}`, { waitUntil: 'domcontentloaded' });
        await dismissPopups(page);
        // Product shell must load (meta comes via /api/v2/items — fast path)
        await page.waitForSelector('.pdp-summary, .pdp-hero, .offer-panel', { timeout: 15000 });

        // Select tracked option if multiple (buttons .opt-chip)
        if (optionId) {
          try {
            const chip = page.locator(`.opt-chip:has-text("${optionId}")`).first();
            // options are labelled by human label, not id — so match by index fallback:
            // find all chips, click the one whose aria-pressed=false and index matches optionId (o1/o2/...)
            const chips = page.locator('.opt-chip');
            const n = await chips.count();
            if (n > 1) {
              const idx = parseInt(String(optionId).replace(/\D/g, ''), 10);
              const target = chips.nth(Number.isFinite(idx) && idx >= 1 ? idx - 1 : 0);
              if (await target.count() > 0) {
                const pressed = await target.getAttribute('aria-pressed').catch(() => null);
                if (pressed !== 'true') await target.click({ timeout: 3000 }).catch(() => {});
                await sleep(400);
              }
            }
          } catch {}
        }

        const panel = page.locator('.offer-panel').first();
        await panel.waitFor({ state: 'visible', timeout: 12000 });

        // Human-like hover: >=12 moves across the panel + dwell (site needs 8 moves + 600ms)
        const box = await panel.boundingBox();
        if (box) {
          for (let i = 0; i < 14; i++) {
            const x = box.x + 20 + Math.random() * (box.width - 40);
            const y = box.y + 10 + Math.random() * (box.height - 20);
            await page.mouse.move(x, y, { steps: 3 });
            await sleep(60 + Math.random() * 60);
          }
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
        } else {
          await panel.hover({ timeout: 5000 }).catch(() => {});
        }
        await sleep(900); // exceed 600ms dwell

        // Click "Check today's price" (trusted event — must be real click, not JS dispatch)
        const checkBtn = page.getByRole('button', { name: /Check today/i });
        if (await checkBtn.count() > 0) {
          await checkBtn.first().click({ timeout: 5000 });
        } else {
          // fallback: any primary button in panel
          await panel.locator('button.ctl-main, button').first().click({ timeout: 5000 });
        }

        // Wait for async reveal: loader -> price/stock OR error. Poll up to 25s.
        const deadline = Date.now() + 25000;
        let quote = null;
        let phase = '';
        while (Date.now() < deadline) {
          // Success markers: price value class contains -c5 (randomised) or [class*=priceValue] etc.
          const priceText = await page.locator('.offer-panel').first().innerText({ timeout: 3000 }).catch(() => '');
          // Error marker
          const isError = /couldn|failed|error|try again/i.test(priceText) && !/\d/.test(priceText.replace(/[^\d\uFF10-\uFF19]/g, '').slice(0, 1)) ? false : false;
          void isError;
          // Detect rendered price: look for currency-ish text with digits
          const priceCandidate = await page.evaluate(() => {
            const panel = document.querySelector('.offer-panel');
            if (!panel) return null;
            const text = panel.innerText || '';
            // price area usually has ₹ or Rs or digits; stock line separate
            return text;
          }).catch(() => null);
          // Success if panel shows a price AND (stock or delivery) — site renders offer details
          if (priceCandidate && /[₹Rs]/.test(priceCandidate) && /\d/.test(priceCandidate)) {
            // ensure not still "Loading" / "Retrying"
            if (!/Loading|Retrying/i.test(priceCandidate)) {
              // grab structured fields
              quote = await page.evaluate(() => {
                const panel = document.querySelector('.offer-panel');
                const txt = panel ? (panel.innerText || '') : document.body.innerText;
                return { text: txt, html: panel ? panel.innerHTML.slice(0, 4000) : '' };
              });
              phase = 'success';
              break;
            }
          }
          // Explicit error phase
          const errVisible = await page.locator('.offer-panel').getByText(/couldn|failed|error/i).count().catch(() => 0);
          if (errVisible > 0) {
            const msg = await page.locator('.offer-panel').first().innerText().catch(() => 'scrape error phase');
            throw new Error(msg.slice(0, 200));
          }
          await sleep(500);
          // Dismiss any popup that appeared mid-wait (blocks clicks on retry)
          if (Math.random() < 0.3) await dismissPopups(page);
        }
        if (!quote) throw new Error('price panel did not reveal in time (slow/async load)');

        const price = parsePriceToNumber(quote.text);
        // Stock: find stock-ish line in panel text
        const stockLine = (quote.text.match(/(units available|Last few|Available|Stock|ship ·\s*\d+|remaining)/i) || [])[0]
          ? quote.text.split('\n').find(l => /unit|few|avail|stock|ship|remain/i.test(l)) : null;
        const stock = parseStockToInt(stockLine || quote.text);
        if (price == null) throw new Error('price parse failed (layout shift?) text=' + quote.text.slice(0, 120));

        return { ok: true, price, stock, attemptsUsed, ms: Date.now() - t0, manifestRev: manifest ? String(manifest.revision || manifest.variant || '') : '' };
      } catch (e) {
        lastError = e;
        // Retryable: timeouts, slow loads, 429/5xx surfaced as catalog/product errors, reveal timeout.
        // Fatal (no retry): none — we retry everything up to MAX, then mark failed.
        if (attempt < MAX_ATTEMPTS) {
          await sleep(300 * attempt);
          continue;
        }
        return { ok: false, error: String((e && e.message) || e).slice(0, 300), attemptsUsed };
      }
    }
    return { ok: false, error: String((lastError && lastError.message) || lastError || 'failed').slice(0, 300), attemptsUsed };
  } finally {
    await context.close().catch(() => {});
  }
}

let _browser = null;
async function getBrowser() {
  if (_browser) return _browser;
  const headed = process.env.HEADED === '1';
  _browser = await chromium().launch({
    headless: !headed,
    slowMo: headed ? 120 : 0,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  return _browser;
}
async function closeBrowser() {
  if (_browser) { await _browser.close().catch(() => {}); _browser = null; }
}

// Scrape many tracked products sequentially (polite + avoids challenge rate-limit 429).
async function scrapeAll(trackedList, { onProgress } = {}) {
  const browser = await getBrowser();
  const manifest = await getManifest().catch(() => null);
  const results = [];
  for (const t of trackedList) {
    const r = await scrapeOneWithBrowser(browser, { storeId: t.store_id, optionId: t.option_id }, manifest);
    results.push({ tracked: t, ...r });
    if (onProgress) onProgress(t, r);
    await sleep(800);
  }
  return { results, manifest };
}

module.exports = { scrapeAll, scrapeOneWithBrowser, getBrowser, closeBrowser, parsePriceToNumber, parseStockToInt, MAX_ATTEMPTS };
