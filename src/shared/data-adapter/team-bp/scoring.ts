import type { AggregatedAnalysis } from '@shared/data-adapter/analysis/player'
import type { ChampionOverviewItem } from '@shared/data-adapter/champion-data'
import type { OngoingGameSimplifiedChampMastery } from '@shared/shards/ongoing-game'
import {
  TEAM_BP_POSITIONS,
  type TeamBpPickRecommendation,
  type TeamBpPosition,
  type TeamBpRecommendations,
  type TeamBpSession
} from '@shared/shards/team-bp'

export interface TeamBpScoringInput {
  session: TeamBpSession
  overviews: Record<TeamBpPosition, ChampionOverviewItem[]>
  playerAnalysis: Record<string, AggregatedAnalysis>
  championMastery: Record<string, Record<number, OngoingGameSimplifiedChampMastery>>
}

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value))

/**
 * 将 OP.GG 强度、玩家熟练度和当前 BP 状态合并为稳定的基础推荐。
 * AI 只能在这里生成的合法候选中重排，不能绕过已选/已禁和位置约束。
 */
export function scoreTeamBpRecommendations(input: TeamBpScoringInput): TeamBpRecommendations {
  const { championMastery, overviews, playerAnalysis, session } = input
  const unavailableChampionIds = new Set([
    ...session.allyBans,
    ...session.enemyBans,
    ...session.allies.map((member) => member.championId),
    ...session.enemies.map((member) => member.championId)
  ])
  unavailableChampionIds.delete(0)

  const championPositions = new Map<number, Set<TeamBpPosition>>()
  for (const position of TEAM_BP_POSITIONS) {
    for (const item of overviews[position]) {
      const positions = championPositions.get(item.championId) ?? new Set<TeamBpPosition>()
      positions.add(position)
      championPositions.set(item.championId, positions)
    }
  }

  const lockedPositions = new Set(
    session.allies
      .filter((member) => member.championId > 0 && member.position)
      .map((member) => member.position as TeamBpPosition)
  )
  const currentActor = session.allies.find((member) => member.cellId === session.currentActorCellId)
  const targetMembers = currentActor?.position
    ? [currentActor]
    : session.allies.filter((member) => member.position && !lockedPositions.has(member.position))
  const targets = targetMembers.length
    ? targetMembers
    : TEAM_BP_POSITIONS.filter((position) => !lockedPositions.has(position)).map((position) => ({
        cellId: -1,
        puuid: '',
        displayName: '',
        position,
        championId: 0,
        championPickIntent: 0
      }))
  const enemyChampionIds = session.enemies
    .map((member) => member.championId)
    .filter((championId) => championId > 0)
  const picks: TeamBpPickRecommendation[] = []

  for (const member of targets) {
    if (!member.position) continue

    for (const item of overviews[member.position]) {
      if (unavailableChampionIds.has(item.championId)) continue

      const tier = Number(item.performance.strengthTier)
      const tierScore = Number.isFinite(tier) ? 100 - Math.max(0, tier) * 14 : 50
      const winRateScore =
        item.performance.winRate === null ? 50 : clamp(50 + (item.performance.winRate - 0.5) * 500)
      const pickRateScore =
        item.performance.pickRate === null ? 50 : clamp(item.performance.pickRate * 600)
      const meta = clamp(tierScore * 0.55 + winRateScore * 0.3 + pickRateScore * 0.15)

      const analysis = member.puuid
        ? playerAnalysis[member.puuid]?.champions[item.championId]
        : undefined
      const mastery = member.puuid ? championMastery[member.puuid]?.[item.championId] : undefined
      const recentGames = analysis?.winLoss.all.count ?? 0
      const recentWinRate = analysis?.winLoss.all.winRate ?? 0.5
      const masteryScore = mastery
        ? clamp((Math.log10(Math.max(1, mastery.championPoints)) / 6) * 100)
        : 0
      const familiarity =
        recentGames || mastery
          ? clamp(Math.min(recentGames / 10, 1) * 55 + recentWinRate * 20 + masteryScore * 0.25)
          : 45

      const counterCount = enemyChampionIds.filter((championId) =>
        item.counterChampionIds.includes(championId)
      ).length
      const matchup = clamp(65 - counterCount * 32)
      const flexCount = championPositions.get(item.championId)?.size ?? 1
      const completedPickCount =
        session.allies.filter((member) => member.championId > 0).length +
        session.enemies.filter((member) => member.championId > 0).length
      const isEarlyBlindPick = session.side === 'blue' && completedPickCount < 2
      const draftValue = clamp(50 + Math.min(flexCount - 1, 2) * 15 + (isEarlyBlindPick ? 10 : 0))
      const score = clamp(meta * 0.4 + familiarity * 0.3 + matchup * 0.2 + draftValue * 0.1)
      const reasons: TeamBpPickRecommendation['reasons'] = ['fills-open-position']

      if (meta >= 72) reasons.push('meta-strong')
      if (familiarity >= 65) reasons.push('player-familiar')
      if (isEarlyBlindPick && matchup >= 60) reasons.push('safe-blind-pick')
      if (counterCount > 0) reasons.push('counter-risk')
      if (flexCount > 1) reasons.push('flexible-pick')

      picks.push({
        championId: item.championId,
        position: member.position,
        playerPuuid: member.puuid || null,
        score: Math.round(score),
        confidence:
          item.performance.games !== null && (recentGames > 0 || Boolean(mastery))
            ? score >= 72
              ? 'high'
              : 'medium'
            : 'low',
        reasons,
        breakdown: {
          meta: Math.round(meta),
          familiarity: Math.round(familiarity),
          matchup: Math.round(matchup),
          draftValue: Math.round(draftValue)
        }
      })
    }
  }

  picks.sort((left, right) => right.score - left.score)
  const deduplicatedPicks = Array.from(
    new Map(picks.map((recommendation) => [recommendation.championId, recommendation])).values()
  ).slice(0, 15)

  const banCandidates = new Map<number, { score: number; counterPressure: number }>()
  for (const position of TEAM_BP_POSITIONS) {
    for (const item of overviews[position]) {
      if (unavailableChampionIds.has(item.championId)) continue

      const tier = Number(item.performance.strengthTier)
      const tierScore = Number.isFinite(tier) ? 100 - Math.max(0, tier) * 14 : 50
      const banRateScore =
        item.performance.banRate === null ? 35 : clamp(item.performance.banRate * 400)
      const counterPressure = deduplicatedPicks.filter((pick) => {
        const candidate = overviews[pick.position].find(
          (overview) => overview.championId === pick.championId
        )
        return candidate?.counterChampionIds.includes(item.championId)
      }).length
      const score = clamp(tierScore * 0.55 + banRateScore * 0.3 + counterPressure * 8)
      const previous = banCandidates.get(item.championId)
      if (!previous || score > previous.score) {
        banCandidates.set(item.championId, { score, counterPressure })
      }
    }
  }

  const bans = Array.from(banCandidates, ([championId, candidate]) => ({
    championId,
    score: Math.round(candidate.score),
    reasons: [
      'meta-strong' as const,
      ...(candidate.counterPressure > 0 ? (['counter-risk'] as const) : [])
    ]
  }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)

  return { picks: deduplicatedPicks, bans }
}
