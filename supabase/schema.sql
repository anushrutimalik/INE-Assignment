-- Supabase schema for Product Price Tracker
-- Run in Supabase SQL editor.

create table if not exists tracked_products (
  id uuid primary key default gen_random_uuid(),
  store_id integer not null,
  product_name text not null,
  option_id text not null default 'o1',
  option_label text,
  product_url text,
  created_at timestamptz not null default now(),
  unique (store_id, option_id)
);

create table if not exists scrape_attempts (
  id uuid primary key default gen_random_uuid(),
  tracked_id uuid references tracked_products(id) on delete cascade,
  store_id integer not null,
  product_name text not null,
  option_id text not null default 'o1',
  option_label text,
  ts timestamptz not null default now(),
  price numeric null,
  stock integer null,
  outcome text not null check (outcome in ('success','retried','failed')),
  message text,
  duration_ms integer,
  manifest_revision text
);

create index if not exists idx_attempts_tracked_ts on scrape_attempts(tracked_id, ts desc);
create index if not exists idx_tracked_store on tracked_products(store_id);

alter table tracked_products enable row level security;
alter table scrape_attempts enable row level security;

-- Open read/write for anon (demo assignment; tighten in prod with auth):
drop policy if exists "open all tracked" on tracked_products;
create policy "open all tracked" on tracked_products for all using (true) with check (true);
drop policy if exists "open all attempts" on scrape_attempts;
create policy "open all attempts" on scrape_attempts for all using (true) with check (true);
