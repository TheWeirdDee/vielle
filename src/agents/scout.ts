/** VEILLE SCOUT — durable signal surveillance and effect reconciliation. */

try {
  process.loadEnvFile('.env')
} catch {
  /* env from shell */
}

import {
  connectResilientStreams,
  loadPersistedMatches,
  persistCooldown,
} from '../lib/resilient-stream'
import { SignalDetector } from '../lib/signal-detector'
import { loadSignalDefinition } from '../lib/registry'
import { getSupabase } from '../lib/supabase'
import { heartbeat, log, withRetry } from '../lib/resilience'
import { writeSignalOnChain } from '../lib/onchain'
import { notifySubscribers } from '../lib/subscribers'
import { toVeilleSignal } from '../lib/signal-row'
import type { SignalDbRow } from '../lib/signal-row'
import type { VeilleSignal } from '../types'

async function updateSignal(id: string, values: Record<string, unknown>): Promise<void> {
  const res = await getSupabase().from('veille_signals').update(values).eq('id', id)
  if (res.error) throw new Error(`update signal ${id}: ${res.error.message}`)
}

async function runSignalEffects(saved: VeilleSignal & { id: string }): Promise<void> {
  const onchain =
    saved.onchainStatus === 'confirmed' && saved.onchainTxSignature
      ? Promise.resolve()
      : writeSignalOnChain({
          id: saved.id,
          strategy: saved.strategy,
          matchId: saved.matchId,
          delta: saved.delta,
          triggerEvent: saved.triggerEvent,
          favouredTeam: saved.favouredTeam,
          firedAt: saved.firedAt,
          txlineProofReference: saved.txlineProofReference,
        })
          .then(async (txSig) => {
            saved.onchainStatus = 'confirmed'
            saved.onchainTxSignature = txSig
            await updateSignal(saved.id, { onchain_status: 'confirmed', onchain_tx_signature: txSig })
          })
          .catch(async (error: unknown) => {
            await updateSignal(saved.id, { onchain_status: 'failed' }).catch(() => undefined)
            throw error
          })

  const subscribers = notifySubscribers(saved, 'signal_fired').then(async ({ notified, failed }) => {
    await updateSignal(saved.id, { subscribers_notified: notified, subscribers_failed: failed })
  })

  const results = await Promise.allSettled([onchain, subscribers])
  for (const result of results) {
    if (result.status === 'rejected') console.error('[scout] effect failed:', result.reason)
  }
}

async function processSignal(signal: VeilleSignal): Promise<void> {
  const db = getSupabase()
  const dedupeKey = [
    signal.signalRegistryId,
    signal.strategy,
    signal.matchId,
    signal.triggerEvent,
    signal.firedAt,
  ].join(':')

  try {
    const data = await withRetry(async () => {
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
          dedupe_key: dedupeKey,
          fired_at: new Date(signal.firedAt).toISOString(),
        })
        .select()
        .single()
      if (insert.error) {
        const error = new Error(insert.error.message) as Error & { code?: string }
        error.code = insert.error.code
        throw error
      }
      return insert.data
    }, 3, 500)

    const id = data.id as string
    const saved: VeilleSignal & { id: string } = { ...signal, id }
    await log('scout', 'signal_fired', {
      id,
      strategy: signal.strategy,
      match_id: signal.matchId,
      match: `${signal.homeTeam} vs ${signal.awayTeam}`,
      delta: signal.delta,
      window_seconds: signal.windowSeconds,
      trigger: signal.triggerEvent,
      favoured: signal.favouredTeam,
      position: signal.position,
    })
    await runSignalEffects(saved)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === '23505') {
      await log('scout', 'duplicate_prevented', { dedupe_key: dedupeKey, match_id: signal.matchId })
      return
    }
    await log(
      'scout',
      'signal_fired',
      {
        error: String(error),
        dedupe_key: dedupeKey,
        strategy: signal.strategy,
        match_id: signal.matchId,
        trigger_event: signal.triggerEvent,
        fired_at: signal.firedAt,
      },
      'critical'
    )
  }
}

async function reconcileSignalEffects(): Promise<void> {
  const res = await getSupabase().from('veille_signals').select('*').order('fired_at', { ascending: true })
  if (res.error) throw new Error(`reconcile signals: ${res.error.message}`)
  for (const row of res.data as SignalDbRow[]) await runSignalEffects(toVeilleSignal(row))
}

async function main(): Promise<void> {
  console.log('VEILLE SCOUT starting…')
  const def = await loadSignalDefinition()
  await log('scout', 'reconnect', { status: 'starting', signal_id: def.id })
  const detector = new SignalDetector(def)
  const seeds = await loadPersistedMatches().catch(async (error: unknown) => {
    await log('scout', 'snapshot_recovery', { error: String(error) }, 'warning')
    return []
  })
  for (const seed of seeds) {
    detector.seedState(seed.matchId, seed.state)
    if (seed.lastTrigger) detector.seedTrigger(seed.matchId, seed.lastTrigger)
    if (seed.preTriggerOdds) detector.seedOdds(seed.matchId, seed.preTriggerOdds)
    detector.seedCooldown(seed.matchId, seed.cooldownUntil)
  }

  const pending = new Set<Promise<void>>()
  const schedule = (promise: Promise<void>): void => {
    pending.add(promise)
    void promise.then(
      () => pending.delete(promise),
      (error: unknown) => {
        pending.delete(promise)
        console.error('SCOUT background task failed', error)
      }
    )
  }

  const disconnect = connectResilientStreams(
    {
      onMatchEvent: (event, state, recovered) => detector.onMatchEvent(event, state, recovered),
      onOddsEvent: (event) => {
        const signals = detector.onOddsEvent(event)
        if (signals.length > 0) {
          schedule(persistCooldown(event.matchId, detector.getCooldownUntil(event.matchId)))
          for (const signal of signals) schedule(processSignal(signal))
        }
      },
      onMatchAbandoned: (matchId) => {
        schedule(log('scout', 'void_abandoned', { match_id: matchId }))
      },
      onMatchPostponed: (matchId) => {
        schedule(log('scout', 'void_postponed', { match_id: matchId }))
      },
    },
    seeds
  )

  schedule(reconcileSignalEffects())
  schedule(heartbeat('scout'))
  const heartbeatTimer = setInterval(() => schedule(heartbeat('scout')), 60_000)

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`SCOUT shutting down (${signal})…`)
    disconnect()
    clearInterval(heartbeatTimer)
    await Promise.race([
      Promise.allSettled([...pending]),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ])
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch(async (error: unknown) => {
  await log('scout', 'reconnect', { error: String(error) }, 'critical')
  process.exit(1)
})
