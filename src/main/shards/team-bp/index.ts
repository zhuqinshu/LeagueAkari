import { IAkariShardInitDispose, Shard } from '@shared/akari-shard'
import { TEAM_BP_MAIN_NAMESPACE } from '@shared/shards/team-bp'
import { z } from 'zod'

import { ChampionDataMain } from '../champion-data'
import { AkariIpcMain } from '../ipc'
import { LeagueClientMain } from '../league-client'
import { LoggerFactoryMain } from '../logger-factory'
import { MobxUtilsMain } from '../mobx-utils'
import { OngoingGameMain } from '../ongoing-game'
import { SettingFactoryMain } from '../setting-factory'
import type { SetterSettingService } from '../setting-factory/setter-setting-service'
import { TeamBpAiCredentialController } from './ai-credential-controller'
import { TeamBpAiRecommendationExecutor } from './ai-recommendation-executor'
import { TeamBpChampionDataLoader } from './champion-data-loader'
import type { TeamBpMainContext } from './context'
import { TeamBpIpcHandlers } from './ipc-handlers'
import { TeamBpRecommendationController } from './recommendation-controller'
import { TeamBpSettings, TeamBpState } from './state'

@Shard(TeamBpMain.id)
export class TeamBpMain implements IAkariShardInitDispose {
  static id = TEAM_BP_MAIN_NAMESPACE

  public readonly settings = new TeamBpSettings()
  public readonly state = new TeamBpState()

  private readonly _settingService: SetterSettingService<TeamBpSettings>
  private readonly _context: TeamBpMainContext
  private readonly _credentialController: TeamBpAiCredentialController
  private readonly _dataLoader: TeamBpChampionDataLoader
  private readonly _aiExecutor: TeamBpAiRecommendationExecutor
  private readonly _recommendationController: TeamBpRecommendationController
  private readonly _ipcHandlers: TeamBpIpcHandlers

  constructor(
    private readonly _ipc: AkariIpcMain,
    private readonly _leagueClient: LeagueClientMain,
    private readonly _ongoingGame: OngoingGameMain,
    private readonly _championData: ChampionDataMain,
    private readonly _mobxUtils: MobxUtilsMain,
    loggerFactory: LoggerFactoryMain,
    settingFactory: SettingFactoryMain
  ) {
    const logger = loggerFactory.create(TeamBpMain.id)
    this._settingService = settingFactory.register(
      TeamBpMain.id,
      {
        encryptedAiApiKey: { default: this.settings.encryptedAiApiKey, schema: z.string() }
      },
      this.settings
    )
    this._context = {
      namespace: TeamBpMain.id,
      logger,
      mobxUtils: this._mobxUtils,
      leagueClient: this._leagueClient,
      ongoingGame: this._ongoingGame,
      championData: this._championData,
      settings: this.settings,
      state: this.state,
      settingService: this._settingService
    }
    this._credentialController = new TeamBpAiCredentialController(this._context)
    this._dataLoader = new TeamBpChampionDataLoader(this._context)
    this._aiExecutor = new TeamBpAiRecommendationExecutor(this._context, this._credentialController)
    this._recommendationController = new TeamBpRecommendationController(
      this._context,
      this._dataLoader,
      this._aiExecutor
    )
    this._ipcHandlers = new TeamBpIpcHandlers(
      this._context,
      this._ipc,
      this._dataLoader,
      this._recommendationController,
      this._credentialController
    )
  }

  async onInit() {
    await this._settingService.applyToState()
    this._mobxUtils.propSync(TeamBpMain.id, 'state', this.state, [
      'session',
      'recommendations',
      'dataStatus',
      'dataMetadata',
      'dataError',
      'hasAiApiKey',
      'aiStatus',
      'aiRecommendation',
      'aiError'
    ])
    this._credentialController.init()
    this._ipcHandlers.register()
    this._recommendationController.start()
    void this._dataLoader.refresh().then(() => this._recommendationController.recompute())
  }

  async onDispose() {
    this._dataLoader.dispose()
    this._recommendationController.dispose()
  }
}
