/**
 * VEILLE CLERK — the settlement agent. Polls every 5 minutes for matches
 * with open positions, settles them against TxLINE's authoritative match
 * phase and score, updates portfolio statistics, writes settlement memos
 * on-chain, and notifies subscribers.
 */

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
import type { GamePhase, TxLineScoresRecord } from '../lib/txline/types'
import type { Strategy, VeilleSignal, Winner } from '../types'

const POLL_INTERVAL_MS = 5 * 60 * 1000
const COMPLETE_PHASES = new Set<GamePhase>(['F', 'FET', 'FPE'])
const VOID_PHASES = new Set<GamePhase>(['A', 'C'])

interface OpenSignalRow {
  id: string
  signal_registry_id: string
  strategy: Strategy
  match_id: string
  home_team: string
  away_team: string
  trigger_event: string
  trigger_minute: number | null
  pre_event_home_prob: number
  pre_event_away_prob: number
  post_signal_home_prob: number
  post_signal_away_prob: number
  delta: number
  window_seconds: number
  favoured_team: 'home' | 'away'
  position: string
  onchain_tx_signature: string | null
  txline_proof_reference: string | null
  fired_at: string
}

function toVeilleSignal(row: OpenSignalRow, extra: { outcome?: string; resolvedAt?: number }): VeilleSignal & { id: string } {
  return {
    id: row.id,
    signalRegistryId: row.signal_registry_id,
    strategy: row.strategy,
    matchId: row.match_id,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    triggerEvent: row.trigger_event,
    triggerMinute: row.trigger_minute ?? undefined,
    preEventHomeProb: row.pre_event_home_prob,
    preEventAwayProb: row.pre_event_away_prob,
    postSignalHomeProb: row.post_signal_home_prob,
    postSignalAwayProb: row.post_signal_away_prob,
    delta: row.delta,
    windowSeconds: row.window_seconds,
    favouredTeam: row.favoured_team,
    position: row.position as VeilleSignal['position'],
    recoveredFromSnapshot: false,
    onchainStatus: 'pending',
    onchainTxSignature: row.onchain_tx_signature ?? undefined,
    txlineProofReference: row.txline_proof_reference ?? undefined,
    subscribersNotified: 0,
    subscribersFailed: 0,
    firedAt: new Date(row.fired_at).getTime(),
    outcome: extra.outcome as VeilleSignal['outcome'],
    resolvedAt: extra.resolvedAt,
  }
}

async function getUnsettledMatchIds(): Promise<string[]> {
  const res = await getSupabase().from('veille_signals').select('match_id').is('outcome', null)
  if (res.error) throw new Error(res.error.message)
  return [...new Set((res.data as { match_id: string }[]).map((r) => r.match_id))]
}

/** FPE (decided on penalties) needs the PE-period score, not the regulation Total. */
function decideWinner(phase: GamePhase, homeScore: number, awayScore: number, rawRecords: TxLineScoresRecord[]): Winner | null {
  if (phase !== 'FPE') {
    if (homeScore > awayScore) return 'home'
    if (awayScore > homeScore) return 'away'
    return 'draw'
  }
  const finalised = rawRecords.find((r) => r.Action === 'game_finalised')
  const p1 = finalised?.Score?.Participant1?.PE?.Goals
  const p2 = finalised?.Score?.Participant2?.PE?.Goals
  if (typeof p1 !== 'number' || typeof p2 !== 'number' || p1 === p2) return null
  const p1IsHome = finalised?.Participant1IsHome ?? true
  return (p1 > p2) === p1IsHome ? 'home' : 'away'
}

function outcomeForPosition(position: string, winner: Winner): 'hit' | 'miss' {
  if (position === 'long_home') return winner === 'home' ? 'hit' : 'miss'
  if (position === 'long_away') return winner === 'away' ? 'hit' : 'miss'
  if (position === 'short_home') return winner !== 'home' ? 'hit' : 'miss'
  return winner !== 'away' ? 'hit' : 'miss' // short_away
}

async function settleMatch(matchId: string): Promise<void> {
  const db = getSupabase()
  const openRes = await db.from('veille_signals').select('*').eq('match_id', matchId).is('outcome', null)
  if (openRes.error) throw new Error(openRes.error.message)
  const open = openRes.data as OpenSignalRow[]
  if (open.length === 0) return

  const snapshot = await getScoresSnapshot(matchId)
  const phase = snapshot.state.phase
  const touchedStrategies = new Set<Strategy>()

  if (VOID_PHASES.has(phase)) {
    for (const row of open) {
      await db.from('veille_signals').update({ outcome: 'void', actual_winner: null, resolved_at: new Date().toISOString() }).eq('id', row.id)
      await log('clerk', 'void_abandoned', { signal_id: row.id, match_id: matchId })
      touchedStrategies.add(row.strategy)
      const settled = toVeilleSignal(row, { outcome: 'void', resolvedAt: Date.now() })
      writeSettlementOnChain({ id: row.id, strategy: row.strategy, matchId, outcome: 'void', resolvedAt: Date.now() }).catch(
        async (err: unknown) => log('clerk', 'onchain_failure', { signal_id: row.id, error: String(err) }, 'critical')
      )
      notifySubscribers(settled, 'position_settled').catch((err: unknown) => console.error('[clerk] notify failed:', err))
    }
    for (const s of touchedStrategies) await updatePortfolio(s)
    return
  }

  if (phase === 'P') {
    await log('clerk', 'void_postponed', { match_id: matchId, phase })
    return
  }

  if (!COMPLETE_PHASES.has(phase)) return // still live — re-check next poll

  const winner = decideWinner(phase, snapshot.state.homeScore, snapshot.state.awayScore, snapshot.raw as TxLineScoresRecord[])
  if (!winner) {
    // FPE with no readable shootout score yet — wait for the next poll rather than guessing.
    return
  }

  for (const row of open) {
    const outcome = outcomeForPosition(row.position, winner)
    const resolvedAt = Date.now()
    await db
      .from('veille_signals')
      .update({ outcome, actual_winner: winner, resolved_at: new Date(resolvedAt).toISOString() })
      .eq('id', row.id)
    await log('clerk', 'position_settled', { signal_id: row.id, strategy: row.strategy, outcome, match_id: matchId, winner })
    touchedStrategies.add(row.strategy)

    const settled = toVeilleSignal(row, { outcome, resolvedAt })
    writeSettlementOnChain({ id: row.id, strategy: row.strategy, matchId, outcome, resolvedAt }).catch(
      async (err: unknown) => log('clerk', 'onchain_failure', { signal_id: row.id, error: String(err) }, 'critical')
    )
    notifySubscribers(settled, 'position_settled').catch((err: unknown) => console.error('[clerk] notify failed:', err))
  }

  for (const s of touchedStrategies) await updatePortfolio(s)
}

async function main(): Promise<void> {
  console.log('VEILLE CLERK starting…')
  await log('clerk', 'reconnect', { status: 'starting' })

  // Heartbeat runs on its own clock, independent of the poll loop below, so
  // liveness is reported every 60s regardless of how long a poll cycle takes.
  void heartbeat('clerk')
  const heartbeatTimer = setInterval(() => void heartbeat('clerk'), 60_000)

  let running = true
  process.on('SIGINT', () => (running = false))
  process.on('SIGTERM', () => (running = false))

  while (running) {
    try {
      const matchIds = await getUnsettledMatchIds()
      if (matchIds.length > 0) {
        console.log(`[CLERK] checking ${matchIds.length} match(es) with open positions…`)
        for (const matchId of matchIds) {
          await settleMatch(matchId)
          await sleep(1000)
        }
      }
    } catch (error) {
      await log('clerk', 'reconnect', { error: String(error) }, 'warning')
    }
    await sleep(POLL_INTERVAL_MS)
  }
  clearInterval(heartbeatTimer)
  console.log('CLERK shutting down…')
}

main().catch(async (err: unknown) => {
  await log('clerk', 'reconnect', { error: String(err) }, 'critical')
  process.exit(1)
})
