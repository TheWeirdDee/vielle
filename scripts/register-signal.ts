/**
 * Pre-register the VEILLE signal definition. Run this IMMEDIATELY and only
 * once — the registered_at timestamp is what makes the eventual track record
 * credible (it proves the definition wasn't tuned after seeing results).
 * Idempotent: if a row named POST_EVENT_PROB_SHOCK already exists, this just
 * reports its existing timestamp and does nothing.
 *
 *   npx tsx scripts/register-signal.ts
 */

try {
  process.loadEnvFile('.env')
} catch {
  /* env from shell */
}

import { getSupabase } from '../src/lib/supabase'

async function main(): Promise<void> {
  const db = getSupabase()

  const existing = await db
    .from('veille_signal_registry')
    .select('id, registered_at')
    .eq('name', 'POST_EVENT_PROB_SHOCK')
    .maybeSingle()
  if (existing.error) throw new Error(existing.error.message)

  if (existing.data) {
    console.log('Signal already registered.')
    console.log('ID:', existing.data.id)
    console.log('Registered at:', existing.data.registered_at)
    console.log(`\nSet SIGNAL_REGISTRY_ID=${existing.data.id as string} in .env if not already set.`)
    return
  }

  const insert = await db
    .from('veille_signal_registry')
    .insert({
      name: 'POST_EVENT_PROB_SHOCK',
      description:
        'Fires when odds probability shifts >=12% within 120 seconds following a goal or red card ' +
        'where pre-event odds implied <40% for the now-favoured team. Hypothesis: markets ' +
        'systematically underreact to high-impact in-play events when the favoured team was ' +
        'previously an underdog.',
      delta_threshold: 0.12,
      window_seconds: 120,
      trigger_events: ['goal', 'red_card'],
      lookback_seconds: 180,
      pre_event_prob_cap: 0.4,
      cooldown_seconds: 300,
    })
    .select()
    .single()
  if (insert.error) throw new Error(insert.error.message)

  console.log('Signal registered successfully.')
  console.log('ID:', insert.data.id as string)
  console.log('Registered at:', insert.data.registered_at as string)
  console.log(`\nSave this to .env: SIGNAL_REGISTRY_ID=${insert.data.id as string}`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
