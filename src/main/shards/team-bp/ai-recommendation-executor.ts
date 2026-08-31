import type {
  TeamBpAiRecommendation,
  TeamBpRecommendations,
  TeamBpSession
} from '@shared/shards/team-bp'
import { TEAM_BP_AI_ENDPOINT, TEAM_BP_AI_MODEL } from '@shared/shards/team-bp'
import axios from 'axios'
import { z } from 'zod'

import type { TeamBpAiCredentialController } from './ai-credential-controller'
import type { TeamBpMainContext } from './context'

const aiRecommendationSchema = z.object({
  primaryPairChampionIds: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  alternativePairChampionIds: z
    .array(z.tuple([z.number().int().positive(), z.number().int().positive()]))
    .max(3),
  banChampionIds: z.array(z.number().int().positive()).max(5),
  summary: z.string().min(1).max(500),
  reasons: z.array(z.string().min(1).max(160)).min(1).max(5),
  nextPlan: z.string().min(1).max(300)
})

export class TeamBpAiRecommendationExecutor {
  private _abortController: AbortController | null = null

  constructor(
    private readonly _context: TeamBpMainContext,
    private readonly _credential: TeamBpAiCredentialController
  ) {}

  async execute(session: TeamBpSession, recommendations: TeamBpRecommendations) {
    const { leagueClient } = this._context
    if (recommendations.pairs.length === 0) {
      throw new Error('No legal pick pairs are available')
    }

    this._abortController?.abort()
    this._abortController = new AbortController()
    const apiKey = this._credential.get()
    if (!apiKey) throw new Error('DeepSeek API Key must be configured first')
    const championName = (championId: number) => leagueClient.data.gameData.championName(championId)
    const pairKey = (championIds: [number, number]) =>
      [...championIds].sort((a, b) => a - b).join(':')
    const legalPairKeys = new Set(recommendations.pairs.map((pair) => pairKey(pair.championIds)))
    const legalBanIds = new Set(recommendations.bans.map((item) => item.championId))
    const payload = {
      side: session.side,
      currentAction: session.currentAction,
      allies: session.allies.map((member, index) => ({
        player: `ally-${index + 1}`,
        position: member.position,
        champion: member.championId > 0 ? championName(member.championId) : null
      })),
      enemies: session.enemies.map((member) => ({
        position: member.position,
        champion: member.championId > 0 ? championName(member.championId) : null
      })),
      candidatePairs: recommendations.pairs.slice(0, 10).map((pair) => ({
        championIds: pair.championIds,
        champions: pair.championIds.map(championName),
        assignments: pair.assignments.map((assignment) => ({
          championId: assignment.championId,
          champion: championName(assignment.championId),
          position: assignment.position
        })),
        projectedFinalLineup: pair.projectedFinalLineup.map((assignment) => ({
          ...assignment,
          champion: championName(assignment.championId)
        })),
        score: pair.score,
        confidence: pair.confidence,
        matchupEvidence: pair.matchupEvidence.map((evidence) => ({
          ...evidence,
          champion: championName(evidence.championId),
          enemyChampion: championName(evidence.enemyChampionId)
        })),
        synergyEvidence: pair.synergyEvidence.map((evidence) => ({
          ...evidence,
          champions: evidence.championIds.map(championName)
        })),
        compositionImpact: pair.compositionImpact,
        breakdown: pair.breakdown
      })),
      banCandidates: recommendations.bans.slice(0, 8).map((item) => ({
        championId: item.championId,
        champion: championName(item.championId),
        score: item.score
      }))
    }

    const response = await axios.post(
      TEAM_BP_AI_ENDPOINT,
      {
        model: TEAM_BP_AI_MODEL,
        thinking: { type: 'disabled' },
        messages: [
          {
            role: 'system',
            content:
              '你是英雄联盟五人组排 BP 教练。只能在 candidatePairs 中选择双英雄组合，不得创造候选。只能引用输入提供的 matchupEvidence、synergyEvidence、compositionImpact 和数值评分；不得凭模型记忆声称英雄克制或协同。relationship 为 unknown 或没有证据时必须明确说明证据不足。只输出 JSON，不要 Markdown。JSON 格式示例：{"primaryPairChampionIds":[1,2],"alternativePairChampionIds":[[3,4]],"banChampionIds":[],"summary":"建议摘要","reasons":["带来源的理由"],"nextPlan":"后续选禁计划"}'
          },
          { role: 'user', content: JSON.stringify(payload) }
        ],
        max_tokens: 700,
        response_format: { type: 'json_object' }
      },
      {
        signal: this._abortController.signal,
        timeout: 12_000,
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        }
      }
    )
    const content = response.data?.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new Error(response.data?.choices?.[0]?.message?.refusal ?? 'AI returned no content')
    }

    const parsed = aiRecommendationSchema.parse(JSON.parse(content))
    if (!legalPairKeys.has(pairKey(parsed.primaryPairChampionIds)))
      throw new Error('AI selected a pair outside the legal candidate set')

    const result: TeamBpAiRecommendation = {
      ...parsed,
      alternativePairChampionIds: parsed.alternativePairChampionIds.filter(
        (pair, index, pairs) =>
          legalPairKeys.has(pairKey(pair)) &&
          pairKey(pair) !== pairKey(parsed.primaryPairChampionIds) &&
          pairs.findIndex((candidate) => pairKey(candidate) === pairKey(pair)) === index
      ),
      banChampionIds: Array.from(new Set(parsed.banChampionIds.filter((id) => legalBanIds.has(id))))
    }
    return result
  }

  cancel() {
    this._abortController?.abort()
    this._abortController = null
  }
}
