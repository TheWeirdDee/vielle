/** Loads the pre-registered VEILLE signal definition from Supabase. */

import { getSupabase } from './supabase'
import type { SignalDefinition } from '../types'

const SIGNAL_NAME = 'POST_EVENT_PROB_SHOCK'

interface RegistryRow {
  id: string
  name: string
  description: string
  delta_threshold: number | string
  window_seconds: number
  trigger_events: string[]
  lookback_seconds: number
  pre_event_prob_cap: number | string
  cooldown_seconds: number | null
  registered_at: string
}

export async function loadSignalDefinition(): Promise<SignalDefinition> {
  const res = await getSupabase()
    .from('veille_signal_registry')
    .select('*')
    .eq('name', SIGNAL_NAME)
    .single()
  if (res.error || !res.data) {
    throw new Error(
      `Signal "${SIGNAL_NAME}" is not registered. Run: npm run register-signal (${res.error?.message ?? 'not found'})`
    )
  }
  const row = res.data as RegistryRow
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    deltaThreshold: Number(row.delta_threshold),
    windowSeconds: row.window_seconds,
    triggerEvents: row.trigger_events,
    lookbackSeconds: row.lookback_seconds,
    preEventProbCap: Number(row.pre_event_prob_cap),
    cooldownSeconds: row.cooldown_seconds ?? 300,
    registeredAt: row.registered_at,
  }
}
