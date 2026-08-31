import { safeStorage } from 'electron'

import type { TeamBpMainContext } from './context'

export class TeamBpAiCredentialController {
  private _apiKey = ''

  constructor(private readonly _context: TeamBpMainContext) {}

  init() {
    const encrypted = this._context.settings.encryptedAiApiKey
    if (!encrypted) {
      this._context.state.setHasAiApiKey(false)
      this._context.state.setAiIdle(false)
      return
    }

    try {
      this._apiKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
      this._context.state.setHasAiApiKey(Boolean(this._apiKey))
      this._context.state.setAiIdle(Boolean(this._apiKey))
    } catch (error) {
      // 加密值无法跨系统账户迁移，导入设置后应要求用户重新填写。
      this._apiKey = ''
      this._context.state.setHasAiApiKey(false)
      this._context.state.setAiIdle(false)
      this._context.logger.warn('Failed to restore Team BP AI credential', error)
    }
  }

  get() {
    return this._apiKey
  }

  async set(apiKey: string) {
    const normalized = apiKey.trim()
    if (!normalized) {
      this._apiKey = ''
      await this._context.settingService.set('encryptedAiApiKey', '')
      this._context.state.setHasAiApiKey(false)
      this._context.state.setAiIdle(false)
      return
    }

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure credential storage is unavailable')
    }

    const encrypted = safeStorage.encryptString(normalized).toString('base64')
    await this._context.settingService.set('encryptedAiApiKey', encrypted)
    this._apiKey = normalized
    this._context.state.setHasAiApiKey(true)
    this._context.state.setAiIdle(true)
  }
}
