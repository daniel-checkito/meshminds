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
