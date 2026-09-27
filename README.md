# Product Price Tracker (INE Intern Assignment)

Full-stack app: search INE mock store → track product+option → scrape price/stock every 2h → history chart/table + scrape log + CSV export.

- Frontend: React (Vite) → deploy on **Vercel**
- Backend: Node + Express + Playwright → deploy on **Render**
- DB: **Supabase** (Postgres), with local JSON fallback when env not set
- Scheduling: **cron-job.org** hits `GET /api/scrape?secret=…` every 2h (free-tier safe, no always-on loop)

## Quick start (local)

```bash
# backend
cd backend
npm install
npx playwright install chromium
cp .env.example .env   # fill SUPABASE_URL/KEY or leave empty for local data.json
npm start              # :8080

# frontend (second terminal)
cd ../frontend
npm install
npm run dev            # :5173, proxies /api → :8080
```

## Env vars (backend)

| var | required | notes |
|---|---|---|
| `PORT` | no (default 8080) | Render sets it |
| `STORE_BASE` | no (default mock store) | `https://demo.inelabteamdev.com` |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | prod yes / local no | without them uses `backend/data.json` |
| `CRON_SECRET` | prod yes | cron-job.org sends `?secret=`; local can be empty |
| `HEADED` | no | `HEADED=1 npm run scrape:headed` for observable run |

Frontend: `VITE_API_BASE=https://<your-render-app>.onrender.com` (empty = same-origin/proxy).

## Schedule (every 2 hours)

cron-job.org job:
- URL: `https://<backend>.onrender.com/api/scrape?secret=<CRON_SECRET>`
- Schedule: every 2 hours (`0 */2 * * *`)
- Timeout 120s+. The endpoint scrapes all tracked products sequentially and logs one row per product per run.

Keep-alive: free Render sleeps; cron hit wakes it. First run after sleep may take ~60s (cold start + browser).

## Headed (observable) run + recording

```bash
cd backend
HEADED=1 node src/runOnce.js 2456 o1
# or all tracked:
HEADED=1 npm run scrape:headed
```
Record with OBS/Xbox Game Bar (2–4 min) showing: hover over price panel, click "Check today's price", slow/async wait, retry on failure. See DESIGN_NOTE.md.

## API

- `GET /api/search?q=` · `GET /api/products/:storeId` · `GET /api/manifest`
- `GET/POST /api/tracked`, `DELETE /api/tracked/:id`
- `GET /api/tracked/:id/history` · `POST /api/tracked/:id/scrape`
- `GET /api/export.csv` — columns: store_product_id,product_name,selected_option,timestamp_utc,price,stock,outcome
- `GET/POST /api/scrape?secret=` — cron trigger

## Deploy

- Supabase: run `supabase/schema.sql`, copy URL + anon key.
- Render: root `backend/`, build `npm install && npx playwright install chromium`, start `npm start`. Set env above.
- Vercel: root `frontend/`, build `npm run build`, output `dist`. Set `VITE_API_BASE`.
