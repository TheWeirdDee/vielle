/** VEILLE CLERK — atomic settlement plus durable effect reconciliation. */

try {
  process.loadEnvFile('.env')
} catch {
  /* env from shell */
}

import { getScoresSnapshot } from '../lib/txline/snapshots'
import { getSupabase } from '../lib/supabase'
import { updatePortfolio } from '../lib/portfolio'
import { writeSettlementOnChain } from '../lib/onchain'
import { notifySubscribers } from '../lib/subscribers'
import { heartbeat, log, sleep } from '../lib/resilience'
import { toVeilleSignal } from '../lib/signal-row'
import type { SignalDbRow } from '../lib/signal-row'
import type { GamePhase, TxLineScoresRecord } from '../lib/txline/types'
import type { Strategy, VeilleSignal, Winner } from '../types'

const POLL_INTERVAL_MS = 5 * 60 * 1000
const COMPLETE_PHASES = new Set<GamePhase>(['F', 'FET', 'FPE'])
const VOID_PHASES = new Set<GamePhase>(['A', 'C'])

async function getUnsettledMatchIds(): Promise<string[]> {
  const res = await getSupabase().from('veille_signals').select('match_id').is('outcome', null)
  if (res.error) throw new Error(res.error.message)
  return [...new Set((res.data as { match_id: string }[]).map((row) => row.match_id))]
}

/** FPE (decided on penalties) needs the PE-period score, not regulation Total. */
export function decideWinner(
  phase: GamePhase,
  homeScore: number,
  awayScore: number,
  rawRecords: TxLineScoresRecord[]
): Winner | null {
  if (phase !== 'FPE') {
    if (homeScore > awayScore) return 'home'
    if (awayScore > homeScore) return 'away'
    return 'draw'
  }
  const finalised = rawRecords.find((record) => record.Action === 'game_finalised')
  const p1 = finalised?.Score?.Participant1?.PE?.Goals
  const p2 = finalised?.Score?.Participant2?.PE?.Goals
  if (typeof p1 !== 'number' || typeof p2 !== 'number' || p1 === p2) return null
  const p1IsHome = finalised?.Participant1IsHome ?? true
  return (p1 > p2) === p1IsHome ? 'home' : 'away'
}

export function outcomeForPosition(position: string, winner: Winner): 'hit' | 'miss' {
  if (position === 'long_home') return winner === 'home' ? 'hit' : 'miss'
  if (position === 'long_away') return winner === 'away' ? 'hit' : 'miss'
  if (position === 'short_home') return winner !== 'home' ? 'hit' : 'miss'
  if (position === 'short_away') return winner !== 'away' ? 'hit' : 'miss'
  throw new Error(`Unknown position: ${position}`)
}

async function updateSignal(id: string, values: Record<string, unknown>): Promise<void> {
  const res = await getSupabase().from('veille_signals').update(values).eq('id', id)
  if (res.error) throw new Error(`update signal ${id}: ${res.error.message}`)
}

async function runSettlementEffects(signal: VeilleSignal & { id: string }, row: SignalDbRow): Promise<void> {
  if (!signal.outcome || !signal.resolvedAt) return
  const onchain =
    row.settlement_onchain_status === 'confirmed' && row.settlement_onchain_tx_signature
      ? Promise.resolve()
      : writeSettlementOnChain({
          id: signal.id,
          strategy: signal.strategy,
          matchId: signal.matchId,
          outcome: signal.outcome,
          resolvedAt: signal.resolvedAt,
          txlineProofReference: row.settlement_txline_proof_reference ?? undefined,
        })
          .then((txSignature) =>
            updateSignal(signal.id, {
              settlement_onchain_status: 'confirmed',
              settlement_onchain_tx_signature: txSignature,
            })
          )
          .catch(async (error: unknown) => {
            await updateSignal(signal.id, { settlement_onchain_status: 'failed' }).catch(() => undefined)
            throw error
          })

  const subscribers = notifySubscribers(signal, 'position_settled').then(({ notified, failed }) =>
    updateSignal(signal.id, {
      settlement_subscribers_notified: notified,
      settlement_subscribers_failed: failed,
    })
  )

  const results = await Promise.allSettled([onchain, subscribers])
  for (const result of results) {
    if (result.status === 'rejected') console.error('[clerk] settlement effect failed:', result.reason)
  }
}

async function claimSettlement(
  row: SignalDbRow,
  outcome: 'hit' | 'miss' | 'void',
  winner: Winner | null
): Promise<SignalDbRow | null> {
  const resolvedAt = new Date().toISOString()
  const res = await getSupabase()
    .from('veille_signals')
    .update({
      outcome,
      actual_winner: winner,
      resolved_at: resolvedAt,
      settlement_onchain_status: 'pending',
    })
    .eq('id', row.id)
    .is('outcome', null)
    .select('*')
    .maybeSingle()
  if (res.error) throw new Error(`claim settlement ${row.id}: ${res.error.message}`)
  return res.data as SignalDbRow | null
}

async function settleMatch(matchId: string): Promise<void> {
  const db = getSupabase()
  const openRes = await db.from('veille_signals').select('*').eq('match_id', matchId).is('outcome', null)
  if (openRes.error) throw new Error(openRes.error.message)
  const open = openRes.data as SignalDbRow[]
  if (open.length === 0) return

  const snapshot = await getScoresSnapshot(matchId)
  const phase = snapshot.state.phase
  if (phase === 'P') return
  if (!VOID_PHASES.has(phase) && !COMPLETE_PHASES.has(phase)) return

  const winner = VOID_PHASES.has(phase)
    ? null
    : decideWinner(phase, snapshot.state.homeScore, snapshot.state.awayScore, snapshot.raw as TxLineScoresRecord[])
  if (!VOID_PHASES.has(phase) && !winner) return

  const touchedStrategies = new Set<Strategy>()
  for (const row of open) {
    const outcome = winner ? outcomeForPosition(row.position, winner) : 'void'
    const claimed = await claimSettlement(row, outcome, winner)
    if (!claimed) {
      await log('clerk', 'duplicate_prevented', { signal_id: row.id, event: 'position_settled' })
      continue
    }
    touchedStrategies.add(row.strategy)
    await log('clerk', winner ? 'position_settled' : 'void_abandoned', {
      signal_id: row.id,
      strategy: row.strategy,
      outcome,
      match_id: matchId,
      winner,
    })
    await runSettlementEffects(toVeilleSignal(claimed), claimed)
  }
  for (const strategy of touchedStrategies) await updatePortfolio(strategy)
}

async function reconcileSettlementEffects(): Promise<void> {
  const res = await getSupabase().from('veille_signals').select('*').not('outcome', 'is', null)
  if (res.error) throw new Error(`reconcile settlements: ${res.error.message}`)
  for (const row of res.data as SignalDbRow[]) await runSettlementEffects(toVeilleSignal(row), row)
}

async function main(): Promise<void> {
  console.log('VEILLE CLERK starting…')
  await log('clerk', 'reconnect', { status: 'starting' })
  await heartbeat('clerk')
  const heartbeatTimer = setInterval(() => void heartbeat('clerk'), 60_000)
  let running = true
  let stopWait: (() => void) | null = null
  const stop = (): void => {
    running = false
    stopWait?.()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  while (running) {
    try {
      await reconcileSettlementEffects()
      const matchIds = await getUnsettledMatchIds()
      for (const matchId of matchIds) {
        await settleMatch(matchId)
        await sleep(1000)
      }
    } catch (error) {
      await log('clerk', 'reconnect', { error: String(error) }, 'warning')
    }
    if (running) {
      await Promise.race([
        sleep(POLL_INTERVAL_MS),
        new Promise<void>((resolve) => {
          stopWait = resolve
        }),
      ])
      stopWait = null
    }
  }
  clearInterval(heartbeatTimer)
  console.log('CLERK shutting down…')
}

main().catch(async (error: unknown) => {
  await log('clerk', 'reconnect', { error: String(error) }, 'critical')
  process.exit(1)
})
