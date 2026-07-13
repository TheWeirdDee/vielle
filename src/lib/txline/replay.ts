/**
 * Historical replay engine.
 *
 * Replays any completed match through the exact StreamCallbacks interface the
 * live stream uses. Raw records from the cache are pushed through the same
 * normalize.ts pipeline (ScoresNormalizer / OddsNormalizer / applyRecordToState),
 * so product code cannot tell replay from live: same event shapes, same
 * MatchState transitions, same dedupe/correction semantics.
 *
 * Historical data never changes, so cache files in data/replay-cache/ are
 * written once and read forever.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  getFixtureOrientation,
  getOddsRecordsRaw,
  getScoresRecordsRaw,
  getFixtures,
} from './snapshots'
import { OddsNormalizer, ScoresNormalizer, applyRecordToState, zeroMatchState } from './normalize'
import type {
  Fixture,
  MatchState,
  ReplayCache,
  ReplayControls,
  ReplayOptions,
  StreamCallbacks,
  TimelineEntry,
} from './types'

const CACHE_DIR = path.join(process.cwd(), 'data', 'replay-cache')

// ---------------------------------------------------------------------------
// Data acquisition + cache
// ---------------------------------------------------------------------------

/**
 * Pluggable cache backend. The default stores JSON files under
 * data/replay-cache/ — fine locally and on hosts with a disk (Railway), but
 * serverless platforms (Vercel) have read-only, ephemeral filesystems.
 * Products deployed there should call setReplayCacheStore() with a
 * database-backed store (e.g. a Supabase table).
 */
export interface ReplayCacheStore {
  read: (matchId: string) => Promise<ReplayCache | null>
  write: (cache: ReplayCache) => Promise<void>
}

const diskStore: ReplayCacheStore = {
  read: async (matchId) => {
    const file = path.join(CACHE_DIR, `${matchId}.json`)
    try {
      if (!fs.existsSync(file)) return null
      const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as ReplayCache
      return cached.matchId === matchId && Array.isArray(cached.scores) ? cached : null
    } catch {
      return null
    }
  },
  write: async (cache) => {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true })
      fs.writeFileSync(path.join(CACHE_DIR, `${cache.matchId}.json`), JSON.stringify(cache))
    } catch (err) {
      // Read-only filesystem (serverless): replay still works, just uncached.
      console.warn(
        `[replay] cache write skipped (${(err as Error).message}) — set a ReplayCacheStore for persistence`
      )
    }
  },
}

let activeStore: ReplayCacheStore = diskStore

/** Swap the cache backend (call once at startup, before any replay loads). */
export function setReplayCacheStore(store: ReplayCacheStore): void {
  activeStore = store
}

/** Fetch full raw history for a match and persist it to the active cache store. */
export async function fetchAndCacheMatch(matchId: string): Promise<ReplayCache> {
  const [scores, odds, orientation] = await Promise.all([
    getScoresRecordsRaw(matchId),
    getOddsRecordsRaw(matchId),
    getFixtureOrientation(matchId),
  ])
  const cache: ReplayCache = {
    matchId,
    fetchedAt: Date.now(),
    orientation,
    scores,
    odds,
  }
  await activeStore.write(cache)
  return cache
}

/** Cache-first load: reads from the active store, fetches + caches on miss. */
export async function loadReplayData(matchId: string): Promise<ReplayCache> {
  const cached = await activeStore.read(matchId)
  if (cached) return cached
  return fetchAndCacheMatch(matchId)
}

/** Completed World Cup matches that have replayable historical data. */
export async function getReplayableMatches(): Promise<Fixture[]> {
  const fixtures = await getFixtures()
  const now = Date.now()
  return fixtures
    .filter((f) => f.phase !== 'C' && f.kickoff < now - 7 * 3600_000)
    .sort((a, b) => a.kickoff - b.kickoff)
}

// ---------------------------------------------------------------------------
// Replay playback
// ---------------------------------------------------------------------------

function buildTimeline(cache: ReplayCache): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...cache.scores.map((record): TimelineEntry => ({ kind: 'scores', timestamp: record.Ts, record })),
    ...cache.odds.map((record): TimelineEntry => ({ kind: 'odds', timestamp: record.Ts, record })),
  ]
  // Chronological; ties: scores before odds, then feed ordering.
  return entries.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
    if (a.kind !== b.kind) return a.kind === 'scores' ? -1 : 1
    if (a.kind === 'scores' && b.kind === 'scores') return a.record.Seq - b.record.Seq
    if (a.kind === 'odds' && b.kind === 'odds') {
      return a.record.MessageId.localeCompare(b.record.MessageId)
    }
    return 0
  })
}

function zeroState(cache: ReplayCache): MatchState {
  return zeroMatchState(cache.matchId, cache.orientation.homeTeam, cache.orientation.awayTeam)
}

/**
 * Start replaying a match through the live-stream callback interface.
 *
 * speed 1 = real time, 10 = 10x, 0 = instant (every event fires synchronously
 * before startReplay's promise resolves).
 */
export async function startReplay(
  options: ReplayOptions,
  callbacks: StreamCallbacks
): Promise<ReplayControls> {
  const cache = await loadReplayData(options.matchId)
  const fullTimeline = buildTimeline(cache)
  if (fullTimeline.length === 0) {
    throw new Error(`No replay data available for match ${options.matchId}`)
  }

  const timelineStart = fullTimeline[0].timestamp
  const timelineEnd = fullTimeline[fullTimeline.length - 1].timestamp
  // Historical data can include records from days before kickoff (venue,
  // coverage, lineups). Default playback to one hour before kickoff; explicit
  // startAt (and seek) can still reach the earlier records.
  const defaultStart =
    cache.orientation.kickoff !== null
      ? Math.min(Math.max(timelineStart, cache.orientation.kickoff - 3_600_000), timelineEnd)
      : timelineStart
  const startAt = Math.max(options.startAt ?? defaultStart, timelineStart)
  const endAt = Math.min(options.endAt ?? timelineEnd, timelineEnd)
  const timeline = fullTimeline.filter((e) => e.timestamp <= endAt)

  const p1IsHome = cache.orientation.participant1IsHome
  const scoresNormalizer = new ScoresNormalizer()
  const oddsNormalizer = new OddsNormalizer()
  let state = zeroState(cache)
  let index = 0 // next timeline entry to emit
  let virtualTime = startAt
  let playing = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let wallAnchor = 0 // Date.now() when playback (re)started
  let virtualAnchor = 0 // virtualTime at that moment

  /** Apply one entry to the pipeline; emit callbacks unless silent. */
  const applyEntry = (entry: TimelineEntry, silent: boolean): void => {
    if (entry.kind === 'scores') {
      state = applyRecordToState(state, entry.record)
      const event = scoresNormalizer.normalize(entry.record, p1IsHome)
      if (event && !silent) callbacks.onMatchEvent(event, state)
    } else {
      const event = oddsNormalizer.normalize(entry.record, p1IsHome)
      if (event && !silent) callbacks.onOddsEvent(event)
    }
  }

  /**
   * Position the pipeline at `target` without emitting: replays every prior
   * entry silently from the 0-0 baseline, so MatchState and both normalizers
   * hold exactly what a live consumer would hold at that moment.
   */
  const rebuildTo = (target: number): void => {
    scoresNormalizer.reset()
    oddsNormalizer.reset()
    state = zeroState(cache)
    // A replay knows its provenance: the match starts 0-0, so baseline the
    // counter dedupe there (a fresh normalizer would swallow the first goal).
    scoresNormalizer.seedFromState(state)
    index = 0
    while (index < timeline.length && timeline[index].timestamp < target) {
      applyEntry(timeline[index], true)
      index += 1
    }
    virtualTime = target
  }

  const currentVirtual = (): number => {
    if (!playing) return virtualTime
    return Math.min(virtualAnchor + (Date.now() - wallAnchor) * options.speed, endAt)
  }

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const scheduleNext = (): void => {
    clearTimer()
    if (stopped || !playing) return
    if (index >= timeline.length) {
      playing = false
      virtualTime = endAt
      return
    }
    const nextTs = timeline[index].timestamp
    const delayMs = Math.max(0, (nextTs - currentVirtual()) / options.speed)
    timer = setTimeout(() => {
      if (stopped || !playing) return
      const now = currentVirtual()
      while (index < timeline.length && timeline[index].timestamp <= now) {
        applyEntry(timeline[index], false)
        index += 1
      }
      virtualTime = now
      scheduleNext()
    }, delayMs)
  }

  // Initial positioning
  rebuildTo(startAt)

  if (options.speed === 0) {
    // Instant mode: emit everything synchronously, no timers.
    while (index < timeline.length) {
      applyEntry(timeline[index], false)
      index += 1
    }
    virtualTime = endAt
  } else {
    playing = true
    wallAnchor = Date.now()
    virtualAnchor = virtualTime
    scheduleNext()
  }

  return {
    pause: () => {
      if (stopped || !playing) return
      virtualTime = currentVirtual()
      playing = false
      clearTimer()
    },
    resume: () => {
      if (stopped || playing || options.speed === 0) return
      playing = true
      wallAnchor = Date.now()
      virtualAnchor = virtualTime
      scheduleNext()
    },
    // Preserves play/pause state. When playback has finished (which counts
    // as paused), seek() repositions silently — call resume() to play again.
    seek: (timestamp: number) => {
      if (stopped) return
      const target = Math.min(Math.max(timestamp, timelineStart), endAt)
      const wasPlaying = playing
      playing = false
      clearTimer()
      rebuildTo(target)
      if (wasPlaying && options.speed !== 0) {
        playing = true
        wallAnchor = Date.now()
        virtualAnchor = virtualTime
        scheduleNext()
      }
    },
    stop: () => {
      stopped = true
      playing = false
      clearTimer()
    },
    getCurrentTime: () => currentVirtual(),
    getDuration: () => endAt - startAt,
  }
}
