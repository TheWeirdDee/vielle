import type { Strategy, VeilleSignal } from '../types'

export interface SignalDbRow {
  id: string
  signal_registry_id: string
  strategy: Strategy
  match_id: string
  home_team: string
  away_team: string
  trigger_event: string
  trigger_minute: number | null
  pre_event_home_prob: number | string
  pre_event_away_prob: number | string
  post_signal_home_prob: number | string
  post_signal_away_prob: number | string
  delta: number | string
  window_seconds: number
  favoured_team: 'home' | 'away'
  position: VeilleSignal['position']
  outcome: VeilleSignal['outcome'] | null
  actual_winner: VeilleSignal['actualWinner'] | null
  recovered_from_snapshot: boolean
  onchain_status: VeilleSignal['onchainStatus']
  onchain_tx_signature: string | null
  txline_proof_reference: string | null
  subscribers_notified: number
  subscribers_failed: number
  settlement_onchain_status: string | null
  settlement_onchain_tx_signature: string | null
  settlement_txline_proof_reference: string | null
  settlement_subscribers_notified: number
  settlement_subscribers_failed: number
  fired_at: string
  resolved_at: string | null
}

const num = (value: number | string): number => Number(value)

export function toVeilleSignal(row: SignalDbRow): VeilleSignal & { id: string } {
  return {
    id: row.id,
    signalRegistryId: row.signal_registry_id,
    strategy: row.strategy,
    matchId: row.match_id,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    triggerEvent: row.trigger_event,
    triggerMinute: row.trigger_minute ?? undefined,
    preEventHomeProb: num(row.pre_event_home_prob),
    preEventAwayProb: num(row.pre_event_away_prob),
    postSignalHomeProb: num(row.post_signal_home_prob),
    postSignalAwayProb: num(row.post_signal_away_prob),
    delta: num(row.delta),
    windowSeconds: row.window_seconds,
    favouredTeam: row.favoured_team,
    position: row.position,
    outcome: row.outcome ?? undefined,
    actualWinner: row.actual_winner ?? undefined,
    recoveredFromSnapshot: row.recovered_from_snapshot,
    onchainStatus: row.onchain_status,
    onchainTxSignature: row.onchain_tx_signature ?? undefined,
    txlineProofReference: row.txline_proof_reference ?? undefined,
    subscribersNotified: row.subscribers_notified,
    subscribersFailed: row.subscribers_failed,
    firedAt: new Date(row.fired_at).getTime(),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).getTime() : undefined,
  }
}
