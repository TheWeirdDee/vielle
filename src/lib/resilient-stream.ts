/**
 * Wraps lib/txline's connectStreams() with the resilience behavior
 * VEILLE_PRD.md section 5 requires that the shared stream layer doesn't
 * provide on its own:
 *
 *  - Persists a lightweight MatchState + last-trigger snapshot to
 *    veille_match_state after every event, so a full SCOUT process restart
 *    (not just an SSE reconnect) can reseed in-memory detector state.
 *  - On SSE reconnect, re-fetches each tracked match's scores snapshot and
 *    replays any events newer than the last one we saw, tagged
 *    recoveredFromSnapshot — closing the gap an SSE drop leaves behind.
 *  - Flags abandoned ('A') and postponed ('P') phase changes for the caller.
 */

import { connectStreams } from './txline/stream'
import { getScoresSnapshot } from './txline/snapshots'
import { getSupabase } from './supabase'
import { log } from './resilience'
import type { EventType, MatchEvent, MatchState, OddsEvent } from './txline/types'

export interface ResilientStreamCallbacks {
  onMatchEvent: (event: MatchEvent, state: MatchState, recoveredFromSnapshot: boolean) => void
  onOddsEvent: (event: OddsEvent) => void
  onMatchAbandoned: (matchId: string, state: MatchState) => void
  onMatchPostponed: (matchId: string, state: MatchState) => void
}

interface TrackedMatch {
  lastSeenTs: number
  lastTrigger: { type: EventType; team: 'home' | 'away'; ts: number; minute: number } | null
}

async function persistMatchState(
  state: MatchState,
  lastTrigger: TrackedMatch['lastTrigger']
): Promise<void> {
  const res = await getSupabase()
    .from('veille_match_state')
    .upsert({
      match_id: state.matchId,
      home_team: state.homeTeam,
      away_team: state.awayTeam,
      phase: state.phase,
      home_score: state.homeScore,
      away_score: state.awayScore,
      minute: state.minute,
      last_event_type: lastTrigger?.type ?? null,
      last_event_minute: lastTrigger?.minute ?? null,
      last_updated: new Date(state.lastUpdated || Date.now()).toISOString(),
    })
  if (res.error) console.error('[resilient-stream] persist match_state failed:', res.error.message)
}

/** Load previously persisted trigger context for a match (process-restart recovery). */
export async function loadPersistedTrigger(
  matchId: string
): Promise<TrackedMatch['lastTrigger'] | null> {
  const res = await getSupabase()
    .from('veille_match_state')
    .select('last_event_type, last_event_minute, last_updated')
    .eq('match_id', matchId)
    .maybeSingle()
  if (res.error || !res.data?.last_event_type) return null
  const row = res.data as { last_event_type: EventType; last_event_minute: number; last_updated: string }
  return {
    type: row.last_event_type,
    team: 'home', // team side isn't persisted; conservative fallback, re-verified on the next live trigger
    ts: new Date(row.last_updated).getTime(),
    minute: row.last_event_minute,
  }
}

/**
 * Connect both TxLINE streams with snapshot-recovery-on-reconnect layered on
 * top. Returns a disconnect function, matching connectStreams()'s shape.
 */
export function connectResilientStreams(callbacks: ResilientStreamCallbacks): () => void {
  const tracked = new Map<string, TrackedMatch>()

  const recoverMatch = async (matchId: string): Promise<void> => {
    const prior = tracked.get(matchId)
    if (!prior) return
    try {
      const snapshot = await getScoresSnapshot(matchId)
      const missed = snapshot.events.filter((e) => e.timestamp > prior.lastSeenTs)
      if (missed.length > 0) {
        await log('scout', 'snapshot_recovery', { match_id: matchId, recovered_count: missed.length })
        for (const event of missed) {
          callbacks.onMatchEvent(event, snapshot.state, true)
          prior.lastSeenTs = Math.max(prior.lastSeenTs, event.timestamp)
        }
      }
    } catch (error) {
      console.error(`[resilient-stream] recovery failed for ${matchId}:`, error)
    }
  }

  const disconnect = connectStreams({
    onMatchEvent: (event, state) => {
      let t = tracked.get(event.matchId)
      if (!t) {
        t = { lastSeenTs: 0, lastTrigger: null }
        tracked.set(event.matchId, t)
      }
      t.lastSeenTs = Math.max(t.lastSeenTs, event.timestamp)
      if ((event.type === 'goal' || event.type === 'red_card') && event.team) {
        t.lastTrigger = { type: event.type, team: event.team, ts: event.timestamp, minute: event.minute }
      }
      void persistMatchState(state, t.lastTrigger)

      if (event.type === 'phase_change') {
        const phase = event.data.phase
        if (phase === 'A') callbacks.onMatchAbandoned(event.matchId, state)
        if (phase === 'P') callbacks.onMatchPostponed(event.matchId, state)
      }

      callbacks.onMatchEvent(event, state, false)
    },
    onOddsEvent: (event) => callbacks.onOddsEvent(event),
    onError: (err) => {
      void log('scout', 'reconnect', { error: err.message }, 'warning')
    },
    onReconnect: () => {
      void log('scout', 'reconnect', { status: 'reconnected' })
      for (const matchId of tracked.keys()) void recoverMatch(matchId)
    },
  })

  return disconnect
}
