/**
 * Register a webhook subscriber. Generates the HMAC secret, inserts the row,
 * and prints what to configure on the receiving side.
 *
 *   npx tsx scripts/add-subscriber.ts <name> <webhook-url> [strategies]
 *
 * Example (the dashboard's Discord bridge):
 *   npx tsx scripts/add-subscriber.ts discord-bridge https://veille-dashboard-nine.vercel.app/api/notify A,B
 *
 * Then set on the receiver (Vercel → Settings → Environment Variables):
 *   VEILLE_WEBHOOK_SECRET=<printed secret>
 *   DISCORD_WEBHOOK_URL=<your Discord channel webhook>
 */

try {
  process.loadEnvFile('.env')
} catch {
  /* env from shell */
}

import { randomBytes } from 'node:crypto'
import { getSupabase } from '../src/lib/supabase'

async function main(): Promise<void> {
  const [name, webhookUrl, strategiesArg] = process.argv.slice(2)
  if (!name || !webhookUrl) {
    console.error('Usage: npx tsx scripts/add-subscriber.ts <name> <webhook-url> [strategies=A,B]')
    process.exit(1)
  }
  const strategies = (strategiesArg ?? 'A,B').split(',').map((s) => s.trim().toUpperCase())
  const secret = randomBytes(32).toString('hex')

  const db = getSupabase()
  const existing = await db.from('veille_subscribers').select('id').eq('name', name).maybeSingle()
  if (existing.data) {
    console.error(`Subscriber "${name}" already exists (${existing.data.id as string}) — pick another name or delete it first.`)
    process.exit(1)
  }

  const res = await db
    .from('veille_subscribers')
    .insert({ name, webhook_url: webhookUrl, secret_key: secret, strategies, active: true })
    .select('id')
    .single()
  if (res.error) {
    console.error('Insert failed:', res.error.message)
    process.exit(1)
  }

  console.log(`Subscriber registered: ${name} (${res.data.id as string})`)
  console.log(`  webhook: ${webhookUrl}`)
  console.log(`  strategies: ${strategies.join(', ')}`)
  console.log(`\nConfigure the receiver with this shared secret (shown once):`)
  console.log(`  VEILLE_WEBHOOK_SECRET=${secret}`)
}

main().catch((err: unknown) => {
  console.error('FATAL', err)
  process.exitCode = 1
})
