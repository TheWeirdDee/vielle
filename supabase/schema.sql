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
ALTER TABLE veille_signals RENAME COLUMN signal_id TO signal_registry_id;

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
  ADD COLUMN IF NOT EXISTS subscribers_failed INTEGER DEFAULT 0;

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
  last_seq INTEGER DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT NOW()
);

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
CREATE INDEX IF NOT EXISTS idx_log_agent ON veille_agent_log(agent, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_match_state ON veille_match_state(match_id);
