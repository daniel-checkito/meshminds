-- PrintChecker - Supabase database setup
-- Run this in your Supabase SQL editor (project > SQL Editor > New query)

-- ── profiles table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  free_scans_used INTEGER NOT NULL DEFAULT 0,
  is_premium BOOLEAN NOT NULL DEFAULT FALSE,
  premium_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── scans table ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  score INTEGER,
  verdict TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS scans_user_id_idx ON scans(user_id, created_at DESC);

-- ── Row Level Security ───────────────────────────────────────────────────────
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE scans ENABLE ROW LEVEL SECURITY;

-- profiles policies
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='profiles_select_own' AND tablename='profiles') THEN
    CREATE POLICY "profiles_select_own" ON profiles FOR SELECT USING (auth.uid() = id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='profiles_update_own' AND tablename='profiles') THEN
    CREATE POLICY "profiles_update_own" ON profiles FOR UPDATE USING (auth.uid() = id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='profiles_insert_own' AND tablename='profiles') THEN
    CREATE POLICY "profiles_insert_own" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
  END IF;
END $$;

-- scans policies
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='scans_select_own' AND tablename='scans') THEN
    CREATE POLICY "scans_select_own" ON scans FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='scans_insert_own' AND tablename='scans') THEN
    CREATE POLICY "scans_insert_own" ON scans FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- ── Auto-create profile on sign-up ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id)
  VALUES (NEW.id)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── Extra columns ────────────────────────────────────────────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS default_public BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE scans
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS profit_est TEXT,
  ADD COLUMN IF NOT EXISTS full_data JSONB,
  ADD COLUMN IF NOT EXISTS feedback_rating SMALLINT,    -- -1 / 0 / 1
  ADD COLUMN IF NOT EXISTS feedback_comment TEXT,
  ADD COLUMN IF NOT EXISTS feedback_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ip_hash TEXT,                -- tags anonymous scans
  ADD COLUMN IF NOT EXISTS pro_locked BOOLEAN NOT NULL DEFAULT FALSE;  -- scans saved while user was Pro stay private forever

-- Allow anonymous scans (user_id NULL) — service role inserts these from analyze.js
ALTER TABLE scans ALTER COLUMN user_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS scans_ip_hash_idx ON scans(ip_hash, created_at DESC) WHERE user_id IS NULL;

-- ── email_leads (idea-page captures and save-results form) ─────────────────
CREATE TABLE IF NOT EXISTS email_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  url TEXT,
  score INTEGER,
  verdict TEXT,
  consent BOOLEAN,
  source TEXT,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_leads_email_idx ON email_leads(email);
CREATE INDEX IF NOT EXISTS email_leads_created_idx ON email_leads(created_at DESC);
ALTER TABLE email_leads ENABLE ROW LEVEL SECURITY;
-- No public policies: only the service role inserts/reads from server.

-- ── market_observations (self-improving market data) ───────────────────────
-- Every successful scan logs the AI/scraped numbers for the matched category.
-- A periodic promotion script aggregates this into data/market-data.json.
CREATE TABLE IF NOT EXISTS market_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id UUID REFERENCES scans(id) ON DELETE CASCADE,
  category_id TEXT,                          -- matched id from market-data.json, or null
  category_name TEXT,                        -- snapshot of name at observation time
  etsy_listings INT,                         -- count from scrape or AI estimate
  etsy_avg_price NUMERIC(10,2),              -- € average from scrape or AI
  search_volume INT,                         -- monthly estimate from AI
  match_confidence NUMERIC(3,2),             -- 1.00 explicit seller cat, 0.50 keyword match
  source_query TEXT,                         -- the keywords used for the scrape
  product_title TEXT,                        -- helps when reviewing uncategorized
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS market_obs_category_idx ON market_observations(category_id, created_at DESC);
CREATE INDEX IF NOT EXISTS market_obs_uncategorized_idx ON market_observations(created_at DESC) WHERE category_id IS NULL;
ALTER TABLE market_observations ENABLE ROW LEVEL SECURITY;
-- No public policies: service role only.

-- ── events (analytics & funnel tracking) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uid TEXT,                                      -- session id (random per visitor, in localStorage)
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  scan_id UUID REFERENCES scans(id) ON DELETE SET NULL,
  page TEXT,                                     -- /idea, /index, /members, etc.
  variant TEXT,
  action TEXT NOT NULL,                          -- e.g. page_view, analyze_start, email_submit, cta_click_pro
  label TEXT,                                    -- optional secondary detail (button name, mode, etc.)
  value INTEGER,                                 -- optional numeric (score, step, etc.)
  meta JSONB,                                    -- arbitrary extra fields
  referrer TEXT,
  user_agent TEXT,
  device TEXT,                                   -- mobile / tablet / desktop
  screen_width INT,
  country TEXT,
  city TEXT,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS events_created_idx ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS events_action_idx ON events(action, created_at DESC);
CREATE INDEX IF NOT EXISTS events_uid_idx ON events(uid, created_at DESC) WHERE uid IS NOT NULL;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='events_anon_insert' AND tablename='events') THEN
    CREATE POLICY events_anon_insert ON events FOR INSERT TO anon WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='events_authed_insert' AND tablename='events') THEN
    CREATE POLICY events_authed_insert ON events FOR INSERT TO authenticated WITH CHECK (true);
  END IF;
END $$;
-- No SELECT policy: only the dashboard RPC reads events.

-- Admin email allow-list — change here to grant/revoke dashboard access
CREATE OR REPLACE FUNCTION is_meshminds_admin() RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN (auth.jwt() ->> 'email') IN (
    'info.meshminds@gmail.com',
    'daniel.haag@check24.de'
  );
END; $$;

-- Dashboard aggregate query — single round-trip for everything the admin UI needs
CREATE OR REPLACE FUNCTION get_dashboard_stats(window_days INT DEFAULT 30)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result JSONB;
  since TIMESTAMPTZ;
BEGIN
  IF NOT is_meshminds_admin() THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  since := NOW() - (window_days || ' days')::interval;

  SELECT jsonb_build_object(
    'window_days', window_days,
    'since', since,
    'totals', jsonb_build_object(
      'total_events', (SELECT COUNT(*) FROM events WHERE created_at >= since),
      'unique_visitors', (SELECT COUNT(DISTINCT uid) FROM events WHERE created_at >= since AND uid IS NOT NULL),
      'page_views', (SELECT COUNT(*) FROM events WHERE action='page_view' AND created_at >= since),
      'scans_started', (SELECT COUNT(*) FROM events WHERE action='analyze_start' AND created_at >= since),
      'scans_completed', (SELECT COUNT(*) FROM scans WHERE created_at >= since),
      'scans_aborted', (SELECT COUNT(*) FROM events WHERE action='analyze_abort' AND created_at >= since),
      'emails_collected', (SELECT COUNT(*) FROM email_leads WHERE created_at >= since),
      'emails_with_consent', (SELECT COUNT(*) FROM email_leads WHERE consent = true AND created_at >= since),
      'pro_clicks', (SELECT COUNT(*) FROM events WHERE action='cta_click_pro' AND created_at >= since),
      'feedback_submitted', (SELECT COUNT(*) FROM events WHERE action='feedback_submit' AND created_at >= since),
      'signups', (SELECT COUNT(*) FROM auth.users WHERE created_at >= since)
    ),
    'funnel', jsonb_build_object(
      'visitors',          (SELECT COUNT(DISTINCT uid) FROM events WHERE action='page_view'      AND page LIKE '%idea%' AND created_at >= since AND uid IS NOT NULL),
      'mode_selected',     (SELECT COUNT(DISTINCT uid) FROM events WHERE action='mode_select'     AND created_at >= since AND uid IS NOT NULL),
      'analyze_started',   (SELECT COUNT(DISTINCT uid) FROM events WHERE action='analyze_start'   AND created_at >= since AND uid IS NOT NULL),
      'analyze_completed', (SELECT COUNT(DISTINCT uid) FROM events WHERE action='analyze_success' AND created_at >= since AND uid IS NOT NULL),
      'email_submitted',   (SELECT COUNT(DISTINCT uid) FROM events WHERE action='email_submit'    AND created_at >= since AND uid IS NOT NULL),
      'pro_clicked',       (SELECT COUNT(DISTINCT uid) FROM events WHERE action='cta_click_pro'   AND created_at >= since AND uid IS NOT NULL)
    ),
    'daily', (
      SELECT jsonb_agg(d ORDER BY d->>'date' DESC)
      FROM (
        SELECT jsonb_build_object(
          'date', g::date,
          'visitors',   (SELECT COUNT(DISTINCT uid) FROM events  WHERE created_at::date = g::date AND uid IS NOT NULL),
          'scans',      (SELECT COUNT(*)            FROM scans   WHERE created_at::date = g::date),
          'emails',     (SELECT COUNT(*)            FROM email_leads WHERE created_at::date = g::date),
          'pro_clicks', (SELECT COUNT(*)            FROM events  WHERE action='cta_click_pro' AND created_at::date = g::date)
        ) AS d
        FROM generate_series(since::date, NOW()::date, '1 day') g
      ) sub
    ),
    'top_actions', (
      SELECT jsonb_agg(jsonb_build_object('action', action, 'label', COALESCE(label,''), 'count', cnt))
      FROM (
        SELECT action, label, COUNT(*) AS cnt
        FROM events WHERE created_at >= since
        GROUP BY action, label ORDER BY cnt DESC LIMIT 30
      ) t
    ),
    'countries', (
      SELECT jsonb_agg(jsonb_build_object('country', country, 'count', cnt))
      FROM (
        SELECT country, COUNT(DISTINCT uid) AS cnt
        FROM events WHERE created_at >= since AND country IS NOT NULL AND country <> ''
        GROUP BY country ORDER BY cnt DESC LIMIT 10
      ) t
    ),
    'recent_emails', (
      SELECT jsonb_agg(jsonb_build_object('email', email, 'consent', consent, 'created_at', created_at))
      FROM (
        SELECT email, consent, created_at FROM email_leads
        WHERE created_at >= since ORDER BY created_at DESC LIMIT 20
      ) t
    ),
    'top_scans', (
      SELECT jsonb_agg(jsonb_build_object('title', title, 'score', score, 'verdict', verdict, 'created_at', created_at))
      FROM (
        SELECT title, score, verdict, created_at FROM scans
        WHERE created_at >= since AND title IS NOT NULL AND score IS NOT NULL
        ORDER BY score DESC, created_at DESC LIMIT 20
      ) t
    ),
    'aborts_by_step', (
      SELECT jsonb_agg(jsonb_build_object('step', COALESCE(label,'(unspecified)'), 'count', cnt))
      FROM (
        SELECT label, COUNT(*) AS cnt FROM events
        WHERE action='analyze_abort' AND created_at >= since
        GROUP BY label ORDER BY cnt DESC LIMIT 10
      ) t
    )
  ) INTO result;
  RETURN result;
END; $$;

GRANT EXECUTE ON FUNCTION get_dashboard_stats(INT) TO authenticated;

-- ── usage_log (per-day rate limiting) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS usage_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  ip_hash TEXT,
  kind TEXT NOT NULL DEFAULT 'scan',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS usage_log_user_idx ON usage_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_log_ip_idx ON usage_log(ip_hash, created_at DESC);
ALTER TABLE usage_log ENABLE ROW LEVEL SECURITY;
-- No public policies: only the service role (server-side) reads/writes this table.

-- Public scans policy
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='scans_select_public' AND tablename='scans') THEN
    CREATE POLICY "scans_select_public" ON scans FOR SELECT USING (is_public = true);
  END IF;
END $$;
