import type { ChampionOverviewItem } from '@shared/data-adapter/champion-data'
import { TEAM_BP_POSITIONS, createEmptyTeamBpSession } from '@shared/shards/team-bp'
import { describe, expect, it } from 'vitest'

import { scoreTeamBpRecommendations } from './scoring'

function champion(
  championId: number,
  position: (typeof TEAM_BP_POSITIONS)[number],
  tier: number,
  counters: number[] = []
): ChampionOverviewItem {
  return {
    championId,
    position,
    counterChampionIds: counters,
    performance: {
      games: 1000,
      wins: null,
      winRate: 0.52,
      pickRate: 0.08,
      banRate: 0.05,
      kda: 3,
      rank: 1,
      rankChange: 0,
      strengthTier: tier,
      averagePlacement: null,
      firstPlaceRate: null
    }
  }
}

describe('scoreTeamBpRecommendations', () => {
  it('filters unavailable champions and penalizes known counter threats', () => {
    const session = createEmptyTeamBpSession()
    session.phase = 'champ-select'
    session.side = 'red'
    session.allies = [
      {
        cellId: 1,
        puuid: 'ally-top',
        displayName: 'Top',
        position: 'top',
        championId: 0,
        championPickIntent: 0
      }
    ]
    session.enemies = [
      {
        cellId: 6,
        puuid: '',
        displayName: '',
        position: 'top',
        championId: 99,
        championPickIntent: 0
      }
    ]
    session.allyBans = [3]

    const overviews: Record<(typeof TEAM_BP_POSITIONS)[number], ChampionOverviewItem[]> = {
      top: [],
      jungle: [],
      middle: [],
      bottom: [],
      utility: []
    }
    overviews.top = [champion(1, 'top', 1, [99]), champion(2, 'top', 1), champion(3, 'top', 0)]

    const result = scoreTeamBpRecommendations({
      session,
      overviews,
      playerAnalysis: {},
      championMastery: {}
    })

    expect(result.picks.map((item) => item.championId)).toEqual([2, 1])
    expect(result.picks.some((item) => item.championId === 3)).toBe(false)
    expect(result.picks.find((item) => item.championId === 1)?.reasons).toContain('counter-risk')
  })
})
