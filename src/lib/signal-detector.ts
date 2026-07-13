/**
 * Dual-strategy signal detection.
 *
 * All three registered conditions must hold on an incoming full-match 1X2
 * odds tick:
 *   1. the now-favoured team's probability rose more than deltaThreshold
 *      within the last windowSeconds,
 *   2. a registered trigger event (goal/red_card) occurred within the last
 *      lookbackSeconds,
 *   3. immediately before that trigger the now-favoured team's probability
 *      was below preEventProbCap.
 *
 * On a fire, BOTH strategies are produced simultaneously from the same
 * observation: Strategy A goes long the favoured team, Strategy B goes short
 * (the inverse) — so the on-chain ledger can compare which approach performs
 * better across the tournament without re-running detection twice.
 *
 * A cooldownSeconds gate (reset at half-time/full-time) prevents a goal
 * immediately followed by a card from producing signal clusters.
 *
 * All windows are measured in EVENT time, not wall time, so this detector
 * evaluates identically whether fed by the live stream or a replay.
 */

import type { EventType, MatchEvent, MatchState, OddsEvent } from './txline/types'
import { MATCH_WINNER_MARKET } from './txline/normalize'
import type { OddsWindow, Position, SignalDefinition, Strategy, VeilleSignal } from '../types'

const TRIGGER_EVENTS = new Set(['goal', 'red_card'])
const HALF_FULL_TIME_PHASES = new Set(['HT', 'F', 'FET', 'FPE'])

interface LastTrigger {
  type: EventType
  team: 'home' | 'away'
  ts: number
  minute: number
}

interface MatchTracker {
  homeWindow: OddsWindow[]
  awayWindow: OddsWindow[]
  lastTrigger: LastTrigger | null
  cooldownUntil: number
  state: MatchState | null
}

function buildSignal(
  strategy: Strategy,
  favouredTeam: 'home' | 'away',
  delta: number,
  windowSeconds: number,
  preEvent: OddsWindow,
  event: OddsEvent,
  trigger: LastTrigger,
  state: MatchState,
  signalRegistryId: string
): VeilleSignal {
  const position: Position =
    strategy === 'A'
      ? favouredTeam === 'home'
        ? 'long_home'
        : 'long_away'
      : favouredTeam === 'home'
        ? 'short_home'
        : 'short_away'

  return {
    signalRegistryId,
    strategy,
    matchId: event.matchId,
    homeTeam: state.homeTeam,
    awayTeam: state.awayTeam,
    triggerEvent: trigger.type,
    triggerMinute: trigger.minute,
    preEventHomeProb: favouredTeam === 'home' ? preEvent.prob : event.homeProb,
    preEventAwayProb: favouredTeam === 'away' ? preEvent.prob : event.awayProb,
    postSignalHomeProb: event.homeProb,
    postSignalAwayProb: event.awayProb,
    delta,
    windowSeconds,
    favouredTeam,
    position,
    recoveredFromSnapshot: false,
    onchainStatus: 'pending',
    subscribersNotified: 0,
    subscribersFailed: 0,
    firedAt: event.timestamp,
  }
}

export class SignalDetector {
  private readonly def: SignalDefinition
  private readonly matches = new Map<string, MatchTracker>()

  constructor(def: SignalDefinition) {
    this.def = def
  }

  private tracker(matchId: string): MatchTracker {
    let t = this.matches.get(matchId)
    if (!t) {
      t = { homeWindow: [], awayWindow: [], lastTrigger: null, cooldownUntil: 0, state: null }
      this.matches.set(matchId, t)
    }
    return t
  }

  /** Baseline the detector from an existing MatchState (mid-match / recovery attach). */
  seedState(matchId: string, state: MatchState): void {
    this.tracker(matchId).state = state
  }

  /** Restore last-known trigger context after a process restart (from veille_match_state). */
  seedTrigger(matchId: string, trigger: { type: EventType; team: 'home' | 'away'; ts: number; minute: number }): void {
    this.tracker(matchId).lastTrigger = trigger
  }

  hasTracker(matchId: string): boolean {
    return this.matches.has(matchId)
  }

  /** Feed a normalized scores-stream event. Tracks triggers and cooldown resets. */
  onMatchEvent(event: MatchEvent, state: MatchState): void {
    const t = this.tracker(event.matchId)
    t.state = state

    if (TRIGGER_EVENTS.has(event.type) && event.team) {
      t.lastTrigger = { type: event.type, team: event.team, ts: event.timestamp, minute: event.minute }
    }

    if (event.type === 'phase_change') {
      const phase = event.data.phase
      if (typeof phase === 'string' && HALF_FULL_TIME_PHASES.has(phase)) {
        t.cooldownUntil = 0
      }
    }
  }

  /**
   * Feed a normalized full-match 1X2 odds tick. Returns zero or two
   * VeilleSignal objects (Strategy A + B) if this tick completes a fire.
   */
  onOddsEvent(event: OddsEvent): VeilleSignal[] {
    if (event.market !== MATCH_WINNER_MARKET) return []
    const t = this.tracker(event.matchId)
    const now = event.timestamp

    const horizonMs = (this.def.windowSeconds + this.def.lookbackSeconds + 60) * 1000
    const cutoff = now - horizonMs
    t.homeWindow.push({ prob: event.homeProb, timestamp: now })
    t.awayWindow.push({ prob: event.awayProb, timestamp: now })
    t.homeWindow = t.homeWindow.filter((w) => w.timestamp >= cutoff)
    t.awayWindow = t.awayWindow.filter((w) => w.timestamp >= cutoff)

    if (!t.state || !t.lastTrigger) return []
    if (now < t.cooldownUntil) return []

    // Trigger event must be within lookback.
    if (now - t.lastTrigger.ts > this.def.lookbackSeconds * 1000) return []

    const windowStartMs = now - this.def.windowSeconds * 1000
    const check = (
      window: OddsWindow[],
      currentProb: number,
      opponentProb: number
    ): { delta: number; windowSeconds: number; preEvent: OddsWindow } | null => {
      // Must actually be the favourite after the move, not just have risen.
      if (currentProb <= opponentProb) return null

      const baseline = window.find((w) => w.timestamp >= windowStartMs && w.timestamp < now)
      if (!baseline) return null
      const delta = currentProb - baseline.prob
      if (delta <= this.def.deltaThreshold) return null

      const preEvent = [...window].reverse().find((w) => w.timestamp < t.lastTrigger!.ts)
      if (!preEvent || preEvent.prob >= this.def.preEventProbCap) return null

      return { delta, windowSeconds: (now - baseline.timestamp) / 1000, preEvent }
    }

    const homeResult = check(t.homeWindow, event.homeProb, event.awayProb)
    const result = homeResult ?? check(t.awayWindow, event.awayProb, event.homeProb)
    if (!result) return []
    const favouredTeam: 'home' | 'away' = homeResult ? 'home' : 'away'

    t.cooldownUntil = now + this.def.cooldownSeconds * 1000

    return (['A', 'B'] as Strategy[]).map((strategy) =>
      buildSignal(
        strategy,
        favouredTeam,
        result.delta,
        result.windowSeconds,
        result.preEvent,
        event,
        t.lastTrigger!,
        t.state!,
        this.def.id
      )
    )
  }

  reset(matchId: string): void {
    this.matches.delete(matchId)
  }
}
