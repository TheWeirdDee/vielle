/**
 * B2B webhook delivery. Every active subscriber registered for a strategy
 * gets an HMAC-SHA256-signed POST within the retry window whenever a signal
 * fires or settles. Delivery never blocks or fails the signal itself.
 */

import { createHmac } from 'node:crypto'
import { getSupabase } from './supabase'
import { withRetry, log } from './resilience'
import type { Subscriber, SubscriberPayload, VeilleSignal } from '../types'

interface SubscriberRow {
  id: string
  name: string
  webhook_url: string
  secret_key: string
  active: boolean
  strategies: string[]
  total_deliveries: number
  failed_deliveries: number
}

async function getActiveSubscribers(strategy: string): Promise<SubscriberRow[]> {
  const res = await getSupabase()
    .from('veille_subscribers')
    .select('*')
    .eq('active', true)
    .contains('strategies', [strategy])
  if (res.error) {
    console.error('[subscribers] failed to load subscribers:', res.error.message)
    return []
  }
  return res.data as SubscriberRow[]
}

function toSubscriber(r: SubscriberRow): Subscriber {
  return {
    id: r.id,
    name: r.name,
    webhookUrl: r.webhook_url,
    secretKey: r.secret_key,
    active: r.active,
    strategies: r.strategies as Subscriber['strategies'],
  }
}

function signPayload(payload: Omit<SubscriberPayload, 'hmac_signature'>, secret: string): string {
  return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex')
}

export async function notifySubscribers(
  signal: VeilleSignal & { id: string },
  event: 'signal_fired' | 'position_settled'
): Promise<{ notified: number; failed: number }> {
  const rows = await getActiveSubscribers(signal.strategy)
  let notified = 0
  let failed = 0
  const db = getSupabase()

  for (const row of rows) {
    const sub = toSubscriber(row)
    const base: Omit<SubscriberPayload, 'hmac_signature'> = {
      veille_version: 1,
      event,
      signal_id: signal.id,
      strategy: signal.strategy,
      match_id: signal.matchId,
      home_team: signal.homeTeam,
      away_team: signal.awayTeam,
      trigger_event: signal.triggerEvent,
      trigger_minute: signal.triggerMinute,
      favoured_team: signal.favouredTeam,
      position: signal.position,
      pre_event_prob: signal.favouredTeam === 'home' ? signal.preEventHomeProb : signal.preEventAwayProb,
      post_signal_prob: signal.favouredTeam === 'home' ? signal.postSignalHomeProb : signal.postSignalAwayProb,
      delta: signal.delta,
      onchain_tx: signal.onchainTxSignature ?? '',
      txline_proof: signal.txlineProofReference ?? '',
      fired_at: signal.firedAt,
      outcome: signal.outcome,
    }
    const payload: SubscriberPayload = { ...base, hmac_signature: signPayload(base, sub.secretKey) }

    try {
      await withRetry(
        async () => {
          const response = await fetch(sub.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
          })
          if (!response.ok) throw new Error(`subscriber ${sub.id} returned ${response.status}`)
        },
        3,
        1000
      )
      notified += 1
      await db
        .from('veille_subscribers')
        .update({
          last_delivery_at: new Date().toISOString(),
          total_deliveries: row.total_deliveries + 1,
        })
        .eq('id', sub.id)
    } catch (error) {
      failed += 1
      await db
        .from('veille_subscribers')
        .update({ failed_deliveries: row.failed_deliveries + 1 })
        .eq('id', sub.id)
      await log(
        'scout',
        'subscriber_failure',
        { subscriber_id: sub.id, signal_id: signal.id, error: String(error) },
        'warning'
      )
    }
  }

  return { notified, failed }
}
