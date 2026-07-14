/**
 * VEILLE-specific types (agent + portfolio + on-chain + subscriber layers).
 * TxLINE data-layer types live in src/lib/txline/types.ts.
 */

export type Strategy = 'A' | 'B'
export type SignalOutcome = 'hit' | 'miss' | 'void'
export type OnchainStatus = 'pending' | 'confirmed' | 'failed'
export type Winner = 'home' | 'away' | 'draw'
export type Position = 'long_home' | 'long_away' | 'short_home' | 'short_away'

export type AgentName = 'scout' | 'clerk'
export type AgentLogEvent =
  | 'heartbeat'
  | 'reconnect'
  | 'jwt_renewal'
  | 'snapshot_recovery'
  | 'onchain_failure'
  | 'void_abandoned'
  | 'void_postponed'
  | 'subscriber_failure'
  | 'signal_fired'
  | 'position_settled'
  | 'cooldown_blocked'
  | 'duplicate_prevented'
export type LogSeverity = 'info' | 'warning' | 'critical'

/** Pre-registered, immutable once written — see scripts/register-signal.ts. */
export interface SignalDefinition {
  id: string
  name: string
  description: string
  deltaThreshold: number
  windowSeconds: number
  triggerEvents: string[]
  lookbackSeconds: number
  preEventProbCap: number
  cooldownSeconds: number
  registeredAt: string
}

export interface VeilleSignal {
  id?: string
  signalRegistryId: string
  strategy: Strategy
  matchId: string
  homeTeam: string
  awayTeam: string
  triggerEvent: string
  triggerMinute?: number
  preEventHomeProb: number
  preEventAwayProb: number
  postSignalHomeProb: number
  postSignalAwayProb: number
  delta: number
  windowSeconds: number
  favouredTeam: 'home' | 'away'
  position: Position
  outcome?: SignalOutcome
  actualWinner?: Winner
  recoveredFromSnapshot: boolean
  onchainStatus: OnchainStatus
  onchainTxSignature?: string
  txlineProofReference?: string
  subscribersNotified: number
  subscribersFailed: number
  firedAt: number
  resolvedAt?: number
}

export interface PortfolioState {
  strategy: Strategy
  totalSignals: number
  totalSettled: number
  hits: number
  misses: number
  voids: number
  winRate: number
  pnlUnits: number
  sharpeRatio: number
  maxDrawdown: number
  currentDrawdown: number
  peakPnl: number
  lastUpdated: number
}

export interface Subscriber {
  id: string
  name: string
  webhookUrl: string
  secretKey: string
  active: boolean
  strategies: Strategy[]
}

export interface SubscriberPayload {
  veille_version: 1
  event: 'signal_fired' | 'position_settled'
  signal_id: string
  strategy: Strategy
  match_id: string
  home_team: string
  away_team: string
  trigger_event: string
  trigger_minute?: number
  favoured_team: 'home' | 'away'
  position: string
  pre_event_prob: number
  post_signal_prob: number
  delta: number
  onchain_tx: string
  txline_proof: string
  fired_at: number
  outcome?: SignalOutcome
  hmac_signature: string
}

/** One sample in a per-team rolling probability window. */
export interface OddsWindow {
  prob: number
  timestamp: number
}
