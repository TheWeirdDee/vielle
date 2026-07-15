/**
 * Pre-computes backtest results for completed matches, using the exact same
 * SignalDetector + replay engine SCOUT and CLERK use live. Historical data
 * never changes, so this runs once; the output JSON is bundled into
 * veille-dashboard as static content — no TxLINE credentials or live
 * computation needed at request time.
 *
 *   npx tsx scripts/precompute-backtest.ts <matchId> [<matchId> ...]
 *
 * Output written to data/backtest/<matchId>.json
 */

try {
  process.loadEnvFile('.env')
} catch {
  /* env from shell */
}

import * as fs from 'node:fs'
import * as path from 'node:path'
import { startReplay } from '../src/lib/txline/replay'
import { SignalDetector } from '../src/lib/signal-detector'
import { loadSignalDefinition } from '../src/lib/registry'
import { MATCH_WINNER_MARKET } from '../src/lib/txline/normalize'
import type { EventType, GamePhase, MatchState } from '../src/lib/txline/types'
import type { VeilleSignal, Winner } from '../src/types'

const KEY_EVENT_TYPES = new Set<EventType>(['goal', 'red_card', 'yellow_card', 'var_end', 'penalty'])

interface KeyEvent {
  type: EventType
  team: 'home' | 'away' | null
  minute: number
  timestamp: number
}

interface BacktestFire extends VeilleSignal {
  outcome: 'hit' | 'miss'
  actualWinner: Winner
}

/** One downsampled full-match 1X2 probability point. */
interface ProbPoint {
  t: number
  h: number
  a: number
}

/**
 * Downsample the 1X2 tick stream for the dashboard's animated replay:
 * one point per 30s baseline, densified to 5s around goals/red cards where
 * the story actually happens. Keeps a match under ~400 points.
 */
function downsampleProbs(ticks: ProbPoint[], keyEvents: KeyEvent[]): ProbPoint[] {
  const hot = keyEvents.filter((e) => e.type === 'goal' || e.type === 'red_card').map((e) => e.timestamp)
  const isHot = (t: number): boolean => hot.some((h) => t >= h - 60_000 && t <= h + 300_000)
  const out: ProbPoint[] = []
  let last = -Infinity
  for (const p of ticks) {
    if (p.t - last >= (isHot(p.t) ? 5_000 : 30_000)) {
      out.push({ t: p.t, h: Math.round(p.h * 10000) / 10000, a: Math.round(p.a * 10000) / 10000 })
      last = p.t
    }
  }
  return out
}

interface BacktestResult {
  matchId: string
  homeTeam: string
  awayTeam: string
  homeScore: number
  awayScore: number
  phase: GamePhase
  winner: Winner
  keyEvents: KeyEvent[]
  fires: BacktestFire[]
  /** Downsampled full-match 1X2 probabilities for the animated replay. */
  probSeries: ProbPoint[]
  computedAt: string
}

function decideWinner(homeScore: number, awayScore: number): Winner {
  if (homeScore > awayScore) return 'home'
  if (awayScore > homeScore) return 'away'
  return 'draw'
}

function outcomeForPosition(position: string, winner: Winner): 'hit' | 'miss' {
  if (position === 'long_home') return winner === 'home' ? 'hit' : 'miss'
  if (position === 'long_away') return winner === 'away' ? 'hit' : 'miss'
  if (position === 'short_home') return winner !== 'home' ? 'hit' : 'miss'
  return winner !== 'away' ? 'hit' : 'miss'
}

async function backtest(matchId: string): Promise<BacktestResult> {
  const def = await loadSignalDefinition()
  const detector = new SignalDetector(def)
  const keyEvents: KeyEvent[] = []
  const fires: VeilleSignal[] = []
  const oneXtwoTicks: ProbPoint[] = []
  let finalState: MatchState | null = null

  await startReplay(
    { matchId, speed: 0 },
    {
      onMatchEvent: (event, state) => {
        detector.onMatchEvent(event, state)
        finalState = state
        if (KEY_EVENT_TYPES.has(event.type)) {
          keyEvents.push({ type: event.type, team: event.team, minute: event.minute, timestamp: event.timestamp })
        }
      },
      onOddsEvent: (event) => {
        if (event.market === MATCH_WINNER_MARKET) {
          oneXtwoTicks.push({ t: event.timestamp, h: event.homeProb, a: event.awayProb })
        }
        fires.push(...detector.onOddsEvent(event))
      },
      onError: (err) => console.error(`[${matchId}] replay error:`, err),
      onReconnect: () => undefined,
    }
  )

  if (!finalState) throw new Error(`No match state produced for ${matchId} — check the replay cache exists`)
  const state = finalState as MatchState
  const winner = decideWinner(state.homeScore, state.awayScore)

  return {
    matchId,
    homeTeam: state.homeTeam,
    awayTeam: state.awayTeam,
    homeScore: state.homeScore,
    awayScore: state.awayScore,
    phase: state.phase,
    winner,
    keyEvents,
    fires: fires.map((f) => ({ ...f, outcome: outcomeForPosition(f.position, winner), actualWinner: winner })),
    probSeries: downsampleProbs(oneXtwoTicks, keyEvents),
    computedAt: new Date().toISOString(),
  }
}

async function main(): Promise<void> {
  const matchIds = process.argv.slice(2)
  if (matchIds.length === 0) {
    console.error('Usage: npx tsx scripts/precompute-backtest.ts <matchId> [<matchId> ...]')
    process.exit(1)
  }

  const outDir = path.join(process.cwd(), 'data', 'backtest')
  fs.mkdirSync(outDir, { recursive: true })

  let failed = 0
  for (const matchId of matchIds) {
    console.log(`Backtesting ${matchId}…`)
    try {
      const result = await backtest(matchId)
      const file = path.join(outDir, `${matchId}.json`)
      fs.writeFileSync(file, JSON.stringify(result, null, 2))
      console.log(
        `  ${result.homeTeam} ${result.homeScore}-${result.awayScore} ${result.awayTeam} (${result.phase}) — ` +
          `${result.keyEvents.length} key events, ${result.fires.length} signal fire(s) → ${file}`
      )
      for (const f of result.fires) {
        console.log(
          `    Strategy ${f.strategy} @ ${f.triggerMinute}' ${f.triggerEvent} → ${f.position} → ${f.outcome}`
        )
      }
    } catch (err) {
      // One bad match (no historical data, transient API failure) must not
      // abort the rest of the run — rerun later for the skipped ids.
      failed += 1
      console.error(`  SKIPPED ${matchId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} match(es) skipped`)
    process.exitCode = 1
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
