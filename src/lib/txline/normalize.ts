/**
 * Normalizers: raw TxLINE payloads → shared types.
 *
 * Used by snapshots.ts (REST), stream.ts (live SSE), and replay.ts alike,
 * so all three produce byte-identical event shapes.
 */

import type {
  Chain,
  EventType,
  Fixture,
  GamePhase,
  MatchEvent,
  MatchState,
  OddsEvent,
  TxLineFixtureRecord,
  TxLineOddsRecord,
  TxLineScorePeriod,
  TxLineScoresRecord,
} from './types'

// ---------------------------------------------------------------------------
// Game phase / status encoding
// ---------------------------------------------------------------------------

const STATUS_TO_PHASE: Record<number, GamePhase> = {
  1: 'NS',
  2: 'H1',
  3: 'HT',
  4: 'H2',
  5: 'F',
  6: 'WET',
  7: 'ET1',
  8: 'HTET',
  9: 'ET2',
  10: 'FET',
  11: 'WPE',
  12: 'PE',
  13: 'FPE',
  14: 'I',
  15: 'A',
  16: 'C',
  17: 'TXCC',
  18: 'TXCS',
  19: 'P',
}

/** Map a TxLINE StatusId to a GamePhase; finalisation records (100) map to null. */
export function statusToPhase(statusId: number | undefined | null): GamePhase | null {
  if (statusId == null) return null
  return STATUS_TO_PHASE[statusId] ?? null
}

// ---------------------------------------------------------------------------
// Scores → MatchEvent
// ---------------------------------------------------------------------------

/** TxLINE actions that map onto the shared EventType vocabulary. */
const ACTION_TO_EVENT_TYPE: Record<string, EventType> = {
  goal: 'goal',
  red_card: 'red_card',
  yellow_card: 'yellow_card',
  corner: 'corner',
  status: 'phase_change',
  substitution: 'substitution',
  var: 'var',
  var_end: 'var_end',
  shot: 'shot',
  free_kick: 'free_kick',
  penalty: 'penalty',
}

function participantToChain(
  participant: number | null | undefined,
  participant1IsHome: boolean
): Chain | null {
  if (participant !== 1 && participant !== 2) return null
  const isParticipant1 = participant === 1
  return isParticipant1 === participant1IsHome ? 'home' : 'away'
}

/** Football-convention minute from a cumulative match clock (5555s → 93'). */
function clockToMinute(clock: TxLineScoresRecord['Clock']): number {
  if (!clock || typeof clock.Seconds !== 'number') return 0
  return Math.floor(clock.Seconds / 60) + 1
}

/**
 * A scored penalty never gets a `goal` action record — the goal arrives as
 * `penalty_outcome` with Outcome "Scored" and the incremented Score block.
 * Map it to a goal event; the counter-backed dedupe in ScoresNormalizer
 * gates emission on the Goals total actually moving, so the enrichment
 * burst (bare → +player) and shootout records stay silent.
 */
function eventTypeForRecord(record: TxLineScoresRecord): EventType | null {
  if (record.Action === 'penalty_outcome') {
    const outcome = (record.Data as { Outcome?: string } | null | undefined)?.Outcome
    return outcome === 'Scored' ? 'goal' : null
  }
  return ACTION_TO_EVENT_TYPE[record.Action] ?? null
}

/**
 * Normalize one raw scores record. Returns null for actions outside the shared
 * event vocabulary (possession updates, lineups, connection chatter, ...).
 */
export function normalizeScoresRecord(
  record: TxLineScoresRecord,
  participant1IsHome: boolean = record.Participant1IsHome ?? true
): MatchEvent | null {
  const type = eventTypeForRecord(record)
  if (!type) return null

  const data: Record<string, unknown> = {
    seq: record.Seq,
    statusId: record.StatusId,
    ...(record.Data ?? {}),
  }
  if (type === 'phase_change') {
    const rawStatus = (record.Data as { StatusId?: number } | null | undefined)?.StatusId
    data.phase = statusToPhase(rawStatus ?? record.StatusId)
  }

  return {
    type,
    matchId: String(record.FixtureId),
    timestamp: record.Ts,
    team: participantToChain(record.Participant, participant1IsHome),
    minute: clockToMinute(record.Clock),
    data,
    raw: record,
  }
}

// ---------------------------------------------------------------------------
// Scores → MatchEvent, deduplicated (stateful)
// ---------------------------------------------------------------------------

interface TeamCounters {
  goals: number
  corners: number
  yellowCards: number
  redCards: number
}
interface MatchCounters {
  home: TeamCounters
  away: TeamCounters
}

/** Event types whose truth is a cumulative counter in the Score block. */
const COUNTER_EVENTS: Partial<Record<EventType, keyof TeamCounters>> = {
  goal: 'goals',
  corner: 'corners',
  yellow_card: 'yellowCards',
  red_card: 'redCards',
}

function extractCounters(
  record: TxLineScoresRecord,
  participant1IsHome: boolean
): MatchCounters | null {
  const p1 = record.Score?.Participant1?.Total
  const p2 = record.Score?.Participant2?.Total
  if (!p1 && !p2) return null
  const toCounters = (t: TxLineScorePeriod | undefined): TeamCounters => ({
    goals: t?.Goals ?? 0,
    corners: t?.Corners ?? 0,
    yellowCards: t?.YellowCards ?? 0,
    redCards: t?.RedCards ?? 0,
  })
  const [home, away] = participant1IsHome ? [p1, p2] : [p2, p1]
  return { home: toCounters(home), away: toCounters(away) }
}

/**
 * Stateful scores normalizer.
 *
 * The raw feed sends each goal/card/corner as a burst of records with
 * consecutive seqs (bare → +type → +player), and may send records for
 * incidents that are later disallowed. This class emits counter-backed events
 * (goal, corner, yellow_card, red_card) only when the team's cumulative total
 * in the Score block actually increments, so consumers see exactly one event
 * per real incident. All other event types pass through unchanged.
 *
 * Use one instance per stream/replay/history pass. Seed it from a
 * ScoresSnapshot state when attaching mid-match, otherwise the first record
 * of each match becomes the baseline and is not emitted.
 */
export class ScoresNormalizer {
  private counters = new Map<string, MatchCounters>()

  /** Baseline the counters from an existing MatchState (mid-match attach). */
  seedFromState(state: MatchState): void {
    this.counters.set(state.matchId, {
      home: {
        goals: state.homeScore,
        corners: state.corners.home,
        yellowCards: state.yellowCards.home,
        redCards: state.redCards.home,
      },
      away: {
        goals: state.awayScore,
        corners: state.corners.away,
        yellowCards: state.yellowCards.away,
        redCards: state.redCards.away,
      },
    })
  }

  normalize(
    record: TxLineScoresRecord,
    participant1IsHome: boolean = record.Participant1IsHome ?? true
  ): MatchEvent | null {
    const event = normalizeScoresRecord(record, participant1IsHome)
    const matchId = String(record.FixtureId)
    const nextCounters = extractCounters(record, participant1IsHome)
    const prevCounters = this.counters.get(matchId)
    if (nextCounters) this.counters.set(matchId, nextCounters)

    if (!event) return null
    const counterKey = COUNTER_EVENTS[event.type]
    if (!counterKey) return event

    // Counter-backed event: only real if the cumulative total moved up.
    if (!prevCounters) return null // first sighting = baseline, provenance unknown
    if (!nextCounters) return event // no Score block — cannot verify, fail open
    if (!event.team) return null
    return nextCounters[event.team][counterKey] > prevCounters[event.team][counterKey]
      ? event
      : null
  }

  reset(): void {
    this.counters.clear()
  }
}

// ---------------------------------------------------------------------------
// Scores → MatchState
// ---------------------------------------------------------------------------

function periodTotal(period: TxLineScorePeriod | undefined, key: keyof TxLineScorePeriod): number {
  return period?.[key] ?? 0
}

/** Pre-kickoff MatchState: 0-0, phase NS. */
export function zeroMatchState(matchId: string, homeTeam: string, awayTeam: string): MatchState {
  return {
    matchId,
    homeTeam,
    awayTeam,
    homeScore: 0,
    awayScore: 0,
    phase: 'NS',
    minute: 0,
    corners: { home: 0, away: 0 },
    yellowCards: { home: 0, away: 0 },
    redCards: { home: 0, away: 0 },
    lastUpdated: 0,
  }
}

/**
 * Build a MatchState from the highest-seq scores record of a match.
 * Team names come from the fixture (scores records only carry participant ids).
 */
export function buildMatchState(
  records: TxLineScoresRecord[],
  fixture: { homeTeam: string; awayTeam: string; participant1IsHome: boolean }
): MatchState {
  const sorted = [...records].sort((a, b) => a.Seq - b.Seq)
  const latest = sorted[sorted.length - 1]
  const matchId = latest ? String(latest.FixtureId) : ''

  // Phase: latest explicit status action wins; finalisation records (100) don't
  // carry a phase, so fall back through earlier records.
  let phase: GamePhase = 'NS'
  for (let i = sorted.length - 1; i >= 0; i--) {
    const rec = sorted[i]
    const candidate =
      rec.Action === 'status'
        ? statusToPhase((rec.Data as { StatusId?: number } | null | undefined)?.StatusId ?? rec.StatusId)
        : statusToPhase(rec.StatusId)
    if (candidate) {
      phase = candidate
      break
    }
  }

  // Latest record with a Score block carries the cumulative totals.
  let score: TxLineScoresRecord['Score']
  let clock: TxLineScoresRecord['Clock']
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (!score && sorted[i].Score) score = sorted[i].Score
    if (!clock && sorted[i].Clock) clock = sorted[i].Clock
    if (score && clock) break
  }

  const p1 = score?.Participant1?.Total
  const p2 = score?.Participant2?.Total
  const [homeTotals, awayTotals] = fixture.participant1IsHome ? [p1, p2] : [p2, p1]

  return {
    matchId,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    homeScore: periodTotal(homeTotals, 'Goals'),
    awayScore: periodTotal(awayTotals, 'Goals'),
    phase,
    minute: clockToMinute(clock),
    corners: {
      home: periodTotal(homeTotals, 'Corners'),
      away: periodTotal(awayTotals, 'Corners'),
    },
    yellowCards: {
      home: periodTotal(homeTotals, 'YellowCards'),
      away: periodTotal(awayTotals, 'YellowCards'),
    },
    redCards: {
      home: periodTotal(homeTotals, 'RedCards'),
      away: periodTotal(awayTotals, 'RedCards'),
    },
    lastUpdated: latest?.Ts ?? 0,
  }
}

/** Incrementally apply one raw scores record to an existing MatchState. */
export function applyRecordToState(state: MatchState, record: TxLineScoresRecord): MatchState {
  const next: MatchState = {
    ...state,
    corners: { ...state.corners },
    yellowCards: { ...state.yellowCards },
    redCards: { ...state.redCards },
    lastUpdated: record.Ts,
  }

  if (record.Clock) next.minute = clockToMinute(record.Clock)

  const phase =
    record.Action === 'status'
      ? statusToPhase((record.Data as { StatusId?: number } | null | undefined)?.StatusId ?? record.StatusId)
      : statusToPhase(record.StatusId)
  if (phase) next.phase = phase

  // Cumulative totals in the record beat incremental bookkeeping when present.
  const p1IsHome = record.Participant1IsHome ?? true
  const p1 = record.Score?.Participant1?.Total
  const p2 = record.Score?.Participant2?.Total
  if (p1 || p2) {
    const [homeTotals, awayTotals] = p1IsHome ? [p1, p2] : [p2, p1]
    next.homeScore = periodTotal(homeTotals, 'Goals')
    next.awayScore = periodTotal(awayTotals, 'Goals')
    next.corners = {
      home: periodTotal(homeTotals, 'Corners'),
      away: periodTotal(awayTotals, 'Corners'),
    }
    next.yellowCards = {
      home: periodTotal(homeTotals, 'YellowCards'),
      away: periodTotal(awayTotals, 'YellowCards'),
    }
    next.redCards = {
      home: periodTotal(homeTotals, 'RedCards'),
      away: periodTotal(awayTotals, 'RedCards'),
    }
    return next
  }

  // No Score block: fall back to incrementing from the event itself.
  const team = participantToChain(record.Participant, p1IsHome)
  if (team) {
    if (record.Action === 'goal') next[team === 'home' ? 'homeScore' : 'awayScore'] += 1
    if (record.Action === 'corner') next.corners[team] += 1
    if (record.Action === 'yellow_card') next.yellowCards[team] += 1
    if (record.Action === 'red_card') next.redCards[team] += 1
  }
  return next
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export function normalizeFixture(record: TxLineFixtureRecord): Fixture {
  const p1IsHome = record.Participant1IsHome
  const started = Number(record.StartTime) < Date.now()
  return {
    matchId: String(record.FixtureId),
    homeTeam: p1IsHome ? record.Participant1 : record.Participant2,
    awayTeam: p1IsHome ? record.Participant2 : record.Participant1,
    league: record.CompetitionId === 72 ? 'World Cup' : `competition:${record.CompetitionId}`,
    kickoff: Number(record.StartTime),
    phase: record.GameState === 6 ? 'C' : started ? 'F' : 'NS',
    homeScore: null,
    awayScore: null,
    raw: record,
  }
}

// ---------------------------------------------------------------------------
// Odds → OddsEvent
// ---------------------------------------------------------------------------

/** Stable market identifier, e.g. "1X2_PARTICIPANT_RESULT" or "1X2_PARTICIPANT_RESULT|half=1". */
export function marketKey(record: TxLineOddsRecord): string {
  const parts = [record.SuperOddsType]
  if (record.MarketPeriod) parts.push(record.MarketPeriod)
  if (record.MarketParameters) parts.push(record.MarketParameters)
  return parts.join('|')
}

/** The canonical full-match win market. */
export const MATCH_WINNER_MARKET = '1X2_PARTICIPANT_RESULT'

interface ParsedProbs {
  homeProb: number
  awayProb: number
  drawProb: number
}

/**
 * Extract 0–1 probabilities from a participant-result record.
 * Only records with part1/part2 outcome labels qualify (1X2, Asian handicap);
 * over/under style markets have no home/away semantics and return null.
 */
function extractProbs(record: TxLineOddsRecord, participant1IsHome: boolean): ParsedProbs | null {
  const i1 = record.PriceNames.indexOf('part1')
  const i2 = record.PriceNames.indexOf('part2')
  const iDraw = record.PriceNames.indexOf('draw')
  if (i1 < 0 || i2 < 0) return null

  const probAt = (idx: number): number | null => {
    if (idx < 0) return null
    const pct = record.Pct?.[idx]
    if (pct && pct !== 'NA') {
      const parsed = Number(pct)
      if (Number.isFinite(parsed)) return parsed / 100
    }
    const price = record.Prices[idx]
    if (typeof price === 'number' && price > 0) return 1 / (price / 1000)
    return null
  }

  const p1 = probAt(i1)
  const p2 = probAt(i2)
  if (p1 === null || p2 === null) return null
  const draw = probAt(iDraw) ?? 0

  const [homeProb, awayProb] = participant1IsHome ? [p1, p2] : [p2, p1]
  return { homeProb, awayProb, drawProb: draw }
}

/**
 * Stateful odds normalizer: tracks the previous probabilities per
 * (matchId, market) so every OddsEvent carries previous values and deltas.
 * Use one instance per stream/replay/history pass.
 */
export class OddsNormalizer {
  private previous = new Map<string, ParsedProbs>()

  /** Returns null for records without home/away semantics (e.g. over/under). */
  normalize(record: TxLineOddsRecord, participant1IsHome = true): OddsEvent | null {
    const probs = extractProbs(record, participant1IsHome)
    if (!probs) return null

    const market = marketKey(record)
    const stateKey = `${record.FixtureId}|${market}`
    const prev = this.previous.get(stateKey) ?? probs
    this.previous.set(stateKey, probs)

    return {
      matchId: String(record.FixtureId),
      timestamp: record.Ts,
      market,
      homeProb: probs.homeProb,
      awayProb: probs.awayProb,
      drawProb: probs.drawProb,
      previousHomeProb: prev.homeProb,
      previousAwayProb: prev.awayProb,
      previousDrawProb: prev.drawProb,
      deltaHome: probs.homeProb - prev.homeProb,
      deltaAway: probs.awayProb - prev.awayProb,
      deltaDraw: probs.drawProb - prev.drawProb,
      raw: record,
    }
  }

  reset(): void {
    this.previous.clear()
  }
}
