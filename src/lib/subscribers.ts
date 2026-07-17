/**
 * Idempotent B2B webhook delivery. Version 2 signs the exact raw request body
 * in headers, includes replay metadata, and records one durable delivery per
 * subscriber/signal/event before sending.
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
  created_at: string
}

interface DeliveryRow {
  claimed: boolean
  delivery_status: 'pending' | 'delivered' | 'failed'
  status: 'pending' | 'delivered' | 'failed'
  attempts: number
}

async function getActiveSubscribers(strategy: string): Promise<SubscriberRow[]> {
  const res = await getSupabase()
    .from('veille_subscribers')
    .select('id, name, webhook_url, secret_key, active, strategies, created_at')
    .eq('active', true)
    .contains('strategies', [strategy])
  if (res.error) throw new Error(`load subscribers: ${res.error.message}`)
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

export function signWebhookBody(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

async function incrementCounter(subscriberId: string, success: boolean): Promise<void> {
  const res = await getSupabase().rpc('increment_veille_subscriber_delivery', {
    p_subscriber_id: subscriberId,
    p_success: success,
  })
  if (res.error) console.error('[subscribers] counter update failed:', res.error.message)
}

async function deliverOne(
  row: SubscriberRow,
  signal: VeilleSignal & { id: string },
  event: 'signal_fired' | 'position_settled'
): Promise<boolean> {
  const db = getSupabase()
  const sub = toSubscriber(row)
  const deliveryId = `${signal.id}:${event}:${sub.id}`
  const sentAt = Date.now()
  const base: SubscriberPayload = {
    veille_version: 2,
    delivery_id: deliveryId,
    sent_at: sentAt,
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

  const claim = await db.rpc('claim_veille_webhook_delivery', {
    p_subscriber_id: sub.id,
    p_signal_id: signal.id,
    p_event_type: event,
    p_delivery_id: deliveryId,
  })
  if (claim.error) throw new Error(`claim delivery ${deliveryId}: ${claim.error.message}`)
  const delivery = (claim.data as DeliveryRow[] | null)?.[0]
  if (!delivery) throw new Error(`claim delivery ${deliveryId}: empty response`)
  if (!delivery.claimed) return delivery.delivery_status === 'delivered'

  const body = JSON.stringify(base)
  const signature = signWebhookBody(body, sub.secretKey)
  let attemptsUsed = 0
  try {
    await withRetry(
      async () => {
        attemptsUsed += 1
        const response = await fetch(sub.webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'VEILLE-Webhook/2',
            'X-VEILLE-Signature': signature,
            'X-VEILLE-Delivery-Id': deliveryId,
            'X-VEILLE-Timestamp': String(sentAt),
          },
          body,
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) throw new Error(`subscriber ${sub.id} returned ${response.status}`)
      },
      3,
      1000
    )

    const updated = await db
      .from('veille_webhook_deliveries')
      .update({
        status: 'delivered',
        attempts: delivery.attempts + attemptsUsed,
        last_error: null,
        delivered_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('delivery_id', deliveryId)
    if (updated.error) throw new Error(`complete delivery ${deliveryId}: ${updated.error.message}`)
    await incrementCounter(sub.id, true)
    return true
  } catch (error) {
    await db
      .from('veille_webhook_deliveries')
      .update({
        status: 'failed',
        attempts: delivery.attempts + attemptsUsed,
        last_error: String(error),
        updated_at: new Date().toISOString(),
      })
      .eq('delivery_id', deliveryId)
    await incrementCounter(sub.id, false)
    await log(
      event === 'signal_fired' ? 'scout' : 'clerk',
      'subscriber_failure',
      { subscriber_id: sub.id, signal_id: signal.id, event, delivery_id: deliveryId, error: String(error) },
      'warning'
    )
    return false
  }
}

export async function notifySubscribers(
  signal: VeilleSignal & { id: string },
  event: 'signal_fired' | 'position_settled'
): Promise<{ notified: number; failed: number }> {
  const rows = await getActiveSubscribers(signal.strategy)
  const eventAt = event === 'position_settled' ? (signal.resolvedAt ?? Date.now()) : signal.firedAt
  const eligible = rows.filter((row) => new Date(row.created_at).getTime() <= eventAt)
  const results = await Promise.all(eligible.map((row) => deliverOne(row, signal, event)))
  const notified = results.filter(Boolean).length
  return { notified, failed: results.length - notified }
}
