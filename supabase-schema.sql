-- ────────────────────────────────────────────────────────────────────────────
-- Meshminds — required Supabase schema (reference)
--
-- Run these statements once in your Supabase SQL Editor (Dashboard → SQL).
-- Re-running is safe; everything uses IF NOT EXISTS.
--
-- Tables touched by the API:
--   email_leads          gate signups + later /save-results submissions
--   scans                one row per analysis (anon + signed-in)
--   market_observations  per-scan market datapoints (powers recentObs blend)
--   usage_log            per-IP daily quota counter
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Email lead capture (gate + save-results form)
create table if not exists public.email_leads (
  id          bigserial primary key,
  email       text         not null,
  url         text,
  score       int,
  verdict     text,
  consent     boolean      default false,
  source      text,                          -- 'idea-page-url' | 'idea-page-idea' | 'save-results' | etc.
  ip_hash     text,
  created_at  timestamptz  default now()
);

create index if not exists email_leads_email_idx       on public.email_leads (email);
create index if not exists email_leads_created_at_idx  on public.email_leads (created_at desc);

-- 2. Every analysis (free + pro) is logged to build the dataset
create table if not exists public.scans (
  id          bigserial primary key,
  user_id     uuid,                          -- null for anonymous
  url         text,
  title       text,
  score       int,
  verdict     text,
  image_url   text,
  profit_est  text,
  is_public   boolean      default false,
  pro_locked  boolean      default false,
  full_data   jsonb,
  ip_hash     text,
  created_at  timestamptz  default now()
);

create index if not exists scans_user_id_idx     on public.scans (user_id);
create index if not exists scans_created_at_idx  on public.scans (created_at desc);

-- 3. Market observations for live-blend pricing/keyword data
create table if not exists public.market_observations (
  id                  bigserial primary key,
  scan_id             bigint     references public.scans(id) on delete set null,
  category_id         text,
  category_name       text,
  etsy_listings       int,
  etsy_avg_price      numeric,
  search_volume       int,
  created_at          timestamptz default now()
);

create index if not exists market_obs_category_idx   on public.market_observations (category_id, created_at desc);

-- 4. Daily quota tracking (anonymous users by IP, signed-in by user_id)
create table if not exists public.usage_log (
  id          bigserial primary key,
  user_id     uuid,
  ip_hash     text,
  kind        text,                          -- 'scan' | etc.
  created_at  timestamptz default now()
);

create index if not exists usage_log_ip_hash_idx  on public.usage_log (ip_hash, created_at desc);
create index if not exists usage_log_user_id_idx  on public.usage_log (user_id, created_at desc);

-- ────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- The API uses the service-role key (server-side) which bypasses RLS, so RLS
-- on these tables can stay strict. Anonymous clients should not be able to
-- read or write any of these directly.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.email_leads          enable row level security;
alter table public.scans                enable row level security;
alter table public.market_observations  enable row level security;
alter table public.usage_log            enable row level security;

-- No policies on email_leads / market_observations / usage_log — service role only.

-- Allow signed-in users to read their own scans (used by /api/account/ideas).
create policy if not exists "scans owner select" on public.scans
  for select using (auth.uid() = user_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Quick health checks
-- Run these to verify the API is writing what it should:
--
--   select count(*) from public.email_leads;
--   select count(*) from public.scans;
--   select count(*) from public.market_observations;
--
-- After the first successful gate submission, email_leads.count should grow
-- by 1. After the first analysis, scans.count grows by 1.
-- ────────────────────────────────────────────────────────────────────────────
