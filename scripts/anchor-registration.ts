/**
 * Anchor the pre-registered signal definition itself on-chain, once.
 *
 * The live fire ledger only starts at the first qualifying in-play moment —
 * this memo proves the *definition* (thresholds, windows, trigger events)
 * existed on-chain from day one, so the whole track record is auditable
 * against parameters that provably predate it.
 *
 *   npx tsx scripts/anchor-registration.ts
 *
 * Idempotent: refuses to run if a registration_anchored log entry already
 * exists for this signal.
 */

try {
  process.loadEnvFile('.env')
} catch {
  /* env from shell */
}

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import bs58 from 'bs58'
import * as fs from 'node:fs'
import { loadSignalDefinition } from '../src/lib/registry'
import { getSupabase } from '../src/lib/supabase'

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

function getKeypair(): Keypair {
  const raw = process.env.SOLANA_WALLET_PRIVATE_KEY?.trim()
  if (!raw) throw new Error('SOLANA_WALLET_PRIVATE_KEY is not set')
  if (fs.existsSync(raw)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(raw, 'utf8')) as number[]))
  if (raw.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]))
  return Keypair.fromSecretKey(bs58.decode(raw))
}

async function main(): Promise<void> {
  const db = getSupabase()
  const def = await loadSignalDefinition()

  const existing = await db
    .from('veille_agent_log')
    .select('id, details')
    .eq('event_type', 'registration_anchored')
    .limit(1)
  if (!existing.error && existing.data && existing.data.length > 0) {
    console.log('Registration already anchored:', JSON.stringify(existing.data[0].details))
    return
  }

  const memo = {
    v: 1,
    type: 'registration',
    signal_id: def.id,
    name: def.name,
    delta_threshold: def.deltaThreshold,
    window_seconds: def.windowSeconds,
    trigger_events: def.triggerEvents,
    lookback_seconds: def.lookbackSeconds,
    pre_event_prob_cap: def.preEventProbCap,
    cooldown_seconds: def.cooldownSeconds,
    registered_at: def.registeredAt,
  }

  console.log('Anchoring registration memo:', JSON.stringify(memo))
  const conn = new Connection(process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com', 'confirmed')
  const payer = getKeypair()
  const tx = new Transaction().add(
    new TransactionInstruction({ keys: [], programId: MEMO_PROGRAM_ID, data: Buffer.from(JSON.stringify(memo), 'utf-8') })
  )
  const sig = await sendAndConfirmTransaction(conn, tx, [payer])
  console.log('Confirmed:', sig)

  const logRes = await db.from('veille_agent_log').insert({
    agent: 'scout',
    event_type: 'registration_anchored',
    details: { signal_id: def.id, tx_signature: sig, name: def.name },
    severity: 'info',
  })
  if (logRes.error) {
    console.error('Memo confirmed but logging failed:', logRes.error.message)
    console.error('Record this signature manually:', sig)
    process.exitCode = 1
    return
  }
  console.log('Logged registration_anchored →', sig)
}

main().catch((err: unknown) => {
  console.error('FATAL', err)
  process.exitCode = 1
})
