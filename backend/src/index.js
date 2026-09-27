const express = require('express');
const cors = require('cors');
try { require('dotenv').config(); } catch {}
const db = require('./db');
const { searchProducts, getProductMeta, getManifest, STORE } = require('./storeApi');
const { scrapeAll, closeBrowser } = require('./scraper');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const CRON_SECRET = process.env.CRON_SECRET || '';

app.get('/api/health', (req, res) => res.json({ ok: true, store: STORE, db: db.usingSupabase() ? 'supabase' : 'local', now: new Date().toISOString() }));

// Search mock store (lightweight HTTP, no browser)
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const results = await searchProducts(q, 25);
    res.json({ q, count: results.length, results });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Product meta incl. options (for option picker)
app.get('/api/products/:storeId', async (req, res) => {
  try {
    const meta = await getProductMeta(req.params.storeId);
    res.json(meta);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get('/api/manifest', async (req, res) => {
  const m = await getManifest();
  if (!m) return res.status(502).json({ error: 'manifest unavailable' });
  res.json(m);
});

// Tracked CRUD
app.get('/api/tracked', async (req, res) => {
  try {
    const list = await db.listTracked();
    res.json(list);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/api/tracked', async (req, res) => {
  try {
    const { store_id, option_id } = req.body;
    if (!store_id) return res.status(400).json({ error: 'store_id required' });
    const meta = await getProductMeta(store_id);
    const opt = (meta.options || []).find(o => o.id === option_id) || meta.options[0] || { id: 'o1', label: '' };
    const row = await db.addTracked({
      store_id: meta.id, product_name: meta.name,
      option_id: opt.id, option_label: opt.label || '',
      product_url: `${STORE}/item/${meta.id}`,
    });
    res.json(row);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.delete('/api/tracked/:id', async (req, res) => {
  try { await db.removeTracked(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/tracked/:id/history', async (req, res) => {
  try {
    const rows = await db.getHistory(req.params.id, 500);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// CSV export: one row per scrape attempt (incl. failures with empty price/stock)
function toCsv(rows) {
  const head = 'store_product_id,product_name,selected_option,timestamp_utc,price,stock,outcome';
  const esc = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = rows.map(r => [
    r.store_id, esc(r.product_name), esc(r.option_label || r.option_id),
    new Date(r.ts).toISOString(), r.price ?? '', r.stock ?? '', r.outcome,
  ].join(','));
  return head + '\n' + lines.join('\n') + '\n';
}

app.get('/api/export.csv', async (req, res) => {
  try {
    const rows = await db.getAllAttempts(5000);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="scrape-history.csv"');
    res.send(toCsv(rows));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Scrape triggers. Guarded by CRON_SECRET when set (cron-job.org sends ?secret=).
function checkSecret(req, res, next) {
  if (!CRON_SECRET) return next();
  if (req.query.secret === CRON_SECRET || req.headers['x-cron-secret'] === CRON_SECRET) return next();
  return res.status(401).json({ error: 'bad secret' });
}

async function runScrapeForAll() {
  const tracked = await db.listTracked();
  if (!tracked.length) return { ran: 0, results: [] };
  const started = Date.now();
  const { results, manifest } = await scrapeAll(tracked);
  const rev = manifest ? String(manifest.revision || '') : '';
  // change detection: compare manifest classes/order vs previous? log revision each run.
  for (const r of results) {
    const t = r.tracked;
    if (r.ok) {
      const outcome = r.attemptsUsed > 1 ? 'retried' : 'success';
      await db.logAttempt({
        tracked_id: t.id, store_id: t.store_id, product_name: t.product_name,
        option_id: t.option_id, option_label: t.option_label,
        price: r.price, stock: r.stock, outcome,
        message: r.attemptsUsed > 1 ? `succeeded on attempt ${r.attemptsUsed}` : 'ok',
        duration_ms: r.ms, manifest_revision: rev,
      });
    } else {
      await db.logAttempt({
        tracked_id: t.id, store_id: t.store_id, product_name: t.product_name,
        option_id: t.option_id, option_label: t.option_label,
        price: null, stock: null, outcome: 'failed',
        message: r.error, duration_ms: null, manifest_revision: rev,
      });
    }
  }
  return { ran: tracked.length, ms: Date.now() - started, results: results.map(r => ({ store_id: r.tracked.store_id, ok: r.ok, price: r.price, attempts: r.attemptsUsed })) };
}

app.post('/api/scrape', checkSecret, async (req, res) => {
  try {
    // cron-job.org uses GET sometimes — accept both; keep POST primary.
    const out = await runScrapeForAll();
    res.json({ ok: true, ...out, at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
app.get('/api/scrape', checkSecret, async (req, res) => {
  try {
    const out = await runScrapeForAll();
    res.json({ ok: true, ...out, at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.post('/api/tracked/:id/scrape', async (req, res) => {
  try {
    const t = await db.getTracked(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    const { results, manifest } = await scrapeAll([t]);
    const r = results[0];
    const rev = manifest ? String(manifest.revision || '') : '';
    if (r.ok) {
      const row = await db.logAttempt({
        tracked_id: t.id, store_id: t.store_id, product_name: t.product_name,
        option_id: t.option_id, option_label: t.option_label,
        price: r.price, stock: r.stock, outcome: r.attemptsUsed > 1 ? 'retried' : 'success',
        message: r.attemptsUsed > 1 ? `succeeded on attempt ${r.attemptsUsed}` : 'ok',
        duration_ms: r.ms, manifest_revision: rev,
      });
      res.json({ ok: true, attempt: row });
    } else {
      const row = await db.logAttempt({
        tracked_id: t.id, store_id: t.store_id, product_name: t.product_name,
        option_id: t.option_id, option_label: t.option_label,
        price: null, stock: null, outcome: 'failed', message: r.error, manifest_revision: rev,
      });
      res.json({ ok: false, attempt: row });
    }
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.listen(PORT, () => console.log(`backend on :${PORT} store=${STORE} db=${db.usingSupabase() ? 'supabase' : 'local'}`));
process.on('SIGTERM', async () => { await closeBrowser(); process.exit(0); });
