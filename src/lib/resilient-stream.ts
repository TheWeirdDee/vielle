/** Durable stream recovery around TxLINE's scores and odds SSE feeds. */

import { connectStreams } from './txline/stream'
import { getOddsHistory, getScoresHistory, getScoresSnapshot } from './txline/snapshots'
import { MATCH_WINNER_MARKET } from './txline/normalize'
import { getSupabase } from './supabase'
import { log } from './resilience'
import type { EventType, MatchEvent, MatchState, OddsEvent } from './txline/types'

export interface ResilientStreamCallbacks {
  onMatchEvent: (event: MatchEvent, state: MatchState, recoveredFromSnapshot: boolean) => void
  onOddsEvent: (event: OddsEvent, recoveredFromSnapshot: boolean) => void
  onMatchAbandoned: (matchId: string, state: MatchState) => void
  onMatchPostponed: (matchId: string, state: MatchState) => void
}

interface TriggerState {
  type: EventType
  team: 'home' | 'away'
  ts: number
  minute: number
}

interface OddsState {
  homeProb: number
  awayProb: number
  drawProb: number
  timestamp: number
}

interface TrackedMatch {
  lastScoreTs: number
  lastOddsTs: number
  lastSeq: number
  lastTrigger: TriggerState | null
  lastOdds: OddsState | null
  preTriggerOdds: OddsState | null
  state: MatchState | null
  cooldownUntil: number
  lastPersistedOddsAt: number
}

export interface PersistedMatchSeed {
  matchId: string
  state: MatchState
  lastScoreTs: number
  lastOddsTs: number
  lastSeq: number
  lastTrigger: TriggerState | null
  lastOdds: OddsState | null
  preTriggerOdds: OddsState | null
  cooldownUntil: number
}

const TERMINAL_PHASES = new Set(['F', 'FET', 'FPE', 'A', 'C'])
const RESET_COOLDOWN_PHASES = new Set(['HT', 'F', 'FET', 'FPE'])

function emptyTracked(seed?: PersistedMatchSeed): TrackedMatch {
  return {
    lastScoreTs: seed?.lastScoreTs ?? 0,
    lastOddsTs: seed?.lastOddsTs ?? 0,
    lastSeq: seed?.lastSeq ?? 0,
    lastTrigger: seed?.lastTrigger ?? null,
    lastOdds: seed?.lastOdds ?? null,
    preTriggerOdds: seed?.preTriggerOdds ?? null,
    state: seed?.state ?? null,
    cooldownUntil: seed?.cooldownUntil ?? 0,
    lastPersistedOddsAt: 0,
  }
}

export async function loadPersistedMatches(): Promise<PersistedMatchSeed[]> {
  const res = await getSupabase().from('veille_match_state').select('*')
  if (res.error) throw new Error(`load persisted match state: ${res.error.message}`)
  const seeds: PersistedMatchSeed[] = []
  for (const raw of res.data as Record<string, unknown>[]) {
    const phase = String(raw.phase)
    if (TERMINAL_PHASES.has(phase)) continue
    const matchId = String(raw.match_id)
    const eventTs = raw.last_event_ts ? new Date(String(raw.last_event_ts)).getTime() : 0
    const eventTeam = raw.last_event_team
    const eventType = raw.last_event_type as EventType | null
    const oddsTs = raw.pre_trigger_odds_ts ? new Date(String(raw.pre_trigger_odds_ts)).getTime() : 0
    const lastOddsTs = raw.last_odds_ts ? new Date(String(raw.last_odds_ts)).getTime() : 0
    const preHome = Number(raw.pre_trigger_home_prob)
    const preAway = Number(raw.pre_trigger_away_prob)
    seeds.push({
      matchId,
      state: {
        matchId,
        homeTeam: String(raw.home_team),
        awayTeam: String(raw.away_team),
        phase: phase as MatchState['phase'],
        homeScore: Number(raw.home_score ?? 0),
        awayScore: Number(raw.away_score ?? 0),
        minute: Number(raw.minute ?? 0),
        corners: { home: 0, away: 0 },
        yellowCards: { home: 0, away: 0 },
        redCards: { home: 0, away: 0 },
        lastUpdated: new Date(String(raw.last_updated)).getTime(),
      },
      lastScoreTs: new Date(String(raw.last_updated)).getTime(),
      lastOddsTs: raw.last_odds_ts ? new Date(String(raw.last_odds_ts)).getTime() : 0,
      lastSeq: Number(raw.last_seq ?? 0),
      lastTrigger:
        eventType && (eventTeam === 'home' || eventTeam === 'away') && eventTs > 0
          ? { type: eventType, team: eventTeam, ts: eventTs, minute: Number(raw.last_event_minute ?? 0) }
          : null,
      lastOdds:
        lastOddsTs > 0 && raw.home_prob !== null && raw.away_prob !== null
          ? {
              homeProb: Number(raw.home_prob),
              awayProb: Number(raw.away_prob),
              drawProb: Number(raw.draw_prob ?? Math.max(0, 1 - Number(raw.home_prob) - Number(raw.away_prob))),
              timestamp: lastOddsTs,
            }
          : null,
      preTriggerOdds:
        oddsTs > 0 && Number.isFinite(preHome) && Number.isFinite(preAway)
          ? { homeProb: preHome, awayProb: preAway, drawProb: Math.max(0, 1 - preHome - preAway), timestamp: oddsTs }
          : null,
      cooldownUntil: raw.cooldown_until ? new Date(String(raw.cooldown_until)).getTime() : 0,
    })
  }
  return seeds
}

export async function persistCooldown(matchId: string, cooldownUntil: number): Promise<void> {
  const res = await getSupabase()
    .from('veille_match_state')
    .update({ cooldown_until: new Date(cooldownUntil).toISOString() })
    .eq('match_id', matchId)
  if (res.error) console.error('[resilient-stream] persist cooldown failed:', res.error.message)
}

async function persistMatchState(state: MatchState, tracked: TrackedMatch): Promise<void> {
  const res = await getSupabase().from('veille_match_state').upsert({
    match_id: state.matchId,
    home_team: state.homeTeam,
    away_team: state.awayTeam,
    phase: state.phase,
    home_score: state.homeScore,
    away_score: state.awayScore,
    minute: state.minute,
    home_prob: tracked.lastOdds?.homeProb ?? null,
    away_prob: tracked.lastOdds?.awayProb ?? null,
    draw_prob: tracked.lastOdds?.drawProb ?? null,
    last_odds_ts: tracked.lastOdds ? new Date(tracked.lastOdds.timestamp).toISOString() : null,
    last_event_type: tracked.lastTrigger?.type ?? null,
    last_event_minute: tracked.lastTrigger?.minute ?? null,
    last_event_team: tracked.lastTrigger?.team ?? null,
    last_event_ts: tracked.lastTrigger ? new Date(tracked.lastTrigger.ts).toISOString() : null,
    pre_trigger_home_prob: tracked.preTriggerOdds?.homeProb ?? null,
    pre_trigger_away_prob: tracked.preTriggerOdds?.awayProb ?? null,
    pre_trigger_odds_ts: tracked.preTriggerOdds ? new Date(tracked.preTriggerOdds.timestamp).toISOString() : null,
    cooldown_until: tracked.cooldownUntil > 0 ? new Date(tracked.cooldownUntil).toISOString() : null,
    last_seq: tracked.lastSeq,
    last_updated: new Date(state.lastUpdated || Date.now()).toISOString(),
  })
  if (res.error) console.error('[resilient-stream] persist match_state failed:', res.error.message)
}

export function connectResilientStreams(
  callbacks: ResilientStreamCallbacks,
  seeds: PersistedMatchSeed[] = []
): () => void {
  const tracked = new Map<string, TrackedMatch>(seeds.map((seed) => [seed.matchId, emptyTracked(seed)]))
  const recovering = new Set<string>()

  const tracker = (matchId: string): TrackedMatch => {
    let value = tracked.get(matchId)
    if (!value) {
      value = emptyTracked()
      tracked.set(matchId, value)
    }
    return value
  }

  const handleScore = (event: MatchEvent, state: MatchState, recovered: boolean): void => {
    const t = tracker(event.matchId)
    const seq = Number(event.data.seq ?? 0)
    if (seq > 0 && seq <= t.lastSeq) return
    if (seq > 0) t.lastSeq = seq
    t.lastScoreTs = Math.max(t.lastScoreTs, event.timestamp)
    t.state = state
    if ((event.type === 'goal' || event.type === 'red_card') && event.team) {
      t.lastTrigger = { type: event.type, team: event.team, ts: event.timestamp, minute: event.minute }
      t.preTriggerOdds = t.lastOdds
    }
    if (event.type === 'phase_change') {
      const phase = event.data.phase
      if (typeof phase === 'string' && RESET_COOLDOWN_PHASES.has(phase)) t.cooldownUntil = 0
    }
    void persistMatchState(state, t)

    if (event.type === 'phase_change') {
      const phase = event.data.phase
      if (phase === 'A') callbacks.onMatchAbandoned(event.matchId, state)
      if (phase === 'P') callbacks.onMatchPostponed(event.matchId, state)
    }
    callbacks.onMatchEvent(event, state, recovered)
  }

  const handleOdds = (event: OddsEvent, recovered: boolean): void => {
    const t = tracker(event.matchId)
    if (event.market !== MATCH_WINNER_MARKET) {
      callbacks.onOddsEvent(event, recovered)
      return
    }
    t.lastOddsTs = Math.max(t.lastOddsTs, event.timestamp)
    t.lastOdds = {
      homeProb: event.homeProb,
      awayProb: event.awayProb,
      drawProb: event.drawProb,
      timestamp: event.timestamp,
    }
    if (t.state && event.timestamp - t.lastPersistedOddsAt >= 30_000) {
      t.lastPersistedOddsAt = event.timestamp
      void persistMatchState(t.state, t)
    }
    callbacks.onOddsEvent(event, recovered)
  }

  const recoverMatch = async (matchId: string): Promise<void> => {
    if (recovering.has(matchId)) return
    recovering.add(matchId)
    const prior = tracker(matchId)
    try {
      const [snapshot, scoreEvents, oddsEvents] = await Promise.all([
        getScoresSnapshot(matchId),
        getScoresHistory(matchId),
        getOddsHistory(matchId),
      ])
      const timeline = [
        ...scoreEvents
          .filter((event) => Number(event.data.seq ?? 0) > prior.lastSeq || event.timestamp > prior.lastScoreTs)
          .map((event) => ({ kind: 'score' as const, timestamp: event.timestamp, event })),
        ...oddsEvents
          .filter((event) => event.timestamp > prior.lastOddsTs)
          .map((event) => ({ kind: 'odds' as const, timestamp: event.timestamp, event })),
      ].sort((a, b) => a.timestamp - b.timestamp || (a.kind === 'score' ? -1 : 1))

      if (timeline.length > 0) {
        await log('scout', 'snapshot_recovery', { match_id: matchId, recovered_count: timeline.length })
        for (const item of timeline) {
          if (item.kind === 'score') handleScore(item.event, snapshot.state, true)
          else handleOdds(item.event, true)
        }
      }
    } catch (error) {
      await log('scout', 'snapshot_recovery', { match_id: matchId, error: String(error) }, 'warning')
    } finally {
      recovering.delete(matchId)
    }
  }

  const disconnect = connectStreams({
    onMatchEvent: (event, state) => handleScore(event, state, false),
    onOddsEvent: (event) => handleOdds(event, false),
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
