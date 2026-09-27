try { require('dotenv').config(); } catch {}
const db = require('./db');
const { getProductMeta } = require('./storeApi');
(async () => {
  const ids = [2084, 2456, 2378];
  for (const id of ids) {
    try {
      const meta = await getProductMeta(id);
      const opt = meta.options[0];
      const row = await db.addTracked({ store_id: meta.id, product_name: meta.name, option_id: opt.id, option_label: opt.label, product_url: `https://demo.inelabteamdev.com/item/${meta.id}` });
      console.log('tracked:', row.product_name, '/', row.option_label);
    } catch (e) { console.error('seed fail', id, e.message); }
  }
})();
