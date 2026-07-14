/**
 * Shared resilience primitives: structured agent logging (persisted to
 * veille_agent_log — meaningful events only) and retry-with-backoff for
 * flaky external calls (on-chain writes, subscriber webhooks).
 *
 * Liveness is tracked separately via heartbeat() / veille_agent_heartbeat —
 * one row per agent, upserted. Keeping it out of veille_agent_log matters:
 * that table is read as a human-facing history of what actually happened
 * (reconnects, fires, failures), and a row every 2 minutes forever drowns it.
 */

import { getSupabase } from './supabase'
import type { AgentLogEvent, AgentName, LogSeverity } from '../types'

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function log(
  agent: AgentName,
  event: AgentLogEvent,
  details?: Record<string, unknown>,
  severity: LogSeverity = 'info'
): Promise<void> {
  console.log(`[${agent.toUpperCase()}][${severity.toUpperCase()}] ${event}`, details ?? '')
  const res = await getSupabase()
    .from('veille_agent_log')
    .insert({ agent, event_type: event, details: details ?? null, severity })
  if (res.error) console.error('[resilience] failed to write agent log:', res.error.message)
}

/** Liveness ping — one row per agent, upserted. Does not touch veille_agent_log. */
export async function heartbeat(agent: AgentName): Promise<void> {
  const res = await getSupabase()
    .from('veille_agent_heartbeat')
    .upsert({ agent, last_seen: new Date().toISOString() })
  if (res.error) console.error('[resilience] heartbeat upsert failed:', res.error.message)
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 2000
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt === maxAttempts) throw error
      await sleep(baseDelayMs * 2 ** (attempt - 1))
    }
  }
  throw new Error('withRetry: unreachable')
}
