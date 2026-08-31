import type { AggregatedAnalysis } from '@shared/data-adapter/analysis/player'
import type { ChampionDataDetails, ChampionOverviewItem } from '@shared/data-adapter/champion-data'
import type { OngoingGameSimplifiedChampMastery } from '@shared/shards/ongoing-game'
import {
  TEAM_BP_POSITIONS,
  type TeamBpPairRecommendation,
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
  details?: Record<string, ChampionDataDetails>
  championRoles?: Record<number, string[]>
}

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value))

export function createTeamBpDetailKey(championId: number, position: TeamBpPosition) {
  return `${championId}:${position}`
}

/**
 * 将 OP.GG 强度、玩家熟练度和当前 BP 状态合并为稳定的基础推荐。
 * AI 只能在这里生成的合法候选中重排，不能绕过已选/已禁和位置约束。
 */
export function scoreTeamBpRecommendations(input: TeamBpScoringInput): TeamBpRecommendations {
  const {
    championMastery,
    details = {},
    championRoles = {},
    overviews,
    playerAnalysis,
    session
  } = input
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
  const candidatePicks = picks.slice(0, 20)
  const seenChampionIds = new Set<number>()
  const deduplicatedPicks = candidatePicks
    .filter((recommendation) => {
      if (seenChampionIds.has(recommendation.championId)) return false
      seenChampionIds.add(recommendation.championId)
      return true
    })
    .slice(0, 15)

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

  const pairs: TeamBpPairRecommendation[] = []
  const lockedAllyChampionIds = session.allies
    .map((member) => member.championId)
    .filter((championId) => championId > 0)
  for (let leftIndex = 0; leftIndex < candidatePicks.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidatePicks.length; rightIndex++) {
      const left = candidatePicks[leftIndex]
      const right = candidatePicks[rightIndex]
      if (left.championId === right.championId || left.position === right.position) continue

      const usedChampionIds = new Set([
        ...session.allies.map((member) => member.championId).filter((id) => id > 0),
        left.championId,
        right.championId
      ])
      const occupiedPositions = new Set([
        ...session.allies
          .filter((member) => member.championId > 0)
          .map((member) => member.position),
        left.position,
        right.position
      ])
      // 本轮选择后继续贪心补全剩余位置，组合评分始终面向最终五人阵容。
      const futurePicks = TEAM_BP_POSITIONS.flatMap((position) => {
        if (occupiedPositions.has(position)) return []
        const candidate = candidatePicks.find(
          (pick) => pick.position === position && !usedChampionIds.has(pick.championId)
        )
        if (!candidate) return []
        usedChampionIds.add(candidate.championId)
        return [candidate]
      })

      const matchupEvidence = [left, right].flatMap((candidate) => {
        const detail = details[createTeamBpDetailKey(candidate.championId, candidate.position)]
        return session.enemies.flatMap((enemy) => {
          if (enemy.championId <= 0) return []
          const matchup = detail?.sections.matchups?.find(
            (item) => item.championId === enemy.championId
          )
          if (!matchup) return []
          return [
            {
              championId: candidate.championId,
              enemyChampionId: enemy.championId,
              relationship: matchup.relationship,
              winRate: matchup.performance.winRate,
              games: matchup.performance.games,
              isDirectPosition: candidate.position === enemy.position,
              source: 'opgg' as const
            }
          ]
        })
      })
      const collectedSynergyEvidence = [left, right].flatMap((candidate) => {
        const detail = details[createTeamBpDetailKey(candidate.championId, candidate.position)]
        const otherPairChampionId =
          candidate.championId === left.championId ? right.championId : left.championId
        return [otherPairChampionId, ...lockedAllyChampionIds]
          .filter((championId) => championId !== candidate.championId)
          .flatMap((championId) => {
            const synergy = detail?.sections.synergies?.find((item) =>
              item.championIds.includes(championId)
            )
            if (!synergy) return []
            return [
              {
                championIds: [candidate.championId, championId] as [number, number],
                winRate: synergy.performance.winRate,
                games: synergy.performance.games,
                source: 'opgg' as const
              }
            ]
          })
      })
      const seenSynergies = new Set<string>()
      const synergyEvidence = collectedSynergyEvidence.filter((evidence) => {
        const key = [...evidence.championIds].sort((a, b) => a - b).join(':')
        if (seenSynergies.has(key)) return false
        seenSynergies.add(key)
        return true
      })
      const allChampionIds = [
        ...lockedAllyChampionIds,
        left.championId,
        right.championId,
        ...futurePicks.map((pick) => pick.championId)
      ]
      const roles = new Set(
        allChampionIds
          .flatMap((championId) => championRoles[championId] ?? [])
          .map((role) => role.toLowerCase())
      )
      const adds = [
        ...(roles.has('tank') ? ['frontline', 'engage'] : []),
        ...(roles.has('mage') ? ['magic-damage', 'waveclear'] : []),
        ...(roles.has('marksman') ? ['physical-damage', 'late-carry'] : []),
        ...(roles.has('support') ? ['peel', 'utility'] : []),
        ...(roles.has('assassin') ? ['backline-access'] : [])
      ]
      const missingAfterPick = [
        ...(!roles.has('tank') ? ['frontline'] : []),
        ...(!roles.has('mage') ? ['magic-damage'] : []),
        ...(!roles.has('marksman') ? ['physical-damage'] : [])
      ]
      const risks = missingAfterPick.map((item) => `missing-${item}`)
      const synergyRates = synergyEvidence
        .map((evidence) => evidence.winRate)
        .filter((winRate): winRate is number => winRate !== null)
      const synergy = synergyRates.length
        ? clamp(
            synergyRates.reduce((sum, winRate) => sum + 50 + (winRate - 0.5) * 500, 0) /
              synergyRates.length
          )
        : 50
      const currentIndividual = (left.score + right.score) / 2
      const futureIndividual = futurePicks.length
        ? futurePicks.reduce((sum, pick) => sum + pick.score, 0) / futurePicks.length
        : currentIndividual
      const individual = currentIndividual * 0.7 + futureIndividual * 0.3
      const detailedMatchupScores = [left, right].map((candidate) => {
        const directEvidence = matchupEvidence.filter(
          (evidence) => evidence.championId === candidate.championId && evidence.isDirectPosition
        )
        if (!directEvidence.length) return candidate.breakdown.matchup

        return (
          directEvidence.reduce((sum, evidence) => {
            const rawScore =
              evidence.winRate !== null
                ? clamp(50 + (evidence.winRate - 0.5) * 500)
                : evidence.relationship === 'favorable'
                  ? 65
                  : evidence.relationship === 'unfavorable'
                    ? 35
                    : 50
            // 小样本向 50 分收缩，500 场及以上才完整采用详细胜率。
            const confidenceWeight =
              evidence.games !== null
                ? Math.min(evidence.games / 500, 1)
                : evidence.relationship === 'unknown'
                  ? 0
                  : 0.5
            return sum + 50 + (rawScore - 50) * confidenceWeight
          }, 0) / directEvidence.length
        )
      })
      const matchup =
        detailedMatchupScores.reduce((sum, score) => sum + score, 0) / detailedMatchupScores.length
      const composition = clamp(55 + adds.length * 4 - missingAfterPick.length * 8)
      const draftValue = (left.breakdown.draftValue + right.breakdown.draftValue) / 2
      const score = clamp(
        individual * 0.4 + matchup * 0.2 + synergy * 0.2 + composition * 0.15 + draftValue * 0.05
      )
      const evidenceGames = [...matchupEvidence, ...synergyEvidence]
        .map((evidence) => evidence.games ?? 0)
        .reduce((sum, games) => sum + games, 0)

      pairs.push({
        championIds: [left.championId, right.championId],
        assignments: [left, right].map((candidate) => ({
          championId: candidate.championId,
          position: candidate.position,
          playerPuuid: candidate.playerPuuid
        })),
        projectedFinalLineup: [
          ...session.allies
            .filter((member) => member.championId > 0 && member.position)
            .map((member) => ({ championId: member.championId, position: member.position! })),
          ...[left, right, ...futurePicks].map((pick) => ({
            championId: pick.championId,
            position: pick.position
          }))
        ],
        score: Math.round(score),
        confidence: evidenceGames >= 500 ? 'high' : evidenceGames > 0 ? 'medium' : 'low',
        matchupEvidence,
        synergyEvidence,
        compositionImpact: { adds: [...new Set(adds)], missingAfterPick, risks },
        breakdown: {
          individual: Math.round(individual),
          matchup: Math.round(matchup),
          synergy: Math.round(synergy),
          composition: Math.round(composition),
          draftValue: Math.round(draftValue)
        }
      })
    }
  }
  pairs.sort((left, right) => right.score - left.score)
  const seenPairAssignments = new Set<string>()
  const uniquePairs = pairs.filter((pair) => {
    const key = pair.assignments
      .map((assignment) => `${assignment.championId}:${assignment.position}`)
      .sort()
      .join('|')
    if (seenPairAssignments.has(key)) return false
    seenPairAssignments.add(key)
    return true
  })

  return { picks: candidatePicks, bans, pairs: uniquePairs.slice(0, 20) }
}
