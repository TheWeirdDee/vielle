/**
 * Fund-level portfolio statistics per strategy, recalculated from scratch
 * after every settlement — simple and always consistent, no incremental
 * drift. Fine at hackathon scale (at most a few hundred signals).
 */

import { getSupabase } from './supabase'
import type { Strategy } from '../types'

export function calculateSharpe(returns: number[]): number {
  if (returns.length < 2) return 0
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length
  const stdDev = Math.sqrt(variance)
  return stdDev === 0 ? 0 : Number((mean / stdDev).toFixed(4))
}

export function calculateMaxDrawdown(pnlSeries: number[]): number {
  let peak = pnlSeries[0] ?? 0
  let maxDD = 0
  for (const pnl of pnlSeries) {
    if (pnl > peak) peak = pnl
    const dd = peak - pnl
    if (dd > maxDD) maxDD = dd
  }
  return Number(maxDD.toFixed(4))
}

/** Recompute and persist veille_portfolio for one strategy from all settled signals. */
export async function updatePortfolio(strategy: Strategy): Promise<void> {
  const db = getSupabase()

  const res = await db.from('veille_signals').select('outcome').eq('strategy', strategy).not('outcome', 'is', null)
  if (res.error) throw new Error(`updatePortfolio: ${res.error.message}`)

  const rows = res.data as { outcome: string }[]
  const settled = rows.filter((r) => r.outcome !== 'void')
  const hits = settled.filter((r) => r.outcome === 'hit').length
  const misses = settled.filter((r) => r.outcome === 'miss').length
  const voids = rows.length - settled.length

  const returns = settled.map((r) => (r.outcome === 'hit' ? 1 : -1))
  const pnl = returns.reduce((a, b) => a + b, 0)

  const pnlSeries: number[] = []
  let running = 0
  for (const r of returns) {
    running += r
    pnlSeries.push(running)
  }

  const sharpe = calculateSharpe(returns)
  const maxDrawdown = calculateMaxDrawdown(pnlSeries)
  const peak = Math.max(...pnlSeries, 0)
  const currentDrawdown = Number((peak - pnl).toFixed(4))
  const winRate = settled.length > 0 ? Number((hits / settled.length).toFixed(4)) : 0

  const upd = await db
    .from('veille_portfolio')
    .update({
      total_signals: rows.length,
      total_settled: settled.length,
      hits,
      misses,
      voids,
      win_rate: winRate,
      pnl_units: pnl,
      sharpe_ratio: sharpe,
      max_drawdown: maxDrawdown,
      current_drawdown: currentDrawdown,
      peak_pnl: peak,
      last_updated: new Date().toISOString(),
    })
    .eq('strategy', strategy)
  if (upd.error) throw new Error(`updatePortfolio write: ${upd.error.message}`)
}
