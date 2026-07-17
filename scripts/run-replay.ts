try {
  process.loadEnvFile('.env')
} catch {
  /* env from shell */
}

import { startReplay } from '../src/lib/txline/replay'
import { MATCH_WINNER_MARKET } from '../src/lib/txline/normalize'

async function main(): Promise<void> {
  const matchId = process.argv[2]
  if (!matchId) {
    console.error('Usage: npm run replay -- <matchId>')
    process.exitCode = 1
    return
  }

  let events = 0
  let oddsTicks = 0
  await startReplay(
    { matchId, speed: 0 },
    {
      onMatchEvent: () => {
        events += 1
      },
      onOddsEvent: (event) => {
        if (event.market === MATCH_WINNER_MARKET) oddsTicks += 1
      },
      onReconnect: () => undefined,
      onError: (error) => {
        throw error
      },
    }
  )
  console.log(`Replay ${matchId}: ${events} match events, ${oddsTicks} 1X2 ticks processed`)
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
