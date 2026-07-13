/**
 * VEILLE SCOUT — the surveillance agent. Runs continuously.
 *
 * Connects to TxLINE's live odds + scores streams (with reconnect,
 * snapshot-recovery, and match_state persistence via resilient-stream.ts),
 * feeds every tick through the pre-registered dual-strategy signal detector,
 * and for every fire: persists to Supabase first (never dropped), then
 * asynchronously writes an on-chain memo and notifies subscribers.
 */

try {
  process.loadEnvFile('.env')
} catch {
  /* env from shell */
}

import { connectResilientStreams } from '../lib/resilient-stream'
import { SignalDetector } from '../lib/signal-detector'
import { loadSignalDefinition } from '../lib/registry'
import { getSupabase } from '../lib/supabase'
import { log } from '../lib/resilience'
import { writeSignalOnChain } from '../lib/onchain'
import { notifySubscribers } from '../lib/subscribers'
import type { VeilleSignal } from '../types'

async function processSignal(signal: VeilleSignal): Promise<void> {
  const db = getSupabase()
  const insert = await db
    .from('veille_signals')
    .insert({
      signal_registry_id: signal.signalRegistryId,
      strategy: signal.strategy,
      match_id: signal.matchId,
      home_team: signal.homeTeam,
      away_team: signal.awayTeam,
      trigger_event: signal.triggerEvent,
      trigger_minute: signal.triggerMinute,
      pre_event_home_prob: signal.preEventHomeProb,
      pre_event_away_prob: signal.preEventAwayProb,
      post_signal_home_prob: signal.postSignalHomeProb,
      post_signal_away_prob: signal.postSignalAwayProb,
      delta: signal.delta,
      window_seconds: signal.windowSeconds,
      favoured_team: signal.favouredTeam,
      position: signal.position,
      recovered_from_snapshot: signal.recoveredFromSnapshot,
      onchain_status: 'pending',
      subscribers_notified: 0,
      subscribers_failed: 0,
      fired_at: new Date(signal.firedAt).toISOString(),
    })
    .select()
    .single()

  if (insert.error || !insert.data) {
    await log('scout', 'signal_fired', { error: insert.error?.message }, 'critical')
    return
  }

  const id = insert.data.id as string
  const saved: VeilleSignal & { id: string } = { ...signal, id }

  await log('scout', 'signal_fired', {
    id,
    strategy: signal.strategy,
    match: `${signal.homeTeam} vs ${signal.awayTeam}`,
    delta: signal.delta,
    trigger: signal.triggerEvent,
    favoured: signal.favouredTeam,
    position: signal.position,
  })

  writeSignalOnChain({
    id,
    strategy: signal.strategy,
    matchId: signal.matchId,
    delta: signal.delta,
    triggerEvent: signal.triggerEvent,
    favouredTeam: signal.favouredTeam,
    firedAt: signal.firedAt,
  })
    .then(async (txSig) => {
      await db.from('veille_signals').update({ onchain_status: 'confirmed', onchain_tx_signature: txSig }).eq('id', id)
    })
    .catch(async () => {
      await db.from('veille_signals').update({ onchain_status: 'failed' }).eq('id', id)
    })

  notifySubscribers(saved, 'signal_fired')
    .then(async ({ notified, failed }) => {
      await db.from('veille_signals').update({ subscribers_notified: notified, subscribers_failed: failed }).eq('id', id)
    })
    .catch((err: unknown) => console.error('[scout] subscriber notify failed:', err))
}

async function main(): Promise<void> {
  console.log('VEILLE SCOUT starting…')
  const def = await loadSignalDefinition()
  console.log(`Signal: ${def.name} (registered ${def.registeredAt}, id ${def.id})`)
  await log('scout', 'reconnect', { status: 'starting', signal_id: def.id })

  const detector = new SignalDetector(def)

  const disconnect = connectResilientStreams({
    onMatchEvent: (event, state) => {
      detector.onMatchEvent(event, state)
    },
    onOddsEvent: (event) => {
      const signals = detector.onOddsEvent(event)
      for (const signal of signals) void processSignal(signal)
    },
    onMatchAbandoned: (matchId) => {
      void log('scout', 'void_abandoned', { match_id: matchId })
    },
    onMatchPostponed: (matchId) => {
      void log('scout', 'void_postponed', { match_id: matchId })
    },
  })

  const shutdown = (signal: string): void => {
    console.log(`SCOUT shutting down (${signal})…`)
    disconnect()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  setInterval(() => console.log(`[SCOUT] alive - ${new Date().toISOString()}`), 60_000)
}

main().catch(async (err: unknown) => {
  await log('scout', 'reconnect', { error: String(err) }, 'critical')
  process.exit(1)
})
