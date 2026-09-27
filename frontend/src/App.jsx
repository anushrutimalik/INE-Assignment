import React, { useEffect, useState } from 'react';

const API = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');

function Spark({ points }) {
  const vals = points.filter(p => p.price != null).map(p => Number(p.price));
  if (vals.length < 2) return <span style={{color:'#888'}}>need 2+ points</span>;
  const w = 300, h = 80, min = Math.min(...vals), max = Math.max(...vals);
  const rng = max - min || 1;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1) * (w - 8) + 4).toFixed(1)},${(h - 8 - ((v - min) / rng) * (h - 16)).toFixed(1)}`).join(' ');
  return (<svg width={w} height={h} style={{border:'1px solid #ddd', background:'#fafafa'}}>
    <polyline points={pts} fill="none" stroke="#2563eb" strokeWidth="2" />
  </svg>);
}

function Card({ t, onChanged }) {
  const [hist, setHist] = useState([]);
  const [scraping, setScraping] = useState(false);
  const load = () => fetch(`${API}/api/tracked/${t.id}/history`).then(r => r.json()).then(setHist).catch(()=>{});
  useEffect(() => { load(); }, [t.id]);
  const scrape = async () => {
    setScraping(true);
    await fetch(`${API}/api/tracked/${t.id}/scrape`, { method: 'POST' });
    await load(); onChanged && onChanged(); setScraping(false);
  };
  const remove = async () => {
    await fetch(`${API}/api/tracked/${t.id}`, { method: 'DELETE' });
    onChanged && onChanged();
  };
  const latest = [...hist].reverse().find(h => h.price != null);
  return (
    <div style={{border:'1px solid #ddd', borderRadius:8, padding:12, margin:'12px 0'}}>
      <h3>{t.product_name} <small style={{color:'#555'}}>#{t.store_id} · {t.option_label || t.option_id}</small></h3>
      <p>Latest: {latest ? `₹${latest.price} (stock ${latest.stock ?? '?'}) @ ${latest.ts}` : 'no successful scrape yet'}</p>
      <Spark points={hist} />
      <div>
        <button onClick={scrape} disabled={scraping}>{scraping ? 'Scraping…' : 'Scrape now'}</button>{' '}
        <button onClick={remove}>Untrack</button>{' '}
        <a href={`${API}/api/tracked/${t.id}/history`} target="_blank" rel="noreferrer">history JSON</a>
      </div>
      <table border="1" cellPadding="4" style={{marginTop:8, borderCollapse:'collapse', fontSize:13}}>
        <thead><tr><th>time (UTC)</th><th>price</th><th>stock</th><th>outcome</th><th>msg</th></tr></thead>
        <tbody>{[...hist].reverse().slice(0,20).map(h => (
          <tr key={h.id}><td>{h.ts}</td><td>{h.price ?? ''}</td><td>{h.stock ?? ''}</td><td>{h.outcome}</td><td>{h.message}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export default function App() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [tracked, setTracked] = useState([]);
  const [meta, setMeta] = useState({});
  const loadTracked = () => fetch(`${API}/api/tracked`).then(r => r.json()).then(setTracked).catch(()=>{});
  useEffect(() => { loadTracked(); }, []);
  const search = async (e) => {
    e.preventDefault();
    const r = await fetch(`${API}/api/search?q=${encodeURIComponent(q)}`).then(r => r.json());
    setResults(r.results || []);
  };
  const viewOptions = async (id) => {
    const m = await fetch(`${API}/api/products/${id}`).then(r => r.json());
    setMeta(prev => ({ ...prev, [id]: m }));
  };
  const track = async (id, optionId) => {
    await fetch(`${API}/api/tracked`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ store_id: id, option_id: optionId }) });
    await loadTracked();
  };
  return (
    <div style={{maxWidth:900, margin:'0 auto', padding:16, fontFamily:'system-ui'}}>
      <h1>Product Price Tracker</h1>
      <p>Search the INE mock store, track a product + option. Scrapes run every 2h via cron-job.org → <code>GET /api/scrape?secret=…</code>.</p>
      <form onSubmit={search}>
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="partial or full product name (e.g. camera)" style={{width:320}} />
        <button type="submit">Search</button>{' '}
        <a href={`${API}/api/export.csv`}><button type="button">Export CSV</button></a>
      </form>
      {results.map(p => (
        <div key={p.id} style={{border:'1px solid #eee', padding:8, margin:'8px 0'}}>
          <b>{p.name}</b> <span>#{p.id} · {p.brand} · {p.category}</span>
          <div>
            <button onClick={()=>viewOptions(p.id)}>Options</button>{' '}
            {meta[p.id] ? (meta[p.id].options||[]).map(o => (
              <span key={o.id} style={{marginRight:8}}><button onClick={()=>track(p.id, o.id)}>Track {o.label}</button></span>
            )) : <button onClick={()=>track(p.id, undefined)}>Track default</button>}
          </div>
          {meta[p.id] && <small>axis: {meta[p.id].optionAxis} · <a href={`https://demo.inelabteamdev.com/item/${p.id}`} target="_blank" rel="noreferrer">store page</a></small>}
        </div>
      ))}
      <h2>Tracked ({tracked.length})</h2>
      {tracked.map(t => <Card key={t.id} t={t} onChanged={loadTracked} />)}
    </div>
  );
}
