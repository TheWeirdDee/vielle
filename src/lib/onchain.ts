/**
 * On-chain signal ledger via Solana's Memo program — no custom smart
 * contract, so implementation risk stays low while still producing an
 * immutable, independently auditable record. Every signal fire and every
 * settlement gets one memo transaction referencing the TxLINE proof for that
 * match moment.
 *
 * Writes are never allowed to drop a signal: callers persist to Supabase
 * first, then call these functions async/non-blocking, catching failures
 * into onchain_status = 'failed' rather than throwing into the hot path.
 */

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
import { withRetry, log } from './resilience'

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

let connection: Connection | null = null
let keypair: Keypair | null = null

function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com', 'confirmed')
  }
  return connection
}

function getKeypair(): Keypair {
  if (keypair) return keypair
  const raw = process.env.SOLANA_WALLET_PRIVATE_KEY?.trim()
  if (!raw) throw new Error('SOLANA_WALLET_PRIVATE_KEY is not set')
  if (fs.existsSync(raw)) {
    keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(raw, 'utf8')) as number[]))
  } else if (raw.startsWith('[')) {
    keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]))
  } else {
    keypair = Keypair.fromSecretKey(bs58.decode(raw))
  }
  return keypair
}

async function writeMemo(data: Record<string, unknown>): Promise<string> {
  const memoText = JSON.stringify(data)
  return withRetry(async () => {
    const conn = getConnection()
    const payer = getKeypair()
    const transaction = new Transaction().add(
      new TransactionInstruction({
        keys: [],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(memoText, 'utf-8'),
      })
    )
    return sendAndConfirmTransaction(conn, transaction, [payer])
  }, 3, 2000)
}

export interface SignalMemoInput {
  id: string
  strategy: string
  matchId: string
  delta: number
  triggerEvent: string
  favouredTeam: string
  firedAt: number
  txlineProofReference?: string
}

export async function writeSignalOnChain(signal: SignalMemoInput): Promise<string> {
  try {
    return await writeMemo({
      v: 1,
      type: 'signal',
      signal_id: signal.id,
      strategy: signal.strategy,
      match_id: signal.matchId,
      txline_proof: signal.txlineProofReference ?? 'pending',
      fired_at: signal.firedAt,
      delta: signal.delta,
      trigger: signal.triggerEvent,
      favoured: signal.favouredTeam,
      outcome: null,
    })
  } catch (error) {
    await log('scout', 'onchain_failure', { signal_id: signal.id, error: String(error) }, 'critical')
    throw error
  }
}

export interface SettlementMemoInput {
  id: string
  strategy: string
  matchId: string
  outcome: string
  resolvedAt: number
  txlineProofReference?: string
}

export async function writeSettlementOnChain(signal: SettlementMemoInput): Promise<string> {
  try {
    return await writeMemo({
      v: 1,
      type: 'settlement',
      signal_id: signal.id,
      strategy: signal.strategy,
      match_id: signal.matchId,
      txline_proof: signal.txlineProofReference ?? 'pending',
      resolved_at: signal.resolvedAt,
      outcome: signal.outcome,
    })
  } catch (error) {
    await log('clerk', 'onchain_failure', { signal_id: signal.id, error: String(error) }, 'critical')
    throw error
  }
}
