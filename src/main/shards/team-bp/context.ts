import type { ChampionDataMain } from '@main/shards/champion-data'
import type { LeagueClientMain } from '@main/shards/league-client'
import type { AkariLogger } from '@main/shards/logger-factory'
import type { MobxUtilsMain } from '@main/shards/mobx-utils'
import type { OngoingGameMain } from '@main/shards/ongoing-game'
import type { SetterSettingService } from '@main/shards/setting-factory/setter-setting-service'
import { TEAM_BP_MAIN_NAMESPACE } from '@shared/shards/team-bp'

import type { TeamBpSettings, TeamBpState } from './state'

export { TEAM_BP_MAIN_NAMESPACE }

export interface TeamBpMainContext {
  namespace: string
  logger: AkariLogger
  mobxUtils: MobxUtilsMain
  leagueClient: LeagueClientMain
  ongoingGame: OngoingGameMain
  championData: ChampionDataMain
  settings: TeamBpSettings
  state: TeamBpState
  settingService: SetterSettingService<TeamBpSettings>
}
