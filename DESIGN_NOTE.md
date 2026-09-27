# Design note — how the scraping was made reliable

## What makes the store hard (found by reading the bundle)
- SPA (`/assets/index-*.js`); catalog is plain JSON (`/api/v2/listings`, `/api/v2/items/:id`) but **price is not** — it needs a JS challenge flow `Dr(productId, optionId, behaviourSnapshot)`:
  - `GET` challenge → canvas fingerprint (`ar`: gradient + text `INE store ✓ price ₹ 42.9`) + WebGL renderer hash + `hardwareConcurrency/screen/frames` + `requestAnimationFrame` timings
  - SHA-256 reimplementation (`mr`), PoW `xr` (leading-zero hash), WASM (`Cr`) check, XOR-encrypted quote `wr` (fields `q=shown price, l=mrp, k=sale, o=badge, a=stock, u=currency, w=at, h=rating…`)
  - `POST` solution → `pass` token → `GET quotes/:id?option=` with `Authorization: Bearer pass`
- Interaction gate `Ar`: `minMoves=8, minDwellMs=600`, moves sampled ≤40ms, `isTrusted` click required. Button wrapped in `Xn`: 35% random drop/delay (900ms).
- Display traps: randomised class names + order (`/api/v2/ui/manifest` revision), price formats (`spaced/euro/trailing/unicode(nbsp)/lakh`), zero-width joiners between digits, split `d1/d2` decoys, 5 random stock templates, 4 delivery templates, rating recalculated often.
- Infra flakiness: slow/async loads, occasional 429/5xx, consent popup `Qr` (random position bottom/top/center, delay 1.5–5s) that locks scroll, random default option.

## Judgment: lightweight vs browser
- **Lightweight fetch for search/meta/manifest** (`storeApi.js`): plain `fetch`, catalog cached 10 min, full scan 16 pages (limit capped 60) filtered server-side. No browser cost.
- **Playwright (Chromium) for price/stock** (`scraper.js`): the page *genuinely requires* JS rendering + human behaviour + canvas/WASM. Reimplementing the challenge in Node would be brittle (obfuscated `P()` strings, WASM bytes) and would break on the next bundle hash. Browser reuses the store's own code, so it survives minor obfuscation changes; only layout selectors need maintenance.

## Reliability tactics
1. **Retry honestly**: `MAX_ATTEMPTS=6` (mirrors site's `jr=6`), backoff `300ms*n`, fresh check each attempt. Outcome recorded as `success` (1st try), `retried` (>1), `failed` (all exhausted) — failures kept with empty price/stock, never hidden.
2. **Human behaviour**: ≥14 mouse moves over `.offer-panel` + 900ms dwell (exceeds 600ms), real trusted `click()` (Playwright = trusted), `Escape`/Allow/Reject popup dismissal before and during waits.
3. **Wait for async, don't guess**: poll panel text up to 25s for currency+digits without Loading/Retrying; detect explicit error text and throw to retry. Timeouts are retryable, never stored as data.
4. **Robust parsing**: `parsePriceToNumber` normalises fullwidth digits, strips zero-width/nbsp, handles euro `1.234,00` vs lakh/commas; `parseStockToInt` takes first int from the stock-like line. If price is null → throw (layout shift) instead of storing wrong data.
5. **Sequential + polite**: one product at a time + 800ms gap to avoid 429; per-run manifest fetch, `manifest_revision` stored per attempt for change detection (dashboard can flag when revision changes).
6. **Scheduling for sleepy free tier**: no in-process loop; stateless `GET/POST /api/scrape?secret=` triggered by cron-job.org every 2h. Cold starts tolerated (25s nav timeout, 25s reveal poll).

## Trade-offs
- Sequential scraping is slower (n × ~10–20s) but avoids rate-limit 429 and is honest about duration. Parallel would be faster but flaky.
- Local JSON fallback when Supabase env is missing: great for local grading, but prod must set Supabase keys or history splits across Render restarts.
- No price-drop email (bonus) in base cut to keep the core reliable; schema supports it (`latest vs previous` query).

## What AI got wrong first, and fixes
1. **"Just fetch + cheerio the price"** — wrong: initial HTML is `<div id=root>` only; price needs JS challenge. Fixed by inspecting bundle (`/api/v2/*`, `Dr`, `Ar`, `jr=6`) and switching to Playwright for quotes only.
2. **Regex price from HTML** — wrong: randomised classes + zero-width/unicode formats break naive `\d+`. Fixed with normaliser + panel `innerText` + null-on-fail.
3. **`setInterval` scheduler in Node** — wrong on free tier (sleeps, duplicate runs). Fixed with external cron endpoint + secret.
4. **Single attempt, hide errors** — wrong per spec ("never silently stop"). Fixed with 6-attempt log + `retried/failed` states + CSV includes failures.
