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
  primaryPickChampionId: z.number().int().positive().nullable(),
  alternativePickChampionIds: z.array(z.number().int().positive()).max(5),
  banChampionIds: z.array(z.number().int().positive()).max(5),
  summary: z.string().min(1).max(500),
  reasons: z.array(z.string().min(1).max(160)).min(1).max(5)
})

export class TeamBpAiRecommendationExecutor {
  private _abortController: AbortController | null = null

  constructor(
    private readonly _context: TeamBpMainContext,
    private readonly _credential: TeamBpAiCredentialController
  ) {}

  async execute(session: TeamBpSession, recommendations: TeamBpRecommendations) {
    const { leagueClient } = this._context
    if (recommendations.picks.length === 0) {
      throw new Error('No legal pick candidates are available')
    }

    this._abortController?.abort()
    this._abortController = new AbortController()
    const apiKey = this._credential.get()
    if (!apiKey) throw new Error('DeepSeek API Key must be configured first')
    const championName = (championId: number) => leagueClient.data.gameData.championName(championId)
    const legalPickIds = new Set(recommendations.picks.map((item) => item.championId))
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
      pickCandidates: recommendations.picks.slice(0, 12).map((item) => ({
        championId: item.championId,
        champion: championName(item.championId),
        position: item.position,
        score: item.score,
        breakdown: item.breakdown
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
              '你是英雄联盟五人组排 BP 教练。只能使用用户提供的合法候选英雄 ID，不得创造候选。结合先后手、摇摆位、已知对位和阵容结构给出简洁中文建议。只输出 JSON，不要 Markdown。JSON 格式示例：{"primaryPickChampionId":1,"alternativePickChampionIds":[2],"banChampionIds":[3],"summary":"建议摘要","reasons":["理由"]}'
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
    if (parsed.primaryPickChampionId !== null && !legalPickIds.has(parsed.primaryPickChampionId)) {
      throw new Error('AI selected a champion outside the legal candidate set')
    }

    const result: TeamBpAiRecommendation = {
      ...parsed,
      alternativePickChampionIds: Array.from(
        new Set(
          parsed.alternativePickChampionIds.filter(
            (id) => legalPickIds.has(id) && id !== parsed.primaryPickChampionId
          )
        )
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
