# VEILLE

VEILLE is a deterministic World Cup odds-signal engine. SCOUT consumes TxLINE score and odds streams, persists qualifying signals, and reconciles Solana/webhook side effects. CLERK settles positions from final scores and recomputes outcome statistics.

## What the metrics mean

The two strategies score the same signal in opposite ways:

- Strategy A: long the newly favoured team.
- Strategy B: short the newly favoured team.

A hit contributes `+1` and a miss contributes `-1`. The stored `pnl_units`, `sharpe_ratio`, and drawdown columns are legacy names for this outcome score. They are not executable trading P&L or an execution-return Sharpe ratio: entry prices, stake sizing, fees, liquidity, and slippage are not modeled.

## Integrity model

- The signal definition is append-only after registration.
- A deterministic dedupe key prevents duplicate signal rows.
- Match state, last trigger, odds baseline, cooldown, and stream sequence are persisted for restart recovery.
- Signal and settlement effects use durable delivery state and startup reconciliation.
- Solana retries resend the same signed transaction within one write attempt.
- Webhook v2 signs the exact raw body in `X-VEILLE-Signature` and includes a stable delivery ID.
- Raw TxLINE replay verification compares the independent and published fire sets in both directions.

Solana memos currently contain `txline_proof: null`. The system does not claim native TxLINE proof validation until the feed supplies a proof reference that can be fetched and checked.

## Setup

Requires Node.js 22 or newer.

```bash
npm ci
copy env.example .env
npm run activate
```

Apply both SQL files in the Supabase SQL editor before starting an agent:

1. `supabase/schema.sql`
2. `supabase/heartbeat.sql`

Then register and anchor the definition once, and initialize both portfolio rows:

```bash
npm run register-signal
npx tsx scripts/anchor-registration.ts
npm run init-portfolio
```

The registry trigger rejects later updates or deletes. Keep the registration transaction signature and configured wallet public key available to the dashboard verifier.

## Run and verify

```bash
npm run build
npm run test:engine
npm test
npm run scout
npm run clerk
```

`npm run test:engine` is deterministic and offline. `npm test` performs read-only TxLINE and Supabase checks plus a loopback webhook protocol check. It never inserts production data, contacts registered subscribers, or spends SOL.

Replay one cached match instantly:

```bash
npm run replay -- 18222446
npx tsx scripts/independent-verify.ts 18222446
```

## Webhook v2

The JSON body contains:

```typescript
{
  veille_version: 2,
  delivery_id: string,
  sent_at: number,
  event: 'signal_fired' | 'position_settled',
  signal_id: string,
  strategy: 'A' | 'B',
  match_id: string,
  home_team: string,
  away_team: string,
  trigger_event: 'goal' | 'red_card',
  trigger_minute: number,
  favoured_team: 'home' | 'away',
  position: 'long_home' | 'long_away' | 'short_home' | 'short_away',
  pre_event_prob: number,
  post_signal_prob: number,
  delta: number,
  onchain_tx: string,
  txline_proof: string,
  fired_at: number,
  outcome?: 'hit' | 'miss' | 'void'
}
```

Verify `HMAC-SHA256(rawRequestBody, subscriberSecret)` against `X-VEILLE-Signature` with constant-time comparison. Reject stale `X-VEILLE-Timestamp` values and deduplicate `X-VEILLE-Delivery-Id`. Return a non-2xx status when downstream processing fails so VEILLE retries.

## Deploy two Railway services

Create two services from the same repository and migration state:

- `veille-scout`: start command `npm run scout`
- `veille-clerk`: start command `npm run clerk`

Both need the TxLINE, Supabase, and Solana environment variables in `env.example`. Use the same wallet and database, deploy the schema first, and keep Railway restart policy set to `ON_FAILURE`. A deployment is healthy only when both rows in `veille_agent_heartbeat` remain fresh.

## Security

Only trusted server processes use the Supabase service role. RLS is enabled on all VEILLE tables with no public policies. Subscriber URLs must be HTTPS, secrets must never reach the dashboard/browser, and integration tests are read-only by default.

`npm audit` reports transitive findings inside the pinned Solana v1 stack (`bigint-buffer` via `@solana/spl-token`, `uuid` via `jayson`/`@solana/web3.js`). The available fixes are breaking downgrades, and the affected code paths are not reachable from agent runtime input: the agents only sign and submit memo transactions, and `@solana/spl-token`/`@coral-xyz/anchor` are used solely by the one-time local `npm run activate` script. Re-evaluate when migrating to `@solana/kit`.
