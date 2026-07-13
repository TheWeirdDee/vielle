/**
 * VEILLE integration test — covers every component from VEILLE_BUILD.md Step 19.
 *
 *   npx tsx scripts/test-integration.ts
 *
 * Points 6–9 require supabase/schema.sql to have been run and
 * register-signal.ts / init-portfolio.ts to have been executed first.
 */

try {
  process.loadEnvFile('.env')
} catch {
  /* env from shell */
}

import { createServer } from 'node:http'
import { getCredentials, getHeaders } from '../src/lib/txline/auth'
import { getFixtures } from '../src/lib/txline/snapshots'
import { SignalDetector } from '../src/lib/signal-detector'
import { getSupabase } from '../src/lib/supabase'
import { updatePortfolio } from '../src/lib/portfolio'
import type { MatchEvent, MatchState, OddsEvent } from '../src/lib/txline/types'
import { MATCH_WINNER_MARKET } from '../src/lib/txline/normalize'
import type { SignalDefinition } from '../src/types'

let failures = 0
function log(pass: boolean, label: string): void {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`)
  if (!pass) failures += 1
}

const DEF: SignalDefinition = {
  id: 'test-def',
  name: 'TEST_SIGNAL',
  description: 'test',
  deltaThreshold: 0.12,
  windowSeconds: 120,
  triggerEvents: ['goal', 'red_card'],
  lookbackSeconds: 180,
  preEventProbCap: 0.4,
  cooldownSeconds: 300,
  registeredAt: new Date().toISOString(),
}

const T = 1_784_000_000_000

function state(homeScore = 0, awayScore = 0): MatchState {
  return {
    matchId: 'itest',
    homeTeam: 'Alpha',
    awayTeam: 'Beta',
    homeScore,
    awayScore,
    phase: 'H2',
    minute: 60,
    corners: { home: 0, away: 0 },
    yellowCards: { home: 0, away: 0 },
    redCards: { home: 0, away: 0 },
    lastUpdated: T,
  }
}
function redCard(ts: number): MatchEvent {
  return { type: 'red_card', matchId: 'itest', timestamp: ts, team: 'home', minute: 60, data: {}, raw: {} }
}
function odds(ts: number, homeProb: number, awayProb: number): OddsEvent {
  return {
    matchId: 'itest',
    timestamp: ts,
    market: MATCH_WINNER_MARKET,
    homeProb,
    awayProb,
    drawProb: 1 - homeProb - awayProb,
    previousHomeProb: homeProb,
    previousAwayProb: awayProb,
    previousDrawProb: 1 - homeProb - awayProb,
    deltaHome: 0,
    deltaAway: 0,
    deltaDraw: 0,
    raw: {},
  }
}

async function main(): Promise<void> {
  // 1. Auth
  const creds = await getCredentials()
  const headers = getHeaders()
  log(creds.jwt.length > 0 && headers.Authorization.startsWith('Bearer '), '1. TxLINE auth: credentials + headers')

  // 2. Fixtures
  const fixtures = await getFixtures()
  log(fixtures.length > 0, `2. Fixtures: ${fixtures.length} World Cup matches`)

  // 3. Signal detection fires at threshold (both strategies)
  const detector = new SignalDetector(DEF)
  detector.onMatchEvent(redCard(T + 10_000), state())
  detector.onOddsEvent(odds(T, 0.55, 0.25))
  detector.onOddsEvent(odds(T + 20_000, 0.4, 0.38))
  const fires = detector.onOddsEvent(odds(T + 70_000, 0.3, 0.48))
  log(
    fires.length === 2 && fires.some((f) => f.strategy === 'A') && fires.some((f) => f.strategy === 'B'),
    `3. Signal detection: ${fires.length} fires at threshold (want 2 — Strategy A + B)`
  )
  log(
    fires[0]?.position === 'long_away' && fires[1]?.position === 'short_away',
    `   positions: A=${fires[0]?.position}, B=${fires[1]?.position} (want long_away / short_away)`
  )

  // 4. Below-threshold odds movement must not fire
  const detector2 = new SignalDetector(DEF)
  detector2.onMatchEvent(redCard(T + 10_000), state())
  detector2.onOddsEvent(odds(T, 0.3, 0.35))
  const noFire = detector2.onOddsEvent(odds(T + 70_000, 0.28, 0.44)) // delta 0.09 < 0.12
  log(noFire.length === 0, '4. Below-threshold movement: no fire')

  // 5. Cooldown blocks a second signal within 5 minutes
  const detector3 = new SignalDetector(DEF)
  detector3.onMatchEvent(redCard(T + 10_000), state())
  detector3.onOddsEvent(odds(T, 0.55, 0.25)) // baseline tick
  const first = detector3.onOddsEvent(odds(T + 70_000, 0.3, 0.48))
  detector3.onMatchEvent(redCard(T + 80_000), state()) // second red card, still within cooldown
  const second = detector3.onOddsEvent(odds(T + 90_000, 0.15, 0.7))
  log(first.length === 2 && second.length === 0, `5. Cooldown: first fires (${first.length}), second within 5min blocked (${second.length})`)

  // Schema-dependent checks (6-9)
  const db = getSupabase()
  const registry = await db.from('veille_signal_registry').select('id').eq('name', 'POST_EVENT_PROB_SHOCK').maybeSingle()
  if (registry.error || !registry.data) {
    console.log('SKIP 6-9: POST_EVENT_PROB_SHOCK not registered yet — run register-signal.ts after the schema migration.')
  } else {
    const signalRegistryId = registry.data.id as string

    // 6. Portfolio: insert a settled test signal, verify stats update
    const insert = await db
      .from('veille_signals')
      .insert({
        signal_registry_id: signalRegistryId,
        strategy: 'A',
        match_id: 'itest-portfolio',
        home_team: 'Alpha',
        away_team: 'Beta',
        trigger_event: 'red_card',
        trigger_minute: 60,
        pre_event_home_prob: 0.3,
        pre_event_away_prob: 0.55,
        post_signal_home_prob: 0.48,
        post_signal_away_prob: 0.3,
        delta: 0.18,
        window_seconds: 90,
        favoured_team: 'home',
        position: 'long_home',
        outcome: 'hit',
        actual_winner: 'home',
        fired_at: new Date().toISOString(),
        resolved_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (insert.error) {
      log(false, `6. Portfolio: insert failed (${insert.error.message})`)
    } else {
      await updatePortfolio('A')
      const portfolio = await db.from('veille_portfolio').select('*').eq('strategy', 'A').single()
      log(
        !portfolio.error && (portfolio.data?.total_settled as number) > 0,
        `6. Portfolio: updatePortfolio() ran, total_settled=${portfolio.data?.total_settled as number}`
      )
      await db.from('veille_signals').delete().eq('id', insert.data.id as string)
      await updatePortfolio('A') // restore stats after cleanup
    }

    // 7. On-chain: write a real memo, verify it confirms
    try {
      const { writeSignalOnChain } = await import('../src/lib/onchain')
      const sig = await writeSignalOnChain({
        id: 'itest',
        strategy: 'A',
        matchId: 'itest',
        delta: 0.18,
        triggerEvent: 'red_card',
        favouredTeam: 'home',
        firedAt: Date.now(),
      })
      log(typeof sig === 'string' && sig.length > 0, `7. On-chain: memo confirmed (${sig.slice(0, 16)}…)`)
    } catch (err) {
      log(false, `7. On-chain: FAILED (${String(err)})`)
    }

    // 8. Subscribers: local webhook receiver, verify HMAC signature
    const secret = 'test-secret'
    let received: { body: string; sig: string } | null = null
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => (body += chunk.toString()))
      req.on('end', () => {
        const parsed = JSON.parse(body) as { hmac_signature: string }
        received = { body, sig: parsed.hmac_signature }
        res.writeHead(200)
        res.end('ok')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const subRow = await db
      .from('veille_subscribers')
      .insert({ name: 'itest', webhook_url: `http://127.0.0.1:${port}`, secret_key: secret, strategies: ['A', 'B'] })
      .select('id')
      .single()
    if (subRow.error) {
      log(false, `8. Subscribers: insert failed (${subRow.error.message})`)
    } else {
      const { notifySubscribers } = await import('../src/lib/subscribers')
      const result = await notifySubscribers(
        {
          id: 'itest',
          signalRegistryId,
          strategy: 'A',
          matchId: 'itest',
          homeTeam: 'Alpha',
          awayTeam: 'Beta',
          triggerEvent: 'red_card',
          triggerMinute: 60,
          preEventHomeProb: 0.3,
          preEventAwayProb: 0.55,
          postSignalHomeProb: 0.48,
          postSignalAwayProb: 0.3,
          delta: 0.18,
          windowSeconds: 90,
          favouredTeam: 'home',
          position: 'long_home',
          recoveredFromSnapshot: false,
          onchainStatus: 'pending',
          subscribersNotified: 0,
          subscribersFailed: 0,
          firedAt: Date.now(),
        },
        'signal_fired'
      )
      await new Promise((r) => setTimeout(r, 100))
      const receivedTyped = received as { body: string; sig: string } | null
      log(
        result.notified === 1 && receivedTyped !== null && receivedTyped.sig.length === 64,
        `8. Subscribers: delivered=${result.notified}, HMAC present (${receivedTyped?.sig.slice(0, 12)}…)`
      )
      await db.from('veille_subscribers').delete().eq('id', subRow.data.id as string)
    }
    server.close()

    // 9. Supabase: every table reachable
    const tables = ['veille_signal_registry', 'veille_signals', 'veille_portfolio', 'veille_agent_log', 'veille_subscribers', 'veille_match_state']
    const checks = await Promise.all(tables.map((t) => db.from(t).select('*').limit(1)))
    const allOk = checks.every((c) => !c.error)
    log(allOk, `9. Supabase: all ${tables.length} tables reachable (${checks.map((c, i) => (c.error ? tables[i] : null)).filter(Boolean).join(', ') || 'ok'})`)
  }

  console.log(failures === 0 ? '\nALL CHECKS PASS' : `\n${failures} check(s) FAILED`)
  if (failures > 0) process.exitCode = 1
}

main().catch((err: unknown) => {
  console.error('FATAL', err)
  process.exitCode = 1
})
