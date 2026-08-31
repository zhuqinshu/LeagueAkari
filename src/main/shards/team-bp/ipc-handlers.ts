import type { AkariIpcMain } from '@main/shards/ipc'

import type { TeamBpAiCredentialController } from './ai-credential-controller'
import type { TeamBpChampionDataLoader } from './champion-data-loader'
import type { TeamBpMainContext } from './context'
import type { TeamBpRecommendationController } from './recommendation-controller'

export class TeamBpIpcHandlers {
  constructor(
    private readonly _context: TeamBpMainContext,
    private readonly _ipc: AkariIpcMain,
    private readonly _dataLoader: TeamBpChampionDataLoader,
    private readonly _recommendationController: TeamBpRecommendationController,
    private readonly _credentialController: TeamBpAiCredentialController
  ) {}

  register() {
    const { namespace } = this._context
    this._ipc.onCall(namespace, 'refreshChampionData', async () => {
      await this._dataLoader.refresh()
      this._recommendationController.recompute()
    })
    this._ipc.onCall(namespace, 'requestAiRecommendation', () =>
      this._recommendationController.requestAiRecommendation()
    )
    this._ipc.onCall(namespace, 'setAiApiKey', async (_, apiKey: string) => {
      await this._credentialController.set(apiKey)
      // Key 变化后重算版本号并取消旧请求；若正值我方回合，会按新 Key 自动发起分析。
      this._recommendationController.recompute()
    })
  }
}
