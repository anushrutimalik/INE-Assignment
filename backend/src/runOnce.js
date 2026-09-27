// One-shot scrape runner (used by Render cron + headed recording).
// Usage: node src/runOnce.js [storeId] [optionId]  |  HEADED=1 npm run scrape:headed
try { require('dotenv').config(); } catch {}
const db = require('./db');
const { scrapeAll, closeBrowser } = require('./scraper');

(async () => {
  const [storeId, optionId] = process.argv.slice(2);
  let tracked = await db.listTracked();
  if (storeId) {
    const { getProductMeta } = require('./storeApi');
    const meta = await getProductMeta(storeId);
    const opt = (meta.options || []).find(o => o.id === optionId) || meta.options[0];
    tracked = [{ id: 'adhoc', store_id: meta.id, product_name: meta.name, option_id: opt.id, option_label: opt.label }];
    console.log(`headed demo: ${meta.name} / ${opt.label} (store ${meta.id})`);
  }
  if (!tracked.length) { console.log('no tracked products'); await closeBrowser(); return; }
  console.log(`scraping ${tracked.length} product(s), HEADED=${process.env.HEADED || '0'}...`);
  const { results, manifest } = await scrapeAll(tracked, {
    onProgress: (t, r) => console.log(`- ${t.product_name} [${t.option_label}]:`, r.ok ? `₹${r.price} stock=${r.stock} attempts=${r.attemptsUsed}` : `FAILED: ${r.error}`),
  });
  console.log('manifest revision:', manifest && manifest.revision);
  // Persist when scraping real tracked list (not adhoc)
  if (!storeId) {
    for (const r of results) {
      await db.logAttempt({
        tracked_id: r.tracked.id, store_id: r.tracked.store_id, product_name: r.tracked.product_name,
        option_id: r.tracked.option_id, option_label: r.tracked.option_label,
        price: r.ok ? r.price : null, stock: r.ok ? r.stock : null,
        outcome: r.ok ? (r.attemptsUsed > 1 ? 'retried' : 'success') : 'failed',
        message: r.ok ? `attempts=${r.attemptsUsed}` : r.error,
        duration_ms: r.ms || null, manifest_revision: manifest ? String(manifest.revision || '') : '',
      });
    }
    console.log('logged to', process.env.SUPABASE_URL ? 'supabase' : 'local data.json');
  }
  await closeBrowser();
})().catch(async e => { console.error('runOnce failed:', e); await closeBrowser(); process.exit(1); });
