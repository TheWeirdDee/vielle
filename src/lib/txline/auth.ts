/**
 * TxLINE credential management.
 *
 * Two credentials ride on every data request:
 *   Authorization: Bearer <guest JWT>   — short-lived, renewed automatically
 *   X-Api-Token: <api token>            — long-lived, from on-chain activation
 *
 * The current JWT lives in a module-level variable, seeded from
 * TXLINE_GUEST_JWT on first use. Any 401 triggers a transparent refresh via
 * POST /auth/guest/start — callers never handle JWT expiry themselves.
 */

import { TxLineApiError } from './types'
import type { TxLineCredentials, TxLineHeaders } from './types'

const DEFAULT_API_BASE = 'https://txline.txodds.com/api'

let currentJwt: string | null = null
let currentApiToken: string | null = null

/** API base URL without trailing slash, e.g. https://txline.txodds.com/api */
export function getApiBase(): string {
  return (process.env.TXLINE_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, '')
}

/** Server origin (guest auth lives outside /api). */
function getOrigin(): string {
  return getApiBase().replace(/\/api$/, '')
}

function seedFromEnv(): void {
  if (currentJwt === null) currentJwt = process.env.TXLINE_GUEST_JWT?.trim() || null
  if (currentApiToken === null) currentApiToken = process.env.TXLINE_API_TOKEN?.trim() || null
}

/** Parse a response body as JSON when possible, falling back to raw text. */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/** Fetch a fresh guest JWT and make it the active one. */
export async function getGuestJWT(): Promise<string> {
  const url = `${getOrigin()}/auth/guest/start`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  const body = await readBody(res)
  if (!res.ok) {
    throw new TxLineApiError(`Guest auth failed (${res.status})`, res.status, url, body)
  }
  const token = (body as { token?: unknown }).token
  if (typeof token !== 'string' || token.length === 0) {
    throw new TxLineApiError('Guest auth response had no token', res.status, url, body)
  }
  currentJwt = token
  return token
}

/** Force a fresh JWT regardless of current state. */
export async function refreshJWT(): Promise<string> {
  return getGuestJWT()
}

/**
 * Current credentials, fetching a guest JWT if none is loaded.
 * Throws if the API token is missing — run scripts/activate.ts once to get it.
 */
export async function getCredentials(): Promise<TxLineCredentials> {
  seedFromEnv()
  const jwt = currentJwt ?? (await getGuestJWT())
  if (!currentApiToken) {
    throw new Error(
      'TXLINE_API_TOKEN is not set. Run `npx tsx scripts/activate.ts` once to activate the on-chain subscription.'
    )
  }
  return { jwt, apiToken: currentApiToken }
}

/** The two headers every TxLINE data request needs. Synchronous — uses the in-memory JWT. */
export function getHeaders(): TxLineHeaders {
  seedFromEnv()
  if (!currentJwt) {
    throw new Error('No TxLINE JWT loaded. Call getCredentials() first or set TXLINE_GUEST_JWT.')
  }
  if (!currentApiToken) {
    throw new Error(
      'TXLINE_API_TOKEN is not set. Run `npx tsx scripts/activate.ts` once to activate the on-chain subscription.'
    )
  }
  return { Authorization: `Bearer ${currentJwt}`, 'X-Api-Token': currentApiToken }
}

/**
 * fetch() with TxLINE auth headers attached and transparent 401 recovery:
 * on a 401 the JWT is refreshed once and the request retried.
 */
export async function authorizedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const { jwt, apiToken } = await getCredentials()

  const attempt = (token: string): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    headers.set('X-Api-Token', apiToken)
    return fetch(url, { ...init, headers })
  }

  let res = await attempt(jwt)
  if (res.status === 401) {
    const fresh = await refreshJWT()
    res = await attempt(fresh)
  }
  return res
}

/**
 * The exact string the wallet must sign for token activation.
 * Standard bundle (leagues = []) yields `${txSig}::${jwt}`.
 */
export function buildActivationMessage(txSig: string, leagues: number[], jwt: string): string {
  return `${txSig}:${leagues.join(',')}:${jwt}`
}

/**
 * Exchange an on-chain subscribe transaction for a long-lived API token.
 * Called once by scripts/activate.ts after program.methods.subscribe().
 *
 * @param walletSignature base64-encoded nacl detached signature of
 *                        buildActivationMessage(txSig, leagues, jwt)
 */
export async function activateToken(
  txSig: string,
  jwt: string,
  leagues: number[],
  walletSignature: string
): Promise<string> {
  const url = `${getApiBase()}/token/activate`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ txSig, walletSignature, leagues }),
  })
  const body = await readBody(res)
  if (!res.ok) {
    throw new TxLineApiError(`Token activation failed (${res.status})`, res.status, url, body)
  }
  // The endpoint returns { token } (or historically the bare token string).
  const token = typeof body === 'string' ? body : (body as { token?: unknown }).token
  if (typeof token !== 'string' || token.length === 0) {
    throw new TxLineApiError('Activation response had no token', res.status, url, body)
  }
  currentApiToken = token
  return token
}
