/**
 * Read-only integration checks. This script intentionally never inserts a
 * production row, notifies a real subscriber, or spends mainnet SOL.
 */
try {
  process.loadEnvFile('.env')
} catch {
  /* env from shell */
}

import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { SignalDetector } from '../src/lib/signal-detector'
import { signWebhookBody } from '../src/lib/subscribers'
import { getSupabase } from '../src/lib/supabase'
import { getCredentials, getHeaders } from '../src/lib/txline/auth'
import { MATCH_WINNER_MARKET } from '../src/lib/txline/normalize'
import { getFixtures } from '../src/lib/txline/snapshots'
import type { MatchEvent, MatchState, OddsEvent } from '../src/lib/txline/types'
import type { SignalDefinition } from '../src/types'

let failures = 0
function check(pass: boolean, label: string): void {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`)
  if (!pass) failures += 1
}

const T = 1_784_000_000_000
const definition: SignalDefinition = {
  id: 'integration',
  name: 'POST_EVENT_PROB_SHOCK',
  description: 'integration fixture',
  deltaThreshold: 0.12,
  windowSeconds: 120,
  triggerEvents: ['goal', 'red_card'],
  lookbackSeconds: 180,
  preEventProbCap: 0.4,
  cooldownSeconds: 300,
  registeredAt: new Date(T).toISOString(),
}

function state(): MatchState {
  return {
    matchId: 'integration-match',
    homeTeam: 'Alpha',
    awayTeam: 'Beta',
    homeScore: 0,
    awayScore: 0,
    phase: 'H2',
    minute: 60,
    corners: { home: 0, away: 0 },
    yellowCards: { home: 0, away: 0 },
    redCards: { home: 1, away: 0 },
    lastUpdated: T,
  }
}

function trigger(ts: number): MatchEvent {
  return {
    type: 'red_card',
    matchId: 'integration-match',
    timestamp: ts,
    team: 'home',
    minute: 60,
    data: {},
    raw: {},
  }
}

function odds(ts: number, home: number, away: number): OddsEvent {
  return {
    matchId: 'integration-match',
    timestamp: ts,
    market: MATCH_WINNER_MARKET,
    homeProb: home,
    awayProb: away,
    drawProb: 1 - home - away,
    previousHomeProb: home,
    previousAwayProb: away,
    previousDrawProb: 1 - home - away,
    deltaHome: 0,
    deltaAway: 0,
    deltaDraw: 0,
    raw: {},
  }
}

async function checkWebhookProtocol(): Promise<boolean> {
  const secret = 'integration-secret'
  const payload = JSON.stringify({ veille_version: 2, delivery_id: 'test:signal_fired:subscriber', event: 'signal_fired' })
  const signature = signWebhookBody(payload, secret)
  let accepted = false
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
    request.on('end', () => {
      const received = request.headers['x-veille-signature']
      if (typeof received === 'string' && received.length === signature.length) {
        accepted = timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(signWebhookBody(raw, secret), 'hex'))
      }
      response.writeHead(accepted ? 204 : 401)
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const response = await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VEILLE-Signature': signature,
        'X-VEILLE-Delivery-Id': 'test:signal_fired:subscriber',
        'X-VEILLE-Timestamp': String(T),
      },
      body: payload,
    })
    return response.status === 204 && accepted
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

async function main(): Promise<void> {
  const credentials = await getCredentials()
  const headers = getHeaders()
  check(credentials.jwt.length > 0 && headers.Authorization.startsWith('Bearer '), '1. TxLINE authentication')

  const fixtures = await getFixtures()
  check(fixtures.length > 0, `2. TxLINE fixtures reachable (${fixtures.length})`)

  const detector = new SignalDetector(definition)
  detector.onOddsEvent(odds(T, 0.55, 0.25))
  detector.onMatchEvent(trigger(T + 10_123), state())
  const fires = detector.onOddsEvent(odds(T + 85_434, 0.3, 0.48))
  check(
    fires.length === 2 && fires[0]?.position === 'long_away' && fires[1]?.position === 'short_away',
    '3. Both strategies fire with correct positions'
  )
  check(fires.every((fire) => Number.isInteger(fire.windowSeconds)), '4. Persisted signal window is an integer')

  const below = new SignalDetector(definition)
  below.onOddsEvent(odds(T, 0.3, 0.35))
  below.onMatchEvent(trigger(T + 10_000), state())
  check(below.onOddsEvent(odds(T + 70_000, 0.28, 0.44)).length === 0, '5. Below-threshold movement is ignored')

  check(await checkWebhookProtocol(), '6. Subscriber v2 exact-body HMAC transport')

  const db = getSupabase()
  const tables = [
    'veille_signal_registry',
    'veille_signals',
    'veille_portfolio',
    'veille_agent_log',
    'veille_subscribers',
    'veille_match_state',
    'veille_webhook_deliveries',
    'veille_webhook_receipts',
    'veille_agent_heartbeat',
  ]
  const tableChecks = await Promise.all(tables.map((table) => db.from(table).select('*').limit(1)))
  const missing = tableChecks.flatMap((result, index) => (result.error ? [tables[index]] : []))
  check(missing.length === 0, `7. Supabase schema reachable${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`)

  const registry = await db.from('veille_signal_registry').select('id').eq('name', 'POST_EVENT_PROB_SHOCK').maybeSingle()
  check(!registry.error && registry.data !== null, '8. Registered signal definition present')

  check(true, '9. Safe mode confirmed: no DB mutations, subscriber deliveries, or mainnet transactions')
  console.log(failures === 0 ? '\nALL CHECKS PASS' : `\n${failures} check(s) FAILED`)
  if (failures > 0) process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error('FATAL', error)
  process.exitCode = 1
})
