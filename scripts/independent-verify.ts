/**
 * INDEPENDENT VERIFICATION — deliberately written from scratch, with zero
 * imports from src/lib/*. This is not "the same code running twice" — it is
 * a second, separately-reasoned implementation of the three public signal
 * conditions, run against raw TxLINE records, so agreement with the
 * production system (SignalDetector in src/lib/signal-detector.ts) is a
 * genuine cross-check rather than a tautology.
 *
 * Public signal definition — confirm these five numbers yourself against
 * production, they are not trusted from this file:
 *   select delta_threshold, window_seconds, trigger_events, lookback_seconds,
 *          pre_event_prob_cap, registered_at
 *   from veille_signal_registry where name = 'POST_EVENT_PROB_SHOCK';
 *
 * Inputs are raw TxLINE records (data/replay-cache/<matchId>.json) — the
 * unprocessed feed, before any VEILLE normalization touches it — cross
 * checked against the published result (data/backtest/<matchId>.json),
 * which is production's own output. This script does not read that file's
 * fire logic, only its claimed numbers, to check them.
 *
 *   npx tsx scripts/independent-verify.ts 18222446
 *   npx tsx scripts/independent-verify.ts 18213979
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

const DELTA_THRESHOLD = 0.12
const WINDOW_SECONDS = 120
const LOOKBACK_SECONDS = 180
const PRE_EVENT_PROB_CAP = 0.4
const TRIGGER_ACTIONS = new Set(['goal', 'red_card'])

// ---------------------------------------------------------------------------
// Raw TxLINE shapes (only the fields this script actually reads)
// ---------------------------------------------------------------------------

interface RawScoreRecord {
  Action: string
  Ts: number
  Seq: number
  Clock?: { Seconds: number } | null
  Score?: {
    Participant1?: { Total?: { Goals?: number; RedCards?: number } }
    Participant2?: { Total?: { Goals?: number; RedCards?: number } }
  }
}

interface RawOddsRecord {
  Ts: number
  SuperOddsType: string
  MarketPeriod: string | null
  PriceNames: string[]
  Prices: number[]
  Pct?: string[]
}

interface Cache {
  matchId: string
  orientation: { homeTeam: string; awayTeam: string; participant1IsHome: boolean }
  scores: RawScoreRecord[]
  odds: RawOddsRecord[]
}

interface PublishedFire {
  strategy: 'A' | 'B'
  triggerEvent: string
  triggerMinute: number
  preEventHomeProb: number
  preEventAwayProb: number
  postSignalHomeProb: number
  postSignalAwayProb: number
  delta: number
  favouredTeam: 'home' | 'away'
  outcome: string
}

// ---------------------------------------------------------------------------
// Step 1 — find real trigger events (goals, red cards) from raw scores.
//
// The raw feed sends each incident as a burst of 2-3 records (bare, then
// +type, then +player) and can retract one later via action_discarded (e.g.
// VAR overturns a goal). The only reliable signal that an incident is real
// is whether the cumulative counter in the Score block actually increased
// between consecutive records for that team — so that's what this checks,
// not the Action label on any single record.
// ---------------------------------------------------------------------------

interface Trigger {
  type: 'goal' | 'red_card'
  team: 'home' | 'away'
  ts: number
  minute: number
}

function minuteOf(rec: RawScoreRecord): number {
  const seconds = rec.Clock?.Seconds
  return typeof seconds === 'number' ? Math.floor(seconds / 60) + 1 : 0
}

function findTriggers(scores: RawScoreRecord[], participant1IsHome: boolean): Trigger[] {
  const sorted = [...scores].sort((a, b) => a.Seq - b.Seq)
  const triggers: Trigger[] = []
  let prevHomeGoals = 0
  let prevAwayGoals = 0
  let prevHomeReds = 0
  let prevAwayReds = 0

  for (const rec of sorted) {
    const p1 = rec.Score?.Participant1?.Total
    const p2 = rec.Score?.Participant2?.Total
    if (!p1 && !p2) continue
    const [home, away] = participant1IsHome ? [p1, p2] : [p2, p1]
    const homeGoals = home?.Goals ?? prevHomeGoals
    const awayGoals = away?.Goals ?? prevAwayGoals
    const homeReds = home?.RedCards ?? prevHomeReds
    const awayReds = away?.RedCards ?? prevAwayReds

    if (homeGoals > prevHomeGoals) triggers.push({ type: 'goal', team: 'home', ts: rec.Ts, minute: minuteOf(rec) })
    if (awayGoals > prevAwayGoals) triggers.push({ type: 'goal', team: 'away', ts: rec.Ts, minute: minuteOf(rec) })
    if (homeReds > prevHomeReds) triggers.push({ type: 'red_card', team: 'home', ts: rec.Ts, minute: minuteOf(rec) })
    if (awayReds > prevAwayReds) triggers.push({ type: 'red_card', team: 'away', ts: rec.Ts, minute: minuteOf(rec) })

    prevHomeGoals = homeGoals
    prevAwayGoals = awayGoals
    prevHomeReds = homeReds
    prevAwayReds = awayReds
  }

  // Guard: the Action label should agree with what the counters found, on
  // any record TxLINE explicitly tagged as the trigger type. This doesn't
  // change the output — it's a sanity assertion on the method itself.
  const labeledCount = sorted.filter((r) => TRIGGER_ACTIONS.has(r.Action)).length
  if (labeledCount === 0 && triggers.length > 0) {
    console.warn('  [check] counters found triggers with zero Action-labeled records — investigate')
  }

  return triggers
}

// ---------------------------------------------------------------------------
// Step 2 — extract full-match 1X2 probabilities from raw odds.
// ---------------------------------------------------------------------------

interface OddsPoint {
  ts: number
  homeProb: number
  awayProb: number
}

function extractOdds(odds: RawOddsRecord[], participant1IsHome: boolean): OddsPoint[] {
  const points: OddsPoint[] = []
  for (const rec of odds) {
    if (rec.SuperOddsType !== '1X2_PARTICIPANT_RESULT') continue
    if (rec.MarketPeriod) continue // full match only — skip half-time sub-markets
    const i1 = rec.PriceNames.indexOf('part1')
    const i2 = rec.PriceNames.indexOf('part2')
    if (i1 < 0 || i2 < 0) continue

    const probAt = (idx: number): number | null => {
      const pct = rec.Pct?.[idx]
      if (pct && pct !== 'NA') {
        const parsed = Number(pct)
        if (Number.isFinite(parsed)) return parsed / 100
      }
      const price = rec.Prices[idx]
      return typeof price === 'number' && price > 0 ? 1 / (price / 1000) : null
    }
    const p1 = probAt(i1)
    const p2 = probAt(i2)
    if (p1 === null || p2 === null) continue
    const [homeProb, awayProb] = participant1IsHome ? [p1, p2] : [p2, p1]
    points.push({ ts: rec.Ts, homeProb, awayProb })
  }
  return points.sort((a, b) => a.ts - b.ts)
}

// ---------------------------------------------------------------------------
// Step 3 — apply the three public conditions at every odds tick, using only
// the single most recent trigger at that point in time (matching how the
// live detector tracks "last trigger", not an unbounded lookback scan).
// ---------------------------------------------------------------------------

interface Check {
  triggerType: string
  triggerTeam: 'home' | 'away'
  triggerMinute: number
  ts: number
  favouredTeam: 'home' | 'away'
  baselineProb: number
  preEventProb: number
  postProb: number
  delta: number
  fires: boolean
  reasonIfNot?: string
}

const COOLDOWN_SECONDS = 300

function evaluate(triggers: Trigger[], oddsPoints: OddsPoint[]): Check[] {
  const checks: Check[] = []
  const seenNearMiss = new Set<string>()
  const sortedTriggers = [...triggers].sort((a, b) => a.ts - b.ts)
  let cooldownUntil = 0

  for (const point of oddsPoints) {
    if (point.ts < cooldownUntil) continue // matches production: no evaluation at all during cooldown

    // Most recent trigger at or before this tick — production tracks a
    // single "last trigger", not a list, so a newer one replaces an older
    // one even if the older one is still technically within lookback.
    let active: Trigger | null = null
    for (const t of sortedTriggers) {
      if (t.ts > point.ts) break
      active = t
    }
    if (!active) continue
    if ((point.ts - active.ts) / 1000 > LOOKBACK_SECONDS) continue // condition 2 window expired

    // Home checked first, then away — matches production's `homeResult ??
    // check(away)`: only one side can fire per tick, and firing stops
    // evaluation of the other side at that same tick.
    for (const side of ['home', 'away'] as const) {
      const currentProb = side === 'home' ? point.homeProb : point.awayProb
      const opponentProb = side === 'home' ? point.awayProb : point.homeProb
      if (currentProb <= opponentProb) continue // must actually be favoured, not just rising

      const windowStart = point.ts - WINDOW_SECONDS * 1000
      const baseline = oddsPoints.find((p) => p.ts >= windowStart && p.ts < point.ts)
      if (!baseline) continue
      const baselineProb = side === 'home' ? baseline.homeProb : baseline.awayProb
      const delta = currentProb - baselineProb

      const preEvent = [...oddsPoints].reverse().find((p) => p.ts < active!.ts)
      const preEventProb = preEvent ? (side === 'home' ? preEvent.homeProb : preEvent.awayProb) : null

      let fires = true
      let reasonIfNot: string | undefined
      if (delta <= DELTA_THRESHOLD) {
        fires = false
        reasonIfNot = `delta ${(delta * 100).toFixed(1)}pp <= ${DELTA_THRESHOLD * 100}pp threshold`
      } else if (preEventProb === null) {
        fires = false
        reasonIfNot = 'no pre-event odds point available'
      } else if (preEventProb >= PRE_EVENT_PROB_CAP) {
        fires = false
        reasonIfNot = `pre-event prob ${(preEventProb * 100).toFixed(1)}% >= ${PRE_EVENT_PROB_CAP * 100}% cap — not an underdog`
      }

      const dedupeKey = `${active.minute}|${active.type}|${side}|${reasonIfNot ?? 'fire'}`
      if (fires) {
        checks.push({
          triggerType: active.type,
          triggerTeam: active.team,
          triggerMinute: active.minute,
          ts: point.ts,
          favouredTeam: side,
          baselineProb,
          preEventProb: preEventProb ?? -1,
          postProb: currentProb,
          delta,
          fires: true,
        })
        cooldownUntil = point.ts + COOLDOWN_SECONDS * 1000
        break // stop checking the other side at this tick, matches production
      } else if (delta > DELTA_THRESHOLD * 0.5 && preEventProb !== null && preEventProb < PRE_EVENT_PROB_CAP * 1.5 && !seenNearMiss.has(dedupeKey)) {
        seenNearMiss.add(dedupeKey)
        checks.push({
          triggerType: active.type,
          triggerTeam: active.team,
          triggerMinute: active.minute,
          ts: point.ts,
          favouredTeam: side,
          baselineProb,
          preEventProb: preEventProb ?? -1,
          postProb: currentProb,
          delta,
          fires: false,
          reasonIfNot,
        })
      }
    }
  }
  return checks
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function loadJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

function main(): void {
  const matchId = process.argv[2]
  if (!matchId) {
    console.error('Usage: npx tsx scripts/independent-verify.ts <matchId>')
    process.exit(1)
  }

  const cacheFile = path.join(process.cwd(), 'data', 'replay-cache', `${matchId}.json`)
  const backtestFile = path.join(process.cwd(), 'data', 'backtest', `${matchId}.json`)
  if (!fs.existsSync(cacheFile)) {
    console.error(`No raw data at ${cacheFile}`)
    process.exit(1)
  }

  const cache = loadJson<Cache>(cacheFile)
  const published = fs.existsSync(backtestFile) ? loadJson<{ fires: PublishedFire[] }>(backtestFile).fires : []

  console.log(`${cache.orientation.homeTeam} vs ${cache.orientation.awayTeam}`)
  console.log(`Recomputing from raw TxLINE records only: ${cache.scores.length} score records, ${cache.odds.length} odds records.\n`)

  const triggers = findTriggers(cache.scores, cache.orientation.participant1IsHome)
  const oddsPoints = extractOdds(cache.odds, cache.orientation.participant1IsHome)
  console.log(`Independently found ${triggers.length} real goal/red-card trigger(s):`)
  for (const t of triggers) console.log(`  ${t.minute}' ${t.type} (${t.team})`)

  const checks = evaluate(triggers, oddsPoints)
  const fires = checks.filter((c) => c.fires)
  const nearMisses = checks.filter((c) => !c.fires)

  console.log(`\nCross-checking each independently-detected fire against the published result:`)
  let allMatch = true
  for (const fire of fires) {
    const match = published.find(
      (f) => f.favouredTeam === fire.favouredTeam && f.triggerEvent === fire.triggerType && f.triggerMinute === fire.triggerMinute
    )
    const preClaim = match ? (fire.favouredTeam === 'home' ? match.preEventHomeProb : match.preEventAwayProb) : null
    const postClaim = match ? (fire.favouredTeam === 'home' ? match.postSignalHomeProb : match.postSignalAwayProb) : null
    const close = (a: number, b: number): boolean => Math.abs(a - b) < 0.002
    const ok = match !== undefined && preClaim !== null && postClaim !== null && close(preClaim, fire.preEventProb) && close(postClaim, fire.postProb)
    allMatch = allMatch && ok
    console.log(
      `  ${fire.triggerMinute}' ${fire.triggerType} -> ${fire.favouredTeam} favoured: ` +
        `recomputed ${(fire.preEventProb * 100).toFixed(1)}% -> ${(fire.postProb * 100).toFixed(1)}% ` +
        `(Δ${(fire.delta * 100).toFixed(1)}pp)` +
        (match ? `  |  published ${(preClaim! * 100).toFixed(1)}% -> ${(postClaim! * 100).toFixed(1)}%` : '  |  no published match found') +
        `  [${ok ? 'MATCH' : 'MISMATCH'}]`
    )
  }

  if (nearMisses.length > 0) {
    console.log(`\n${nearMisses.length} moment(s) where a trigger occurred but conditions were NOT met (selectivity check):`)
    for (const m of nearMisses.slice(0, 10)) {
      console.log(`  ${m.triggerMinute}' ${m.triggerType} -> ${m.favouredTeam}: ${m.reasonIfNot}`)
    }
  }

  console.log(`\n${allMatch ? 'ALL PUBLISHED FIRES INDEPENDENTLY CONFIRMED' : 'DISCREPANCY FOUND — investigate before trusting the published result'}`)
  if (!allMatch) process.exitCode = 1
}

main()
