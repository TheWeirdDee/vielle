/**
 * One-time TxLINE activation. Documented for parity with the other product
 * repos — VEILLE shares the txline-core wallet's subscription (Service Level
 * 12 is one on-chain subscription per wallet, valid for every product), so
 * TXLINE_API_TOKEN is normally just copied into .env rather than re-run here.
 * Only run this if you need a fresh subscription under a different wallet.
 *
 *   npx tsx scripts/activate.ts
 */

try {
  process.loadEnvFile('.env')
} catch {
  // .env may not exist yet — env vars can come from the shell
}

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as anchor from '@coral-xyz/anchor'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import nacl from 'tweetnacl'
import { activateToken, buildActivationMessage, getGuestJWT } from '../src/lib/txline/auth'
import idlJson from './idl/txoracle.json'
import type { Txoracle } from './idl/txoracle'

const SERVICE_LEVEL_ID = 12 // real-time World Cup (free on mainnet)
const DURATION_WEEKS = 4
const SELECTED_LEAGUES: number[] = [] // standard bundle

const TXL_TOKEN_MINT = new PublicKey('Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL')
const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com'
const ENV_PATH = path.join(process.cwd(), '.env')

function loadWallet(): Keypair {
  const raw = process.env.SOLANA_WALLET_PRIVATE_KEY?.trim()
  if (!raw) {
    throw new Error(
      'SOLANA_WALLET_PRIVATE_KEY is not set. Put the funded mainnet wallet key in .env ' +
        '(base58 secret key, JSON byte array, or a path to a JSON keypair file).'
    )
  }
  if (fs.existsSync(raw)) {
    const bytes = JSON.parse(fs.readFileSync(raw, 'utf8')) as number[]
    return Keypair.fromSecretKey(Uint8Array.from(bytes))
  }
  if (raw.startsWith('[')) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]))
  }
  return Keypair.fromSecretKey(anchor.utils.bytes.bs58.decode(raw))
}

function upsertEnv(entries: Record<string, string>): void {
  let lines: string[] = []
  if (fs.existsSync(ENV_PATH)) {
    lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)
  }
  for (const [key, value] of Object.entries(entries)) {
    const line = `${key}=${value}`
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`))
    if (idx >= 0) lines[idx] = line
    else lines.push(line)
  }
  fs.writeFileSync(ENV_PATH, lines.join('\n').replace(/\n*$/, '\n'))
}

async function main(): Promise<void> {
  if (process.env.TXLINE_API_TOKEN?.trim() && !process.argv.includes('--force')) {
    console.log('TXLINE_API_TOKEN is already set in .env — activation already happened.')
    console.log('Re-run with --force only if you intend to create a NEW on-chain subscription.')
    return
  }

  const wallet = loadWallet()
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`)

  const connection = new Connection(RPC_URL, 'confirmed')
  const balance = await connection.getBalance(wallet.publicKey)
  console.log(`Balance: ${(balance / 1e9).toFixed(6)} SOL`)
  if (balance < 5_000_000) {
    throw new Error(`Balance too low (${balance / 1e9} SOL). Need ~0.005 SOL for rent + fees.`)
  }

  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), {
    commitment: 'confirmed',
  })
  const program = new anchor.Program<Txoracle>(idlJson as unknown as Txoracle, provider)
  console.log(`Program: ${program.programId.toBase58()}`)

  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('pricing_matrix')],
    program.programId
  )
  const matrix = await program.account.pricingMatrix.fetch(pricingMatrixPda)
  const level = matrix.rows.find((r) => Number(r.rowId) === SERVICE_LEVEL_ID)
  if (!level) throw new Error(`Service level ${SERVICE_LEVEL_ID} not found in the pricing matrix.`)
  if (Number(level.pricePerWeekToken) !== 0) {
    throw new Error(`Service level ${SERVICE_LEVEL_ID} costs ${level.pricePerWeekToken} TxL/week — expected free.`)
  }

  const jwt = await getGuestJWT()
  console.log(`Guest JWT acquired (${jwt.length} chars)`)

  const userTokenAccount = getAssociatedTokenAddressSync(
    TXL_TOKEN_MINT,
    wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  )
  if (!(await connection.getAccountInfo(userTokenAccount))) {
    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        userTokenAccount,
        wallet.publicKey,
        TXL_TOKEN_MINT,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    )
    const ataSig = await provider.sendAndConfirm(createAtaTx)
    console.log(`ATA created: ${ataSig}`)
  }

  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('token_treasury_v2')],
    program.programId
  )
  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    TXL_TOKEN_MINT,
    tokenTreasuryPda,
    true,
    TOKEN_2022_PROGRAM_ID
  )

  console.log(`Subscribing: service level ${SERVICE_LEVEL_ID}, ${DURATION_WEEKS} weeks…`)
  const txSig = await program.methods
    .subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)
    .accounts({
      user: wallet.publicKey,
      pricingMatrix: pricingMatrixPda,
      tokenMint: TXL_TOKEN_MINT,
      userTokenAccount,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc()
  console.log(`Subscribe transaction confirmed: ${txSig}`)

  const message = buildActivationMessage(txSig, SELECTED_LEAGUES, jwt)
  const signature = nacl.sign.detached(new TextEncoder().encode(message), wallet.secretKey)
  const walletSignature = Buffer.from(signature).toString('base64')

  const apiToken = await activateToken(txSig, jwt, SELECTED_LEAGUES, walletSignature)

  console.log('\nAPI token acquired:')
  console.log(apiToken)
  upsertEnv({ TXLINE_GUEST_JWT: jwt, TXLINE_API_TOKEN: apiToken })
  console.log(`\nSaved TXLINE_GUEST_JWT and TXLINE_API_TOKEN to ${ENV_PATH}`)
}

main().catch((err: unknown) => {
  console.error('\nActivation failed:', err)
  process.exitCode = 1
})
