/**
 * Initialize veille_portfolio rows for Strategy A and B. Idempotent (upsert
 * on the strategy unique key) — safe to re-run.
 *
 *   npx tsx scripts/init-portfolio.ts
 */

try {
  process.loadEnvFile('.env')
} catch {
  /* env from shell */
}

import { getSupabase } from '../src/lib/supabase'

async function main(): Promise<void> {
  const res = await getSupabase()
    .from('veille_portfolio')
    .upsert(
      [
        { strategy: 'A', total_signals: 0, total_settled: 0, hits: 0, misses: 0, voids: 0, pnl_units: 0 },
        { strategy: 'B', total_signals: 0, total_settled: 0, hits: 0, misses: 0, voids: 0, pnl_units: 0 },
      ],
      { onConflict: 'strategy' }
    )
  if (res.error) throw new Error(res.error.message)
  console.log('Portfolio initialized for Strategy A and B.')
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
