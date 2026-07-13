/**
 * TxLINE REST snapshot + history endpoints.
 *
 * Every function returns normalized shared types, handles 401 transparently
 * (via authorizedFetch), and throws TxLineApiError on non-2xx responses.
 *
 * Endpoint map (all under TXLINE_API_BASE):
 *   /fixtures/snapshot?competitionId=&startEpochDay=
 *   /scores/snapshot/{fixtureId}?asOf=      -> latest record per action type
 *   /scores/historical/{fixtureId}          -> full log (limited availability)
 *   /scores/updates/{epochDay}/{hour}/{interval5min}
 *   /odds/snapshot/{fixtureId}?asOf=        -> current 5-min interval only
 *   /odds/updates/{epochDay}/{hour}/{interval5min}
 *   /scores/stat-validation?fixtureId=&seq=&statKey=
 */

import { authorizedFetch, getApiBase } from './auth'
import { TxLineApiError } from './types'
import type {
  Fixture,
  MarketOdds,
  MatchEvent,
  MerkleProof,
  OddsEvent,
  OddsSnapshot,
  ScoresSnapshot,
  TxLineFixtureRecord,
  TxLineOddsRecord,
  TxLineScoresRecord,
} from './types'
import {
  OddsNormalizer,
  ScoresNormalizer,
  buildMatchState,
  marketKey,
  normalizeFixture,
  normalizeScoresRecord,
  zeroMatchState,
} from './normalize'

export const WORLD_CUP_COMPETITION_ID = 72

/** How far around kickoff the history bucket scan reaches. */
const PRE_MATCH_MS = 60 * 60_000
const MAX_MATCH_MS = 5 * 60 * 60_000
const BUCKET_MS = 5 * 60_000
const BUCKET_CONCURRENCY = 6

// ---------------------------------------------------------------------------
// HTTP core
// ---------------------------------------------------------------------------

async function apiGet<T>(pathname: string): Promise<T> {
  const url = `${getApiBase()}${pathname}`
  const res = await authorizedFetch(url)
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch {
    body = text
  }
  if (!res.ok) {
    throw new TxLineApiError(`GET ${pathname} failed (${res.status})`, res.status, url, body)
  }
  return body as T
}

/** Like apiGet, but a 404 (empty time bucket) yields an empty array. */
async function apiGetArray<T>(pathname: string): Promise<T[]> {
  try {
    const data = await apiGet<T[]>(pathname)
    return Array.isArray(data) ? data : []
  } catch (err) {
    if (err instanceof TxLineApiError && err.status === 404) return []
    throw err
  }
}

/**
 * Parse an SSE-formatted body (`data: {...}` per line) into records.
 * /scores/historical responds in this format rather than a JSON array.
 */
function parseSseBody<T>(text: string): T[] {
  const out: T[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload) continue
    try {
      const parsed = JSON.parse(payload) as T | T[]
      if (Array.isArray(parsed)) out.push(...parsed)
      else out.push(parsed)
    } catch {
      // skip malformed line
    }
  }
  return out
}

/** GET an endpoint that may answer with a JSON array OR an SSE text body. */
async function apiGetArrayOrSse<T>(pathname: string): Promise<T[]> {
  const url = `${getApiBase()}${pathname}`
  const res = await authorizedFetch(url)
  const text = await res.text()
  if (res.status === 404) return []
  if (!res.ok) {
    throw new TxLineApiError(`GET ${pathname} failed (${res.status})`, res.status, url, text)
  }
  try {
    const asJson = JSON.parse(text) as unknown
    return Array.isArray(asJson) ? (asJson as T[]) : []
  } catch {
    return parseSseBody<T>(text)
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export interface FixtureQuery {
  /** Defaults to the World Cup (72). Pass null to query every competition. */
  competitionId?: number | null
  /** Days since unix epoch; defaults to 13 days ago (tournament window). */
  startEpochDay?: number
}

export async function getFixtures(params?: FixtureQuery): Promise<Fixture[]> {
  const search = new URLSearchParams()
  const competitionId = params?.competitionId === undefined ? WORLD_CUP_COMPETITION_ID : params.competitionId
  if (competitionId !== null) search.set('competitionId', String(competitionId))
  const startEpochDay = params?.startEpochDay ?? Math.floor(Date.now() / 86400000) - 13
  search.set('startEpochDay', String(startEpochDay))

  const records = await apiGet<TxLineFixtureRecord[]>(`/fixtures/snapshot?${search.toString()}`)
  return records.map(normalizeFixture)
}

// Small in-memory fixture index so odds/scores normalization can resolve
// home/away orientation and team names without refetching per call.
let fixtureIndex: { at: number; byId: Map<string, TxLineFixtureRecord> } | null = null
const FIXTURE_INDEX_TTL_MS = 10 * 60_000

async function getFixtureRecord(matchId: string): Promise<TxLineFixtureRecord | null> {
  const fresh = fixtureIndex && Date.now() - fixtureIndex.at < FIXTURE_INDEX_TTL_MS
  if (!fresh || !fixtureIndex?.byId.has(matchId)) {
    const records = await apiGet<TxLineFixtureRecord[]>(
      `/fixtures/snapshot?competitionId=${WORLD_CUP_COMPETITION_ID}&startEpochDay=${Math.floor(Date.now() / 86400000) - 13}`
    )
    fixtureIndex = { at: Date.now(), byId: new Map(records.map((r) => [String(r.FixtureId), r])) }
  }
  return fixtureIndex.byId.get(matchId) ?? null
}

export interface FixtureOrientation {
  homeTeam: string
  awayTeam: string
  participant1IsHome: boolean
  kickoff: number | null
}

/** Resolve team names + home/away orientation for a match (cached ~10 min). */
export async function getFixtureOrientation(matchId: string): Promise<FixtureOrientation> {
  const record = await getFixtureRecord(matchId)
  if (!record) {
    return { homeTeam: 'Home', awayTeam: 'Away', participant1IsHome: true, kickoff: null }
  }
  const p1IsHome = record.Participant1IsHome
  return {
    homeTeam: p1IsHome ? record.Participant1 : record.Participant2,
    awayTeam: p1IsHome ? record.Participant2 : record.Participant1,
    participant1IsHome: p1IsHome,
    kickoff: Number(record.StartTime),
  }
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

export async function getScoresSnapshot(matchId: string): Promise<ScoresSnapshot> {
  const [records, orientation] = await Promise.all([
    apiGet<TxLineScoresRecord[]>(`/scores/snapshot/${matchId}?asOf=${Date.now()}`),
    getFixtureOrientation(matchId),
  ])
  const events = records
    .map((r) => normalizeScoresRecord(r, orientation.participant1IsHome))
    .filter((e): e is MatchEvent => e !== null)
    .sort((a, b) => Number(a.data.seq) - Number(b.data.seq))
  return {
    matchId,
    state: buildMatchState(records, orientation),
    events,
    raw: records,
  }
}

/**
 * Full chronological raw scores log for a match (deduped by Seq).
 * The replay engine caches these raw records — they include the correction
 * records (action_discarded, score_adjustment) that normalized events omit.
 *
 * /scores/historical answers in SSE text format and covers fixtures that
 * started between two weeks and six hours ago — one request for the whole
 * match. The time-bucket scan remains as fallback (e.g. recently finished
 * matches inside the six-hour blackout).
 */
export async function getScoresRecordsRaw(matchId: string): Promise<TxLineScoresRecord[]> {
  const direct = await apiGetArrayOrSse<TxLineScoresRecord>(`/scores/historical/${matchId}`)
  const records =
    direct.length > 0 ? direct : await scanBuckets<TxLineScoresRecord>('scores', matchId)
  const bySeq = new Map<number, TxLineScoresRecord>()
  for (const rec of records) bySeq.set(rec.Seq, rec)
  return [...bySeq.values()].sort((a, b) => a.Seq - b.Seq)
}

export async function getScoresHistory(matchId: string): Promise<MatchEvent[]> {
  const [records, orientation] = await Promise.all([
    getScoresRecordsRaw(matchId),
    getFixtureOrientation(matchId),
  ])
  // Stateful pass: dedupes enrichment bursts and disallowed incidents, so one
  // real goal/card/corner yields exactly one event. Full history starts at
  // kickoff, so the counter baseline is 0-0 by definition.
  const normalizer = new ScoresNormalizer()
  normalizer.seedFromState(zeroMatchState(matchId, orientation.homeTeam, orientation.awayTeam))
  return records
    .map((r) => normalizer.normalize(r, orientation.participant1IsHome))
    .filter((e): e is MatchEvent => e !== null)
}

// ---------------------------------------------------------------------------
// Odds
// ---------------------------------------------------------------------------

export async function getOddsSnapshot(matchId: string): Promise<OddsSnapshot> {
  const [records, orientation] = await Promise.all([
    apiGetArray<TxLineOddsRecord>(`/odds/snapshot/${matchId}?asOf=${Date.now()}`),
    getFixtureOrientation(matchId),
  ])
  const normalizer = new OddsNormalizer()
  const latestByMarket = new Map<string, MarketOdds>()
  for (const record of [...records].sort((a, b) => a.Ts - b.Ts)) {
    const event = normalizer.normalize(record, orientation.participant1IsHome)
    if (!event) continue
    latestByMarket.set(marketKey(record), {
      market: event.market,
      homeProb: event.homeProb,
      awayProb: event.awayProb,
      drawProb: event.drawProb,
      updatedAt: event.timestamp,
    })
  }
  return {
    matchId,
    timestamp: Date.now(),
    markets: [...latestByMarket.values()],
    raw: records,
  }
}

/** Full chronological raw odds log for a match (deduped by MessageId). */
export async function getOddsRecordsRaw(matchId: string): Promise<TxLineOddsRecord[]> {
  const records = await scanBuckets<TxLineOddsRecord>('odds', matchId)
  const byMessage = new Map<string, TxLineOddsRecord>()
  for (const rec of records) byMessage.set(rec.MessageId, rec)
  return [...byMessage.values()].sort(
    (a, b) => a.Ts - b.Ts || a.MessageId.localeCompare(b.MessageId)
  )
}

export async function getOddsHistory(matchId: string): Promise<OddsEvent[]> {
  const [sorted, orientation] = await Promise.all([
    getOddsRecordsRaw(matchId),
    getFixtureOrientation(matchId),
  ])
  const normalizer = new OddsNormalizer()
  return sorted
    .map((r) => normalizer.normalize(r, orientation.participant1IsHome))
    .filter((e): e is OddsEvent => e !== null)
}

// ---------------------------------------------------------------------------
// Time-bucket scanning (/odds|scores/updates/{epochDay}/{hour}/{interval})
// ---------------------------------------------------------------------------

async function scanBuckets<T extends { FixtureId: number }>(
  feed: 'odds' | 'scores',
  matchId: string
): Promise<T[]> {
  const orientation = await getFixtureOrientation(matchId)
  if (orientation.kickoff === null) {
    throw new TxLineApiError(
      `Cannot scan ${feed} history: fixture ${matchId} not found in fixtures snapshot`,
      404,
      `${getApiBase()}/fixtures/snapshot`,
      null
    )
  }
  const from = orientation.kickoff - PRE_MATCH_MS
  const to = Math.min(Date.now(), orientation.kickoff + MAX_MATCH_MS)

  const paths: string[] = []
  for (let t = Math.floor(from / BUCKET_MS) * BUCKET_MS; t <= to; t += BUCKET_MS) {
    const date = new Date(t)
    const epochDay = Math.floor(t / 86400000)
    const hour = date.getUTCHours()
    const interval = Math.floor(date.getUTCMinutes() / 5)
    paths.push(`/${feed}/updates/${epochDay}/${hour}/${interval}`)
  }

  const fixtureId = Number(matchId)
  const results: T[] = []
  for (let i = 0; i < paths.length; i += BUCKET_CONCURRENCY) {
    const batch = paths.slice(i, i + BUCKET_CONCURRENCY)
    const buckets = await Promise.all(batch.map((p) => apiGetArray<T>(p)))
    for (const bucket of buckets) {
      for (const record of bucket) {
        if (record.FixtureId === fixtureId) results.push(record)
      }
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Validation proofs
// ---------------------------------------------------------------------------

interface RawValidationResponse {
  ts: number
  statToProve: { key: number; value: number; period: number }
  eventStatRoot: number[]
  summary: MerkleProof['summary']
  subTreeProof: MerkleProof['subTreeProof']
  mainTreeProof: MerkleProof['mainTreeProof']
  statProof: MerkleProof['statProof']
}

/**
 * Fetch a Merkle validation proof for a stat of a match.
 * Uses the game_finalised record's sequence when available (statusId/period
 * 100 â€” the record intended for final-outcome settlement), otherwise the
 * latest observed sequence.
 */
export async function getValidationProof(matchId: string, statKey: number): Promise<MerkleProof> {
  const records = await apiGet<TxLineScoresRecord[]>(
    `/scores/snapshot/${matchId}?asOf=${Date.now()}`
  )
  if (records.length === 0) {
    throw new TxLineApiError(
      `No score records for fixture ${matchId}; cannot pick a proof sequence`,
      404,
      `${getApiBase()}/scores/snapshot/${matchId}`,
      null
    )
  }
  const finalised = records.filter((r) => r.Action === 'game_finalised')
  const source = (finalised.length > 0 ? finalised : records).reduce((a, b) =>
    a.Seq >= b.Seq ? a : b
  )

  const proof = await apiGet<RawValidationResponse>(
    `/scores/stat-validation?fixtureId=${matchId}&seq=${source.Seq}&statKey=${statKey}`
  )
  return {
    matchId,
    statKey,
    seq: source.Seq,
    ts: proof.ts,
    statToProve: proof.statToProve,
    eventStatRoot: proof.eventStatRoot,
    summary: proof.summary,
    subTreeProof: proof.subTreeProof,
    mainTreeProof: proof.mainTreeProof,
    statProof: proof.statProof,
    raw: proof,
  }
}
