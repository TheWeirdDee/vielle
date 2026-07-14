-- Agent liveness — separate from veille_agent_log, which is meant to stay a
-- readable history of actual events (reconnects, fires, failures), not a
-- heartbeat firehose. Run in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS veille_agent_heartbeat (
  agent TEXT PRIMARY KEY,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One-time cleanup: remove the heartbeat rows already written into
-- veille_agent_log by the earlier (mistaken) approach.
DELETE FROM veille_agent_log WHERE event_type = 'heartbeat';
