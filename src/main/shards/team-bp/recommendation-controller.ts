import { scoreTeamBpRecommendations } from '@shared/data-adapter/team-bp/scoring'
import {
  type TeamBpMember,
  type TeamBpPosition,
  type TeamBpSession,
  createEmptyTeamBpRecommendations,
  createEmptyTeamBpSession
} from '@shared/shards/team-bp'
import type { ChampSelectTeam } from '@shared/types/league-client/champ-select'
import type { Action } from '@shared/types/league-client/champ-select'
import { formatError } from '@shared/utils/errors'
import axios from 'axios'
import { compareStructural } from 'mobx'

import type { TeamBpAiRecommendationExecutor } from './ai-recommendation-executor'
import type { TeamBpChampionDataLoader } from './champion-data-loader'
import type { TeamBpMainContext } from './context'

const POSITION_ALIASES: Readonly<Record<string, TeamBpPosition>> = {
  TOP: 'top',
  JUNGLE: 'jungle',
  MIDDLE: 'middle',
  MID: 'middle',
  BOTTOM: 'bottom',
  ADC: 'bottom',
  UTILITY: 'utility',
  SUPPORT: 'utility'
}

export class TeamBpRecommendationController {
  private _aiTimer: NodeJS.Timeout | null = null
  private _revision = 0
  private readonly _disposers: Array<() => void> = []

  constructor(
    private readonly _context: TeamBpMainContext,
    private readonly _dataLoader: TeamBpChampionDataLoader,
    private readonly _aiExecutor: TeamBpAiRecommendationExecutor
  ) {}

  start() {
    const { leagueClient, mobxUtils, ongoingGame } = this._context
    this._disposers.push(
      mobxUtils.reaction(
        () => ({
          champSelectSession: leagueClient.data.champSelect.session,
          lobby: leagueClient.data.lobby.lobby,
          analysis: ongoingGame.state.analysis,
          masteryShape: Object.entries(ongoingGame.state.championMastery).map(
            ([puuid, champions]) => [puuid, Object.keys(champions).length] as const
          )
        }),
        () => this.recompute(),
        { fireImmediately: true, delay: 80, equals: compareStructural }
      )
    )
  }

  recompute() {
    const { leagueClient, ongoingGame, state } = this._context
    const session = this._buildSession()
    state.setSession(session)
    this._revision++
    this._aiExecutor.cancel()

    if (state.dataStatus !== 'ready') {
      state.setRecommendations(createEmptyTeamBpRecommendations())
      return
    }

    const calculateRecommendations = () =>
      scoreTeamBpRecommendations({
        session,
        overviews: this._dataLoader.overviews,
        playerAnalysis: ongoingGame.state.analysis?.players ?? {},
        championMastery: ongoingGame.state.championMastery,
        details: this._dataLoader.details,
        championRoles: Object.fromEntries(
          Object.values(leagueClient.data.gameData.champions).map((champion) => [
            champion.id,
            champion.roles
          ])
        )
      })
    const recommendations = calculateRecommendations()
    state.setRecommendations(recommendations)
    const revision = this._revision
    void this._dataLoader
      .loadCandidateDetails(recommendations.picks)
      .then((changed) => {
        if (revision !== this._revision) return
        if (changed) state.setRecommendations(calculateRecommendations())
        this._scheduleAiRecommendation()
      })
      .catch((error) => {
        if (revision !== this._revision || axios.isCancel(error)) return
        this._context.logger.warn('Team BP detail loading failed', formatError(error))
        this._scheduleAiRecommendation()
      })
  }

  async requestAiRecommendation() {
    const { state } = this._context
    if (!state.hasAiApiKey) {
      state.setAiIdle(false)
      return
    }

    const revision = this._revision
    state.setAiLoading()
    try {
      const result = await this._aiExecutor.execute(state.session, state.recommendations)
      if (revision === this._revision) state.setAiReady(result)
    } catch (error) {
      if (revision !== this._revision || axios.isCancel(error)) return
      const message = formatError(error)
      state.setAiFailed(message)
      this._context.logger.warn('Team BP AI recommendation failed', message)
    }
  }

  dispose() {
    this._disposers.forEach((dispose) => dispose())
    this._disposers.length = 0
    if (this._aiTimer) clearTimeout(this._aiTimer)
    this._aiTimer = null
    this._aiExecutor.cancel()
  }

  private _scheduleAiRecommendation() {
    const { state } = this._context
    if (this._aiTimer) clearTimeout(this._aiTimer)
    this._aiTimer = null

    if (
      !state.hasAiApiKey ||
      !state.session.isAllyTurn ||
      state.recommendations.pairs.length === 0
    ) {
      return
    }

    // LCU 在一次操作内会连续推送多个状态，短防抖避免重复消耗模型调用。
    this._aiTimer = setTimeout(() => {
      this._aiTimer = null
      void this.requestAiRecommendation()
    }, 450)
  }

  private _buildSession(): TeamBpSession {
    const { leagueClient } = this._context
    const champSelect = leagueClient.data.champSelect.session
    if (champSelect) {
      const actions: Array<Omit<Action, 'type'> & { type: 'pick' | 'ban' }> =
        champSelect.actions.flatMap((group) =>
          group.flatMap((action) => {
            if (action.type !== 'pick' && action.type !== 'ban') return []
            return [{ ...action, type: action.type as 'pick' | 'ban' }]
          })
        )
      const inProgressActions = actions.filter((action) => action.isInProgress)
      const currentAllyAction = inProgressActions.find((action) => action.isAllyAction)
      const currentAction = currentAllyAction ?? inProgressActions[0]
      const firstPick = actions.find((action) => action.type === 'pick')

      return {
        phase: 'champ-select',
        side: firstPick ? (firstPick.isAllyAction ? 'blue' : 'red') : 'unknown',
        currentAction: currentAction?.type ?? 'none',
        isAllyTurn: Boolean(currentAllyAction),
        currentActorCellId:
          currentAllyAction?.type === 'pick' ? currentAllyAction.actorCellId : null,
        timerMs: champSelect.timer.adjustedTimeLeftInPhase,
        allies: champSelect.myTeam.map((member) => this._toMember(member, true)),
        enemies: champSelect.theirTeam.map((member) => this._toMember(member, false)),
        allyBans: champSelect.bans.myTeamBans,
        enemyBans: champSelect.bans.theirTeamBans
      }
    }

    const lobby = leagueClient.data.lobby.lobby
    if (lobby) {
      return {
        ...createEmptyTeamBpSession(),
        phase: 'lobby',
        allies: lobby.members
          .filter((member) => !member.isBot && !member.isSpectator)
          .map((member, index) => ({
            cellId: index,
            puuid: member.puuid,
            displayName: member.summonerName,
            position: POSITION_ALIASES[member.firstPositionPreference.toUpperCase()] ?? null,
            championId: 0,
            championPickIntent: 0
          }))
      }
    }

    return createEmptyTeamBpSession()
  }

  private _toMember(member: ChampSelectTeam, includeIdentity: boolean): TeamBpMember {
    return {
      cellId: member.cellId,
      puuid: includeIdentity ? member.puuid : '',
      displayName: includeIdentity
        ? [member.gameName || member.playerAlias, member.tagLine].filter(Boolean).join('#')
        : '',
      position: POSITION_ALIASES[member.assignedPosition.toUpperCase()] ?? null,
      championId: member.championId,
      championPickIntent: member.championPickIntent
    }
  }
}
