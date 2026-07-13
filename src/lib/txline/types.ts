/**
 * Shared types for the TxLINE data layer.
 * Every module in lib/txline/ and all product code imports from here.
 */

// ---------------------------------------------------------------------------
// Match phases and event vocabulary
// ---------------------------------------------------------------------------

/**
 * TxLINE game phase codes.
 * NS not started · H1/H2 halves · HT halftime · F fulltime ·
 * WET waiting for extra time · ET1/ET2 extra-time halves · HTET extra-time break ·
 * FET finished after extra time · WPE waiting for penalties · PE penalties in progress ·
 * FPE finished after penalties · I interrupted · A abandoned · C cancelled ·
 * TXCC/TXCS TxODDS coverage cancelled/suspended · P postponed
 */
export type GamePhase =
  | 'NS'
  | 'H1'
  | 'HT'
  | 'H2'
  | 'F'
  | 'WET'
  | 'ET1'
  | 'HTET'
  | 'ET2'
  | 'FET'
  | 'WPE'
  | 'PE'
  | 'FPE'
  | 'I'
  | 'A'
  | 'C'
  | 'TXCC'
  | 'TXCS'
  | 'P'

/** Normalized in-play event types emitted on the scores stream. */
export type EventType =
  | 'goal'
  | 'red_card'
  | 'yellow_card'
  | 'corner'
  | 'phase_change'
  | 'substitution'
  | 'var'
  | 'var_end'
  | 'shot'
  | 'free_kick'
  | 'penalty'

/** Which side of the fixture an event or probability refers to. */
export type Chain = 'home' | 'away'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A scheduled, live, or completed match from GET /api/fixtures. */
export interface Fixture {
  matchId: string
  homeTeam: string
  awayTeam: string
  /** Competition name, e.g. "World Cup". */
  league: string
  /** Kickoff time, unix milliseconds. */
  kickoff: number
  phase: GamePhase
  /** null until the match has started. */
  homeScore: number | null
  /** null until the match has started. */
  awayScore: number | null
  /** Original TxLINE payload, untouched. */
  raw: unknown
}

// ---------------------------------------------------------------------------
// Live match state and events
// ---------------------------------------------------------------------------

/** Rolling per-match state, maintained by the stream/replay engines. */
export interface MatchState {
  matchId: string
  homeTeam: string
  awayTeam: string
  homeScore: number
  awayScore: number
  phase: GamePhase
  minute: number
  corners: { home: number; away: number }
  yellowCards: { home: number; away: number }
  redCards: { home: number; away: number }
  /** Unix milliseconds of the last event applied to this state. */
  lastUpdated: number
}

/** A normalized scores-stream event. */
export interface MatchEvent {
  type: EventType
  matchId: string
  /** Event time, unix milliseconds. */
  timestamp: number
  /** null for events with no team attribution (phase changes, some VAR reviews). */
  team: Chain | null
  /** Match minute the event occurred in (0 when the feed sent no clock). */
  minute: number
  /**
   * Type-specific extras. Always includes `seq` (TxLINE sequence number,
   * required for validation proofs) and `statusId` (game phase encoding).
   */
  data: Record<string, unknown>
  /** Original TxLINE payload, untouched. */
  raw: unknown
}

// ---------------------------------------------------------------------------
// Odds
// ---------------------------------------------------------------------------

/** A normalized odds-stream event. All probabilities are 0–1. */
export interface OddsEvent {
  matchId: string
  /** Event time, unix milliseconds. */
  timestamp: number
  /** Market identifier, e.g. 'match_winner' | '1x2' | 'total_goals'. */
  market: string
  homeProb: number
  awayProb: number
  drawProb: number
  previousHomeProb: number
  previousAwayProb: number
  previousDrawProb: number
  /** homeProb - previousHomeProb */
  deltaHome: number
  /** awayProb - previousAwayProb */
  deltaAway: number
  /** drawProb - previousDrawProb */
  deltaDraw: number
  /** Original TxLINE payload, untouched. */
  raw: unknown
}

/** Latest odds for a single market inside an OddsSnapshot. */
export interface MarketOdds {
  market: string
  homeProb: number
  awayProb: number
  drawProb: number
  /** Unix milliseconds the market was last updated. */
  updatedAt: number
}

/** Current odds across all markets for one match (GET /api/odds snapshot). */
export interface OddsSnapshot {
  matchId: string
  /** Snapshot time, unix milliseconds. */
  timestamp: number
  markets: MarketOdds[]
  /** Original TxLINE payload, untouched. */
  raw: unknown
}

// ---------------------------------------------------------------------------
// Scores snapshot
// ---------------------------------------------------------------------------

/** Current state + event history for one match (GET /api/scores snapshot). */
export interface ScoresSnapshot {
  matchId: string
  state: MatchState
  /** Every event recorded so far, oldest first. */
  events: MatchEvent[]
  /** Original TxLINE payload, untouched. */
  raw: unknown
}

// ---------------------------------------------------------------------------
// Merkle validation proofs
// ---------------------------------------------------------------------------

/** One node of a TxLINE Merkle proof path (hash is exactly 32 bytes). */
export interface ProofNode {
  hash: number[]
  isRightSibling: boolean
}

/** The stat a validation proof attests to. period uses the stat period encoding (100 = finalised). */
export interface ProvenStat {
  key: number
  value: number
  period: number
}

/**
 * Validation proof from GET /api/scores/stat-validation, ready to feed into
 * the on-chain validateStat/validateStatV2 instructions.
 */
export interface MerkleProof {
  matchId: string
  /** Requested TxLINE stat encoding. */
  statKey: number
  /** Score-record sequence number the proof was generated for. */
  seq: number
  /** Timestamp used for daily_scores_roots PDA derivation. */
  ts: number
  statToProve: ProvenStat
  /** 32-byte root of the per-event stat subtree. */
  eventStatRoot: number[]
  summary: {
    fixtureId: number
    updateStats: {
      updateCount: number
      minTimestamp: number
      maxTimestamp: number
    }
    eventStatsSubTreeRoot: number[]
  }
  subTreeProof: ProofNode[]
  mainTreeProof: ProofNode[]
  statProof: ProofNode[]
  /** Original TxLINE payload, untouched. */
  raw: unknown
}

// ---------------------------------------------------------------------------
// Stream interface (shared by live SSE and replay engine)
// ---------------------------------------------------------------------------

/**
 * The single callback surface product code implements.
 * Live streams and the replay engine invoke these identically —
 * consumers cannot (and must not) tell the two apart.
 */
export interface StreamCallbacks {
  onMatchEvent: (event: MatchEvent, state: MatchState) => void
  onOddsEvent: (event: OddsEvent) => void
  onError: (error: Error) => void
  onReconnect: () => void
}

// ---------------------------------------------------------------------------
// Replay engine
// ---------------------------------------------------------------------------

export interface ReplayOptions {
  matchId: string
  /** 1 = real-time, 10 = 10x speed, 0 = instant (all events synchronously). */
  speed: number
  /** Unix milliseconds; defaults to the first event in the timeline. */
  startAt?: number
  /** Unix milliseconds; defaults to the last event in the timeline. */
  endAt?: number
}

/** Handle returned by startReplay(). */
export interface ReplayControls {
  pause: () => void
  resume: () => void
  seek: (timestamp: number) => void
  stop: () => void
  /** Current position in the match timeline, unix milliseconds. */
  getCurrentTime: () => number
  /** Total timeline duration in milliseconds. */
  getDuration: () => number
}

/**
 * One entry in the merged, chronologically sorted replay timeline.
 * Raw records (not normalized events) so the replay engine can drive the
 * exact same normalize + state pipeline as the live stream — including
 * correction records (action_discarded, score_adjustment) that have no
 * normalized event but must still fix MatchState.
 */
export type TimelineEntry =
  | { kind: 'scores'; timestamp: number; record: TxLineScoresRecord }
  | { kind: 'odds'; timestamp: number; record: TxLineOddsRecord }

/** On-disk shape of data/replay-cache/{matchId}.json. */
export interface ReplayCache {
  matchId: string
  /** When this cache file was written, unix milliseconds. */
  fetchedAt: number
  /** Team names + feed orientation, resolved from the fixtures snapshot. */
  orientation: {
    homeTeam: string
    awayTeam: string
    participant1IsHome: boolean
    kickoff: number | null
  }
  /** Full raw scores log, ordered by Seq. */
  scores: TxLineScoresRecord[]
  /** Full raw odds log, ordered by Ts. */
  odds: TxLineOddsRecord[]
}

// ---------------------------------------------------------------------------
// Raw TxLINE payloads (typed views — normalizers consume these)
// ---------------------------------------------------------------------------

/** Raw fixture record from GET /api/fixtures/snapshot. */
export interface TxLineFixtureRecord {
  FixtureId: number
  Participant1: string
  Participant2: string
  Participant1IsHome: boolean
  /** Kickoff, unix milliseconds. */
  StartTime: number
  CompetitionId: number
  SportId?: number
  /** 1 = scheduled, 3 = played/live, 6 = cancelled. */
  GameState?: number
  [key: string]: unknown
}

/** Per-period score block inside a raw scores record. */
export interface TxLineScorePeriod {
  Goals?: number
  YellowCards?: number
  RedCards?: number
  Corners?: number
}

/** Per-participant score inside a raw scores record. */
export interface TxLineParticipantScore {
  H1?: TxLineScorePeriod
  HT?: TxLineScorePeriod
  H2?: TxLineScorePeriod
  ET1?: TxLineScorePeriod
  ET2?: TxLineScorePeriod
  ETTotal?: TxLineScorePeriod
  PE?: TxLineScorePeriod
  Total?: TxLineScorePeriod
}

/** Raw scores record from snapshots, history buckets, and the scores SSE stream. */
export interface TxLineScoresRecord {
  FixtureId: number
  /** Action type, e.g. 'goal' | 'yellow_card' | 'status' | 'game_finalised'. */
  Action: string
  /** Event time, unix milliseconds. */
  Ts: number
  Seq: number
  /** Game phase encoding (1–19, or 100 on finalisation records). */
  StatusId: number
  /** 1 | 2 | null — which participant the action belongs to. */
  Participant?: number | null
  Participant1IsHome?: boolean
  Clock?: { Running: boolean; Seconds: number } | null
  Score?: {
    Participant1?: TxLineParticipantScore
    Participant2?: TxLineParticipantScore
  }
  Data?: Record<string, unknown> | null
  /** statKey → value map for on-chain validation. */
  Stats?: Record<string, number>
  StartTime?: number
  [key: string]: unknown
}

/** Raw odds record from updates buckets, snapshots, and the odds SSE stream. */
export interface TxLineOddsRecord {
  FixtureId: number
  MessageId: string
  /** Update time, unix milliseconds. */
  Ts: number
  Bookmaker: string
  BookmakerId: number
  /** e.g. '1X2_PARTICIPANT_RESULT' | 'OVERUNDER_PARTICIPANT_GOALS'. */
  SuperOddsType: string
  InRunning?: boolean
  /** e.g. 'line=2.5' or null. */
  MarketParameters?: string | null
  /** e.g. 'half=1' or null (null = full match). */
  MarketPeriod?: string | null
  /** Outcome labels aligned with Prices/Pct, e.g. ['part1','draw','part2']. */
  PriceNames: string[]
  /** Decimal odds × 1000, aligned with PriceNames. */
  Prices: number[]
  /** Implied probabilities as percent strings ('71.124'), may be 'NA'. */
  Pct?: string[]
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface TxLineCredentials {
  /** Guest JWT — short-lived, renewed automatically on 401. */
  jwt: string
  /** API token from on-chain activation — long-lived. */
  apiToken: string
}

/** Headers attached to every TxLINE request. */
export interface TxLineHeaders {
  Authorization: string
  'X-Api-Token': string
}

/** Error thrown by lib/txline on any non-2xx TxLINE response. */
export class TxLineApiError extends Error {
  readonly status: number
  readonly url: string
  readonly body: unknown

  constructor(message: string, status: number, url: string, body: unknown) {
    super(message)
    this.name = 'TxLineApiError'
    this.status = status
    this.url = url
    this.body = body
  }
}
