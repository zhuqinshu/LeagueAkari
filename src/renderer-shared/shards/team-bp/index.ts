import { Dep, IAkariShardInitDispose, Shard } from '@shared/akari-shard'
import { TEAM_BP_MAIN_NAMESPACE, TEAM_BP_RENDERER_NAMESPACE } from '@shared/shards/team-bp'

import { AkariIpcRenderer } from '../ipc'
import { PiniaMobxUtilsRenderer } from '../pinia-mobx-utils'
import { useTeamBpStore } from './store'

@Shard(TeamBpRenderer.id)
export class TeamBpRenderer implements IAkariShardInitDispose {
  static id = TEAM_BP_RENDERER_NAMESPACE

  constructor(
    @Dep(AkariIpcRenderer) private readonly _ipc: AkariIpcRenderer,
    @Dep(PiniaMobxUtilsRenderer) private readonly _piniaMobxUtils: PiniaMobxUtilsRenderer
  ) {}

  refreshChampionData() {
    return this._ipc.call(TEAM_BP_MAIN_NAMESPACE, 'refreshChampionData')
  }

  requestAiRecommendation() {
    return this._ipc.call(TEAM_BP_MAIN_NAMESPACE, 'requestAiRecommendation')
  }

  setAiApiKey(apiKey: string) {
    return this._ipc.call(TEAM_BP_MAIN_NAMESPACE, 'setAiApiKey', apiKey)
  }

  async onInit() {
    const store = useTeamBpStore()
    await this._piniaMobxUtils.sync(TEAM_BP_MAIN_NAMESPACE, 'state', store)
  }
}
