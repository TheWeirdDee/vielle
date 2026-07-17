-- VEILLE schema extension — run in the Supabase SQL editor.
--
-- This ALTERs the tables created by txline-core's supabase/veille.sql
-- (Phase 0 shared infra). It never drops veille_signal_registry or its rows —
-- RED_CARD_SHOCK's registered_at timestamp must stay untouched and permanent.
-- POST_EVENT_PROB_SHOCK is registered as an additional row by
-- scripts/register-signal.ts, not by this file.

-- ---------------------------------------------------------------------------
-- Extend veille_signal_registry
-- ---------------------------------------------------------------------------
ALTER TABLE veille_signal_registry
  ADD COLUMN IF NOT EXISTS cooldown_seconds INTEGER;

-- ---------------------------------------------------------------------------
-- Extend veille_signals for dual-strategy, positions, and on-chain/subscriber
-- tracking. signal_id -> signal_registry_id for clarity against the table's
-- own id.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'veille_signals' AND column_name = 'signal_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'veille_signals' AND column_name = 'signal_registry_id'
  ) THEN
    ALTER TABLE veille_signals RENAME COLUMN signal_id TO signal_registry_id;
  END IF;
END $$;

ALTER TABLE veille_signals
  ADD COLUMN IF NOT EXISTS strategy TEXT NOT NULL DEFAULT 'A',
  ADD COLUMN IF NOT EXISTS position TEXT NOT NULL DEFAULT 'long_home',
  ADD COLUMN IF NOT EXISTS delta DECIMAL(5, 4),
  ADD COLUMN IF NOT EXISTS window_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS recovered_from_snapshot BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS onchain_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS onchain_tx_signature TEXT,
  ADD COLUMN IF NOT EXISTS txline_proof_reference TEXT,
  ADD COLUMN IF NOT EXISTS subscribers_notified INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS subscribers_failed INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT,
  ADD COLUMN IF NOT EXISTS settlement_onchain_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS settlement_onchain_tx_signature TEXT,
  ADD COLUMN IF NOT EXISTS settlement_txline_proof_reference TEXT,
  ADD COLUMN IF NOT EXISTS settlement_subscribers_notified INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS settlement_subscribers_failed INTEGER DEFAULT 0;

ALTER TABLE veille_signals ALTER COLUMN strategy DROP DEFAULT;
ALTER TABLE veille_signals ALTER COLUMN position DROP DEFAULT;

-- ---------------------------------------------------------------------------
-- Portfolio state (rolling, updated by CLERK after each settlement)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS veille_portfolio (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  strategy TEXT NOT NULL UNIQUE,
  total_signals INTEGER DEFAULT 0,
  total_settled INTEGER DEFAULT 0,
  hits INTEGER DEFAULT 0,
  misses INTEGER DEFAULT 0,
  voids INTEGER DEFAULT 0,
  win_rate DECIMAL(5, 4),
  pnl_units DECIMAL(10, 4) DEFAULT 0,
  sharpe_ratio DECIMAL(8, 4),
  max_drawdown DECIMAL(8, 4),
  current_drawdown DECIMAL(8, 4),
  peak_pnl DECIMAL(10, 4) DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Reconnection and error log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS veille_agent_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent TEXT NOT NULL, -- 'scout' | 'clerk'
  event_type TEXT NOT NULL,
  details JSONB,
  severity TEXT DEFAULT 'info', -- 'info' | 'warning' | 'critical'
  logged_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Registered subscribers (B2B webhook layer)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS veille_subscribers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  secret_key TEXT NOT NULL,
  active BOOLEAN DEFAULT true,
  strategies TEXT[] DEFAULT ARRAY['A', 'B'],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_delivery_at TIMESTAMPTZ,
  total_deliveries INTEGER DEFAULT 0,
  failed_deliveries INTEGER DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Match state cache (SCOUT resilience — snapshot recovery on reconnect)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS veille_match_state (
  match_id TEXT PRIMARY KEY,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  phase TEXT NOT NULL,
  home_score INTEGER DEFAULT 0,
  away_score INTEGER DEFAULT 0,
  minute INTEGER DEFAULT 0,
  home_prob DECIMAL(5, 4),
  away_prob DECIMAL(5, 4),
  draw_prob DECIMAL(5, 4),
  last_event_type TEXT,
  last_event_minute INTEGER,
  last_event_team TEXT,
  last_event_ts TIMESTAMPTZ,
  pre_trigger_home_prob DECIMAL(7, 6),
  pre_trigger_away_prob DECIMAL(7, 6),
  pre_trigger_odds_ts TIMESTAMPTZ,
  last_odds_ts TIMESTAMPTZ,
  cooldown_until TIMESTAMPTZ,
  last_seq INTEGER DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Idempotent per-subscriber delivery ledger and receiver replay protection
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS veille_webhook_deliveries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  subscriber_id UUID NOT NULL REFERENCES veille_subscribers(id) ON DELETE CASCADE,
  signal_id UUID NOT NULL REFERENCES veille_signals(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('signal_fired', 'position_settled')),
  delivery_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (subscriber_id, signal_id, event_type)
);

CREATE TABLE IF NOT EXISTS veille_webhook_receipts (
  delivery_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  last_error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION claim_veille_webhook_delivery(
  p_subscriber_id UUID,
  p_signal_id UUID,
  p_event_type TEXT,
  p_delivery_id TEXT
) RETURNS TABLE(claimed BOOLEAN, delivery_status TEXT, attempts INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_row veille_webhook_deliveries%ROWTYPE;
BEGIN
  INSERT INTO veille_webhook_deliveries(subscriber_id, signal_id, event_type, delivery_id, status)
  VALUES (p_subscriber_id, p_signal_id, p_event_type, p_delivery_id, 'pending')
  ON CONFLICT (subscriber_id, signal_id, event_type) DO NOTHING
  RETURNING * INTO current_row;

  IF FOUND THEN
    RETURN QUERY SELECT true, current_row.status, current_row.attempts;
    RETURN;
  END IF;

  SELECT * INTO current_row
  FROM veille_webhook_deliveries
  WHERE subscriber_id = p_subscriber_id AND signal_id = p_signal_id AND event_type = p_event_type
  FOR UPDATE;

  IF current_row.status = 'delivered' THEN
    RETURN QUERY SELECT false, current_row.status, current_row.attempts;
    RETURN;
  END IF;
  IF current_row.status = 'pending' AND current_row.updated_at >= NOW() - INTERVAL '60 seconds' THEN
    RETURN QUERY SELECT false, current_row.status, current_row.attempts;
    RETURN;
  END IF;

  UPDATE veille_webhook_deliveries
  SET status = 'pending', last_error = NULL, updated_at = NOW()
  WHERE id = current_row.id
  RETURNING * INTO current_row;
  RETURN QUERY SELECT true, current_row.status, current_row.attempts;
END;
$$;

CREATE OR REPLACE FUNCTION increment_veille_subscriber_delivery(
  p_subscriber_id UUID,
  p_success BOOLEAN
) RETURNS VOID
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE veille_subscribers
  SET
    total_deliveries = total_deliveries + CASE WHEN p_success THEN 1 ELSE 0 END,
    failed_deliveries = failed_deliveries + CASE WHEN p_success THEN 0 ELSE 1 END,
    last_delivery_at = CASE WHEN p_success THEN NOW() ELSE last_delivery_at END
  WHERE id = p_subscriber_id;
$$;

REVOKE ALL ON FUNCTION increment_veille_subscriber_delivery(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION increment_veille_subscriber_delivery(UUID, BOOLEAN) TO service_role;
REVOKE ALL ON FUNCTION claim_veille_webhook_delivery(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_veille_webhook_delivery(UUID, UUID, TEXT, TEXT) TO service_role;

-- Registered definitions are append-only: parameters cannot be tuned after registration.
CREATE OR REPLACE FUNCTION prevent_veille_signal_registry_mutation() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'veille_signal_registry rows are immutable';
END;
$$;
DROP TRIGGER IF EXISTS veille_signal_registry_immutable ON veille_signal_registry;
CREATE TRIGGER veille_signal_registry_immutable
BEFORE UPDATE OR DELETE ON veille_signal_registry
FOR EACH ROW EXECUTE FUNCTION prevent_veille_signal_registry_mutation();

-- Enforce valid values for all future writes without making this migration
-- fail on any legacy row that still needs cleanup.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'veille_signals_strategy_check') THEN
    ALTER TABLE veille_signals ADD CONSTRAINT veille_signals_strategy_check CHECK (strategy IN ('A', 'B')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'veille_signals_position_check') THEN
    ALTER TABLE veille_signals ADD CONSTRAINT veille_signals_position_check CHECK (position IN ('long_home', 'long_away', 'short_home', 'short_away')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'veille_signals_outcome_check') THEN
    ALTER TABLE veille_signals ADD CONSTRAINT veille_signals_outcome_check CHECK (outcome IS NULL OR outcome IN ('hit', 'miss', 'void')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'veille_signals_window_check') THEN
    ALTER TABLE veille_signals ADD CONSTRAINT veille_signals_window_check CHECK (window_seconds IS NULL OR window_seconds >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'veille_signals_delta_check') THEN
    ALTER TABLE veille_signals ADD CONSTRAINT veille_signals_delta_check CHECK (delta IS NULL OR delta BETWEEN 0 AND 1) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'veille_subscribers_https_check') THEN
    ALTER TABLE veille_subscribers ADD CONSTRAINT veille_subscribers_https_check CHECK (webhook_url ~ '^https://') NOT VALID;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Performance view — strategy-keyed (replaces the Phase 0 signal-keyed view)
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS veille_performance;
CREATE VIEW veille_performance AS
SELECT
  s.strategy,
  COUNT(*) FILTER (WHERE s.outcome IS NOT NULL AND s.outcome != 'void') AS settled,
  COUNT(*) FILTER (WHERE s.outcome = 'hit') AS hits,
  COUNT(*) FILTER (WHERE s.outcome = 'miss') AS misses,
  COUNT(*) FILTER (WHERE s.outcome = 'void') AS voids,
  ROUND(
    COUNT(*) FILTER (WHERE s.outcome = 'hit')::numeric /
    NULLIF(COUNT(*) FILTER (WHERE s.outcome IN ('hit', 'miss')), 0),
    4
  ) AS hit_rate,
  p.pnl_units,
  p.sharpe_ratio,
  p.max_drawdown,
  p.win_rate
FROM veille_signals s
JOIN veille_portfolio p ON p.strategy = s.strategy
GROUP BY s.strategy, p.pnl_units, p.sharpe_ratio, p.max_drawdown, p.win_rate;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_signals_strategy ON veille_signals(strategy);
CREATE INDEX IF NOT EXISTS idx_signals_onchain ON veille_signals(onchain_status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_dedupe ON veille_signals(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_registry_name ON veille_signal_registry(name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriber_name ON veille_subscribers(name);
CREATE INDEX IF NOT EXISTS idx_log_agent ON veille_agent_log(agent, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_match_state ON veille_match_state(match_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending ON veille_webhook_deliveries(status, updated_at);

-- These tables are accessed by trusted server-side service-role clients only.
-- Enabling RLS closes the default anon/authenticated PostgREST surface.
ALTER TABLE veille_signal_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE veille_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE veille_portfolio ENABLE ROW LEVEL SECURITY;
ALTER TABLE veille_agent_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE veille_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE veille_match_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE veille_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE veille_webhook_receipts ENABLE ROW LEVEL SECURITY;
