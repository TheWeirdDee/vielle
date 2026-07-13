# VEILLE

**Autonomous odds intelligence. Two agents. 104 matches. Zero human input.**

VEILLE is an autonomous trading intelligence system that runs continuously across all 104 World Cup matches. It watches TxLINE's live odds stream, detects a pre-registered mathematical signal, manages a verifiable position portfolio like a fund, and writes every decision to Solana with cryptographic proof. A professional trading desk can audit every signal independently — they don't need to trust our dashboard numbers.

Built for the TxODDS World Cup Hackathon · Trading Tools & Agents Track · July 2026

---

## Two Agents

**VEILLE SCOUT** — the surveillance agent. Runs 24/7 during matches. Watches TxLINE's odds and scores SSE streams across all active matches simultaneously. Detects signals. Opens positions. Writes signal proofs to Solana. Notifies B2B subscribers within 500ms.

**VEILLE CLERK** — the settlement agent. Polls every 5 minutes for completed matches. Reads TxLINE's final score data. Closes positions against actual outcomes. Updates portfolio statistics. Writes settlement records to Solana.

---

## The Signal (Pre-Registered · Timestamped · Immutable)

Registered before tournament results were known. Cannot be changed retroactively. This is what makes the track record credible.

```
Name: POST_EVENT_PROB_SHOCK

Fires when ALL conditions are true:
1. Win probability shifts ≥ 12% within a 120-second rolling window
2. A goal OR red card occurred within the preceding 180 seconds  
3. Pre-event odds implied < 40% for the now-favoured team

Hypothesis: Markets systematically underreact to high-impact in-play 
events when the favoured team was previously an underdog.

Cooldown: 5 minutes per match (prevents signal clustering)
```

**Strategy A** — LONG the newly favoured team when signal fires.  
**Strategy B** — SHORT (inverse position). Runs simultaneously. Proves which strategy performs better across 104 matches.

Signal registered at: `[timestamp from veille_signal_registry table]`

---

## Four Layers

**Layer 1 — Signal Engine:** Pre-registered mathematical signal. Deterministic. No ML, no black box. Anyone can read the logic and verify it matches the on-chain records.

**Layer 2 — Portfolio Management:** Fund-level statistics across all 104 matches. Win rate, Sharpe ratio, maximum drawdown, P&L in units. Updated after every settled position. Strategy A vs B comparison visible in the dashboard.

**Layer 3 — On-Chain Ledger:** Every signal fire and settlement written to Solana as a memo transaction referencing TxLINE's cryptographic proof. Independently auditable — click any transaction link on the dashboard and verify on Solana Explorer without trusting us.

**Layer 4 — Subscriber Protocol (B2B):** Trading desks and market operators subscribe their execution systems via webhook. VEILLE delivers structured signal payloads within 500ms of firing, HMAC-signed for authentication. A subscriber can build automated execution on top of VEILLE's signals without any human in the loop.

---

## Resilience (Production Readiness)

Every failure mode handled without human intervention:

- **SSE drops:** Exponential backoff reconnect (1s → 2s → 4s → 8s → 16s → 30s). Snapshot recovery on reconnect catches any missed events.
- **JWT expiry:** Auto-renewed on 401 before reconnecting.
- **Abandoned matches:** All open positions voided automatically. Excluded from statistics.
- **Postponed matches:** Positions held. CLERK re-checks every poll cycle until match resumes.
- **Duplicate signals:** 5-minute cooldown per match prevents signal clustering.
- **On-chain write failures:** 3 retries with exponential backoff. Signal always saved to Supabase first — never silently dropped. Failed writes surfaced prominently in dashboard.
- **Subscriber delivery failures:** 3 retries per subscriber. Failed deliveries logged with full context.

All events logged to `veille_agent_log` table with severity levels. The agent log is visible in the dashboard — proof the system ran autonomously.

---

## TxLINE Integration

| Endpoint | Agent | Purpose |
|----------|-------|---------|
| `GET /api/odds/stream` (SSE) | SCOUT | Live odds for signal detection |
| `GET /api/scores/stream` (SSE) | SCOUT | Live events for trigger detection |
| `GET /api/fixtures` | Both | Match list, status monitoring |
| `GET /api/scores/{matchId}/history` | CLERK | Final score for settlement |
| `GET /api/odds/{matchId}/history` | CLERK | Odds context at signal time |
| Validation proofs | CLERK | Cryptographic reference for on-chain writes |

**Auth:** Service Level 12 (real-time, free World Cup tier). Mainnet. Server-side only.

---

## Portfolio Statistics

After each settled position, CLERK recalculates:

**Win Rate** — `hits / (hits + misses)`, voids excluded  
**Sharpe Ratio** — `mean(returns) / stddev(returns)`, where returns are +1 (hit) or -1 (miss)  
**Maximum Drawdown** — largest peak-to-trough loss in cumulative P&L series  
**P&L** — net units won/lost across all settled positions

These are the metrics a trading desk actually evaluates. Not just win rate.

---

## Subscriber Webhook Schema

```typescript
{
  veille_version: 1,
  event: 'signal_fired' | 'position_settled',
  signal_id: string,          // UUID — reference to on-chain record
  strategy: 'A' | 'B',
  match_id: string,
  home_team: string,
  away_team: string,
  trigger_event: 'goal' | 'red_card',
  trigger_minute: number,
  favoured_team: 'home' | 'away',
  position: 'long_home' | 'long_away' | 'short_home' | 'short_away',
  pre_event_prob: number,     // 0-1
  post_signal_prob: number,   // 0-1
  delta: number,              // probability shift magnitude
  onchain_tx: string,         // Solana transaction signature
  txline_proof: string,       // TxLINE cryptographic proof reference
  fired_at: number,           // unix timestamp
  outcome?: 'hit' | 'miss' | 'void',  // only on settlement events
  hmac_signature: string      // HMAC-SHA256 for authentication
}
```

---

## Stack

- **Agents:** Node.js 20 + TypeScript
- **Dashboard:** Next.js 16.2 + TypeScript + Tailwind CSS
- **Data:** TxLINE SSE streams (Service Level 12, mainnet)
- **Database:** Supabase
- **On-chain:** Solana Memo Program (no custom contract)
- **Agent deploy:** Railway (SCOUT + CLERK as separate services)
- **Dashboard deploy:** Vercel

---

## Run Locally

```bash
# Clone and install
git clone https://github.com/TheWeirdDee/veille
cd veille
npm install
cp .env.example .env

# One-time setup (run in order)
npm run activate          # Get TxLINE API token
npm run register-signal   # Pre-register signal definition (CRITICAL)
npm run init-portfolio    # Initialize portfolio for Strategy A + B

# Run agents
npm run scout             # VEILLE SCOUT (keep running)
npm run clerk             # VEILLE CLERK (keep running in separate terminal)

# Integration test
npm run test
```

---

## TxLINE API Feedback

**Loved:** The SSE stream architecture is clean and reliable. Service Level 12 being completely free for World Cup data made the hackathon accessible without financial barriers. The cryptographic anchoring on Solana is genuinely novel infrastructure — no other sports data provider offers this. The guest JWT + API token two-credential system is well-documented.

**Friction:** Field names in SSE payloads required trial and error to confirm — minor discrepancies between the API reference and actual stream output. A versioned stream schema document (similar to a JSON Schema file) would eliminate this friction entirely. The on-chain activation flow has many failure points that surface as ambiguous errors; clearer error codes from the activation endpoint would help builders move faster.

---

Built by Divine ([@TheWeirdDee](https://github.com/TheWeirdDee)) · Lagos, Nigeria · 2026
