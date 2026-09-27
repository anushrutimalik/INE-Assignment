// Lightweight HTTP access to the mock store catalog (no browser needed).
// Search = scan paginated /api/v2/listings and filter by substring.
const STORE = (process.env.STORE_BASE || 'https://demo.inelabteamdev.com').replace(/\/$/, '');

let catalogCache = { at: 0, items: [] };
const CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchListingsPage(page, limit = 60) {
  const res = await fetch(`${STORE}/api/v2/listings?page=${page}&limit=${limit}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`catalog ${res.status}`);
  return res.json();
}

async function getCatalog() {
  if (Date.now() - catalogCache.at < CACHE_TTL_MS && catalogCache.items.length) return catalogCache.items;
  const first = await fetchListingsPage(1, 60);
  const totalPages = first.totalPages || 1;
  const items = [...first.results];
  // Fetch remaining pages with small concurrency
  const pages = [];
  for (let p = 2; p <= totalPages; p++) pages.push(p);
  const CONC = 4;
  for (let i = 0; i < pages.length; i += CONC) {
    const batch = await Promise.all(pages.slice(i, i + CONC).map(p => fetchListingsPage(p, 60).catch(() => ({ results: [] }))));
    for (const b of batch) items.push(...(b.results || []));
  }
  catalogCache = { at: Date.now(), items };
  return items;
}

async function searchProducts(q, limit = 25) {
  const items = await getCatalog();
  const needle = (q || '').trim().toLowerCase();
  if (!needle) return items.slice(0, limit);
  return items.filter(p =>
    p.name.toLowerCase().includes(needle) ||
    String(p.id).includes(needle) ||
    (p.brand || '').toLowerCase().includes(needle) ||
    (p.category || '').toLowerCase().includes(needle)
  ).slice(0, limit);
}

async function getProductMeta(storeId) {
  const res = await fetch(`${STORE}/api/v2/items/${storeId}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`product ${res.status}`);
  return res.json();
}

async function getManifest() {
  try {
    const res = await fetch(`${STORE}/api/v2/ui/manifest`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

module.exports = { STORE, searchProducts, getProductMeta, getManifest, getCatalog };
