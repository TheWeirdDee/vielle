/**
 * Live SSE connections to TxLINE's scores and odds streams.
 *
 *  - Normalizes every record through the same normalize.ts pipeline the
 *    snapshot and replay modules use.
 *  - Maintains a MatchState per matchId, seeded from getScoresSnapshot() the
 *    first time a match appears, updated incrementally afterwards.
 *  - Reconnects with exponential backoff (1s, 2s, 4s, 8s, 16s, 30s max).
 *    A 401/403 refreshes the JWT and reconnects immediately (once per drop).
 *  - Returned disconnect functions abort the HTTP stream and stop all timers.
 */

import { getCredentials, refreshJWT, getApiBase } from './auth'
import { getFixtureOrientation, getScoresSnapshot } from './snapshots'
import { OddsNormalizer, ScoresNormalizer, applyRecordToState } from './normalize'
import type {
  MatchState,
  StreamCallbacks,
  TxLineOddsRecord,
  TxLineScoresRecord,
} from './types'

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000]
const MAX_QUEUE = 2000
// A half-open TCP connection delivers no bytes and never errors, so read()
// blocks forever while the process heartbeat keeps reporting healthy. If no
// bytes at all arrive for this long, abort and reconnect.
const IDLE_TIMEOUT_MS = 150_000
const IDLE_CHECK_MS = 30_000
const CONNECT_TIMEOUT_MS = 20_000

// ---------------------------------------------------------------------------
// SSE plumbing
// ---------------------------------------------------------------------------

interface SseMessage {
  id?: string
  event?: string
  data: string
}

function parseSseBlock(block: string): SseMessage | null {
  const message: SseMessage = { data: '' }
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue
    const sep = rawLine.indexOf(':')
    const field = sep === -1 ? rawLine : rawLine.slice(0, sep)
    const value = sep === -1 ? '' : rawLine.slice(sep + 1).replace(/^ /, '')
    if (field === 'data') message.data += `${value}\n`
    if (field === 'event') message.event = value
    if (field === 'id') message.id = value
  }
  message.data = message.data.replace(/\n$/, '')
  return message.data || message.event || message.id ? message : null
}

async function* readSseMessages(
  body: ReadableStream<Uint8Array>,
  onActivity?: () => void
): AsyncGenerator<SseMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      onActivity?.()
      buffer += decoder.decode(value, { stream: true })
      let sep = buffer.match(/\r?\n\r?\n/)
      while (sep?.index !== undefined) {
        const block = buffer.slice(0, sep.index)
        buffer = buffer.slice(sep.index + sep[0].length)
        const message = parseSseBlock(block)
        if (message) yield message
        sep = buffer.match(/\r?\n\r?\n/)
      }
    }
    const tail = parseSseBlock(buffer)
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

interface LoopHandle {
  closed: boolean
  abort: AbortController | null
  timer: ReturnType<typeof setTimeout> | null
  wake: (() => void) | null
}

function abortableDelay(ms: number, handle: LoopHandle): Promise<void> {
  return new Promise((resolve) => {
    handle.wake = resolve
    handle.timer = setTimeout(() => {
      handle.timer = null
      handle.wake = null
      resolve()
    }, ms)
  })
}

/**
 * Run one auto-reconnecting SSE loop. Returns a disconnect function.
 * Parsed `data:` payloads (objects or arrays of objects) go to onRecord.
 */
function startSseLoop(
  path: string,
  onRecord: (record: unknown) => void,
  callbacks: Pick<StreamCallbacks, 'onError' | 'onReconnect'>
): () => void {
  const handle: LoopHandle = { closed: false, abort: null, timer: null, wake: null }

  const loop = async (): Promise<void> => {
    let backoffIdx = 0
    let hadConnection = false
    let authRetried = false

    while (!handle.closed) {
      try {
        const { jwt, apiToken } = await getCredentials()
        const controller = new AbortController()
        handle.abort = controller
        const connectTimer = setTimeout(() => {
          controller.abort(new Error(`SSE ${path} connection timed out`))
        }, CONNECT_TIMEOUT_MS)
        let res: Response
        try {
          res = await fetch(`${getApiBase()}${path}`, {
            headers: {
              Authorization: `Bearer ${jwt}`,
              'X-Api-Token': apiToken,
              Accept: 'text/event-stream',
              'Cache-Control': 'no-cache',
            },
            signal: controller.signal,
          })
        } finally {
          clearTimeout(connectTimer)
        }

        if (res.status === 401 || res.status === 403) {
          await res.body?.cancel().catch(() => undefined)
          if (!authRetried) {
            // Refresh once and reconnect immediately; repeated auth failures
            // fall through to normal backoff so we never spin hot.
            authRetried = true
            await refreshJWT()
            continue
          }
          throw new Error(`SSE ${path} rejected with ${res.status} after JWT refresh`)
        }
        if (!res.ok || !res.body) {
          throw new Error(`SSE ${path} failed with status ${res.status}`)
        }

        if (hadConnection) callbacks.onReconnect()
        hadConnection = true
        backoffIdx = 0
        authRetried = false

        let lastActivity = Date.now()
        const idleTimer = setInterval(() => {
          if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
            controller.abort(new Error(`SSE ${path} idle for ${IDLE_TIMEOUT_MS / 1000}s — forcing reconnect`))
          }
        }, IDLE_CHECK_MS)

        try {
          for await (const message of readSseMessages(res.body, () => {
            lastActivity = Date.now()
          })) {
            if (handle.closed) break
            if (!message.data) continue
            let data: unknown
            try {
              data = JSON.parse(message.data) as unknown
            } catch {
              continue // heartbeat / non-JSON chatter
            }
            if (Array.isArray(data)) {
              for (const item of data) onRecord(item)
            } else {
              onRecord(data)
            }
          }
        } finally {
          clearInterval(idleTimer)
        }
        if (handle.closed) return
        throw new Error(`SSE ${path} closed by server`)
      } catch (err) {
        if (handle.closed) return
        callbacks.onError(toError(err))
        const delay = BACKOFF_MS[Math.min(backoffIdx, BACKOFF_MS.length - 1)]
        backoffIdx += 1
        await abortableDelay(delay, handle)
      }
    }
  }

  void loop()

  return () => {
    handle.closed = true
    handle.abort?.abort()
    if (handle.timer) clearTimeout(handle.timer)
    handle.wake?.()
  }
}

// ---------------------------------------------------------------------------
// Scores stream
// ---------------------------------------------------------------------------

function isScoresRecord(data: unknown): data is TxLineScoresRecord {
  const rec = data as Partial<TxLineScoresRecord> | null
  return (
    typeof rec === 'object' &&
    rec !== null &&
    typeof rec.FixtureId === 'number' &&
    typeof rec.Action === 'string' &&
    typeof rec.Seq === 'number'
  )
}

/**
 * Connect to /api/scores/stream. For each incoming record the per-match
 * MatchState is updated and, when the record maps onto the shared event
 * vocabulary, callbacks.onMatchEvent(event, state) fires.
 */
export function connectScoresStream(callbacks: StreamCallbacks): () => void {
  const states = new Map<string, MatchState>()
  const seqFence = new Map<string, number>() // snapshot's max seq per match
  const pending = new Map<string, TxLineScoresRecord[]>()
  const normalizer = new ScoresNormalizer()

  const handleLive = (record: TxLineScoresRecord): void => {
    const matchId = String(record.FixtureId)
    const prev = states.get(matchId)
    if (!prev) return
    const lastSeq = seqFence.get(matchId) ?? 0
    if (record.Seq <= lastSeq) return
    seqFence.set(matchId, record.Seq)
    const next = applyRecordToState(prev, record)
    states.set(matchId, next)
    const event = normalizer.normalize(record)
    if (event) callbacks.onMatchEvent(event, next)
  }

  const initMatch = async (matchId: string): Promise<void> => {
    try {
      const snapshot = await getScoresSnapshot(matchId)
      const rawRecords = snapshot.raw as TxLineScoresRecord[]
      const maxSeq = rawRecords.reduce((max, r) => Math.max(max, r.Seq), 0)
      states.set(matchId, snapshot.state)
      seqFence.set(matchId, maxSeq)
      normalizer.seedFromState(snapshot.state)
      const queued = pending.get(matchId) ?? []
      pending.delete(matchId)
      for (const record of queued.sort((a, b) => a.Seq - b.Seq)) {
        if (record.Seq > maxSeq) handleLive(record)
      }
    } catch (err) {
      // Drop the queue; the next record for this match retries initialization.
      pending.delete(matchId)
      callbacks.onError(toError(err))
    }
  }

  const onRecord = (data: unknown): void => {
    if (!isScoresRecord(data)) return
    const matchId = String(data.FixtureId)
    if (states.has(matchId)) {
      if (data.Seq <= (seqFence.get(matchId) ?? 0)) return // already in snapshot
      handleLive(data)
      return
    }
    const queue = pending.get(matchId)
    if (queue) {
      queue.push(data)
      if (queue.length > MAX_QUEUE) queue.shift()
      return
    }
    pending.set(matchId, [data])
    void initMatch(matchId)
  }

  return startSseLoop('/scores/stream', onRecord, callbacks)
}

// ---------------------------------------------------------------------------
// Odds stream
// ---------------------------------------------------------------------------

function isOddsRecord(data: unknown): data is TxLineOddsRecord {
  const rec = data as Partial<TxLineOddsRecord> | null
  return (
    typeof rec === 'object' &&
    rec !== null &&
    typeof rec.FixtureId === 'number' &&
    typeof rec.MessageId === 'string' &&
    Array.isArray(rec.PriceNames)
  )
}

/**
 * Connect to /api/odds/stream. Emits normalized OddsEvents via
 * callbacks.onOddsEvent. Home/away orientation is resolved from the fixtures
 * snapshot the first time a match appears (records are queued meanwhile).
 */
export function connectOddsStream(callbacks: StreamCallbacks): () => void {
  const normalizer = new OddsNormalizer()
  const orientations = new Map<string, boolean>()
  const pending = new Map<string, TxLineOddsRecord[]>()
  const recentMessageIds = new Set<string>()

  const emit = (record: TxLineOddsRecord): void => {
    const p1IsHome = orientations.get(String(record.FixtureId)) ?? true
    const event = normalizer.normalize(record, p1IsHome)
    if (event) callbacks.onOddsEvent(event)
  }

  const initMatch = async (matchId: string): Promise<void> => {
    let p1IsHome = true
    try {
      const orientation = await getFixtureOrientation(matchId)
      p1IsHome = orientation.participant1IsHome
    } catch {
      // Unknown fixture (not in the fixtures snapshot): default orientation.
    }
    orientations.set(matchId, p1IsHome)
    const queued = pending.get(matchId) ?? []
    pending.delete(matchId)
    for (const record of queued) emit(record)
  }

  const onRecord = (data: unknown): void => {
    if (!isOddsRecord(data)) return
    if (recentMessageIds.has(data.MessageId)) return
    recentMessageIds.add(data.MessageId)
    if (recentMessageIds.size > 10_000) {
      const oldest = recentMessageIds.values().next().value as string | undefined
      if (oldest) recentMessageIds.delete(oldest)
    }
    const matchId = String(data.FixtureId)
    if (orientations.has(matchId)) {
      emit(data)
      return
    }
    const queue = pending.get(matchId)
    if (queue) {
      queue.push(data)
      if (queue.length > MAX_QUEUE) queue.shift()
      return
    }
    pending.set(matchId, [data])
    void initMatch(matchId)
  }

  return startSseLoop('/odds/stream', onRecord, callbacks)
}

// ---------------------------------------------------------------------------
// Combined
// ---------------------------------------------------------------------------

/** Connect both streams; the returned function disconnects both. */
export function connectStreams(callbacks: StreamCallbacks): () => void {
  const disconnectScores = connectScoresStream(callbacks)
  const disconnectOdds = connectOddsStream(callbacks)
  return () => {
    disconnectScores()
    disconnectOdds()
  }
}
