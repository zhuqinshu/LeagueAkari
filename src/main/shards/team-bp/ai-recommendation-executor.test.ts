import {
  TEAM_BP_AI_ENDPOINT,
  TEAM_BP_AI_MODEL,
  type TeamBpRecommendations,
  createEmptyTeamBpSession
} from '@shared/shards/team-bp'
import axios from 'axios'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TeamBpAiCredentialController } from './ai-credential-controller'
import { TeamBpAiRecommendationExecutor } from './ai-recommendation-executor'
import type { TeamBpMainContext } from './context'

describe('TeamBpAiRecommendationExecutor', () => {
  afterEach(() => vi.restoreAllMocks())

  it('uses the fixed DeepSeek V4 Flash JSON Output contract', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      data: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                primaryPickChampionId: 1,
                alternativePickChampionIds: [2],
                banChampionIds: [3],
                summary: '优先选择一号英雄',
                reasons: ['合法候选中的最高优先级']
              })
            }
          }
        ]
      }
    })
    const context = {
      leagueClient: {
        data: { gameData: { championName: (championId: number) => `Champion ${championId}` } }
      }
    } as unknown as TeamBpMainContext
    const credential = { get: () => 'test-key' } as TeamBpAiCredentialController
    const recommendations: TeamBpRecommendations = {
      picks: [
        {
          championId: 1,
          position: 'top',
          playerPuuid: null,
          score: 90,
          confidence: 'high',
          reasons: ['meta-strong'],
          breakdown: { meta: 90, familiarity: 80, matchup: 70, draftValue: 60 }
        },
        {
          championId: 2,
          position: 'jungle',
          playerPuuid: null,
          score: 80,
          confidence: 'medium',
          reasons: ['fills-open-position'],
          breakdown: { meta: 80, familiarity: 70, matchup: 60, draftValue: 50 }
        }
      ],
      bans: [{ championId: 3, score: 85, reasons: ['counter-risk'] }]
    }

    const result = await new TeamBpAiRecommendationExecutor(context, credential).execute(
      createEmptyTeamBpSession(),
      recommendations
    )

    expect(result.primaryPickChampionId).toBe(1)
    expect(post).toHaveBeenCalledWith(
      TEAM_BP_AI_ENDPOINT,
      expect.objectContaining({
        model: TEAM_BP_AI_MODEL,
        thinking: { type: 'disabled' },
        max_tokens: 700,
        response_format: { type: 'json_object' }
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' })
      })
    )
  })
})
