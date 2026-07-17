import assert from 'node:assert/strict'
import { timingSafeEqual } from 'node:crypto'
import { SignalDetector } from '../src/lib/signal-detector'
import { signWebhookBody } from '../src/lib/subscribers'
import { MATCH_WINNER_MARKET } from '../src/lib/txline/normalize'
import type { MatchEvent, MatchState, OddsEvent } from '../src/lib/txline/types'
import type { SignalDefinition } from '../src/types'

const T = 1_784_000_000_000
const definition: SignalDefinition = {
  id: 'unit-test',
  name: 'POST_EVENT_PROB_SHOCK',
  description: 'deterministic engine test',
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
    matchId: 'unit-match',
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
  return { type: 'red_card', matchId: 'unit-match', timestamp: ts, team: 'home', minute: 60, data: {}, raw: {} }
}

function odds(ts: number, home: number, away: number): OddsEvent {
  return {
    matchId: 'unit-match',
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

function run(): void {
  const detector = new SignalDetector(definition)
  detector.onOddsEvent(odds(T, 0.55, 0.25))
  detector.onMatchEvent(trigger(T + 10_123), state())
  const fires = detector.onOddsEvent(odds(T + 85_434, 0.3, 0.48))
  assert.deepEqual(fires.map((fire) => fire.position), ['long_away', 'short_away'])
  assert.equal(fires.every((fire) => Number.isInteger(fire.windowSeconds)), true)
  assert.equal(fires.every((fire) => fire.windowSeconds === 75), true)

  const below = new SignalDetector(definition)
  below.onOddsEvent(odds(T, 0.3, 0.35))
  below.onMatchEvent(trigger(T + 10_000), state())
  assert.equal(below.onOddsEvent(odds(T + 70_000, 0.28, 0.44)).length, 0)

  const restarted = new SignalDetector(definition)
  restarted.seedState('unit-match', state())
  restarted.seedOdds('unit-match', { homeProb: 0.55, awayProb: 0.25, timestamp: T })
  restarted.seedTrigger('unit-match', { type: 'red_card', team: 'home', ts: T + 10_000, minute: 60 })
  restarted.seedCooldown('unit-match', T + 300_000)
  assert.equal(restarted.onOddsEvent(odds(T + 90_000, 0.2, 0.6)).length, 0)

  const recovered = new SignalDetector(definition)
  recovered.onOddsEvent(odds(T, 0.55, 0.25))
  recovered.onMatchEvent(trigger(T + 10_000), state(), true)
  const recoveredFires = recovered.onOddsEvent(odds(T + 70_000, 0.3, 0.48))
  assert.equal(recoveredFires.every((fire) => fire.recoveredFromSnapshot), true)

  const body = JSON.stringify({ delivery_id: 'signal:event:subscriber', value: 42 })
  const expected = signWebhookBody(body, 'secret')
  const received = signWebhookBody(body, 'secret')
  const tampered = signWebhookBody(`${body} `, 'secret')
  assert.equal(timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex')), true)
  assert.equal(timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(tampered, 'hex')), false)

  console.log('PASS engine: threshold, positions, integer window, cooldown, recovery, and exact-body HMAC')
}

run()
