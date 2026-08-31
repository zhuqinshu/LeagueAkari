import type {
  TeamBpAiRecommendation,
  TeamBpDataMetadata,
  TeamBpRecommendations,
  TeamBpSession,
  TeamBpStateData
} from '@shared/shards/team-bp'
import { createEmptyTeamBpRecommendations, createEmptyTeamBpSession } from '@shared/shards/team-bp'
import { makeAutoObservable, observableRef, observableStruct } from 'mobx'

export class TeamBpSettings {
  // API Key 只在主进程解密，不参与 propSync。
  encryptedAiApiKey = ''

  constructor() {
    makeAutoObservable(this)
  }
}

export class TeamBpState implements TeamBpStateData {
  session: TeamBpSession = createEmptyTeamBpSession()
  recommendations: TeamBpRecommendations = createEmptyTeamBpRecommendations()
  dataStatus: TeamBpStateData['dataStatus'] = 'idle'
  dataMetadata: TeamBpDataMetadata | null = null
  dataError: string | null = null
  hasAiApiKey = false
  aiStatus: TeamBpStateData['aiStatus'] = 'disabled'
  aiRecommendation: TeamBpAiRecommendation | null = null
  aiError: string | null = null

  constructor() {
    makeAutoObservable(this, {
      session: observableStruct,
      recommendations: observableRef,
      dataMetadata: observableRef,
      aiRecommendation: observableRef
    })
  }

  setSession(value: TeamBpSession) {
    this.session = value
  }

  setRecommendations(value: TeamBpRecommendations) {
    this.recommendations = value
    this.aiRecommendation = null
    this.aiError = null
  }

  setDataLoading() {
    this.dataStatus = 'loading'
    this.dataError = null
  }

  setDataReady(metadata: TeamBpDataMetadata) {
    this.dataStatus = 'ready'
    this.dataMetadata = metadata
    this.dataError = null
  }

  setDataFailed(error: string) {
    this.dataStatus = 'failed'
    this.dataMetadata = null
    this.dataError = error
  }

  setHasAiApiKey(value: boolean) {
    this.hasAiApiKey = value
  }

  setAiIdle(enabled: boolean) {
    this.aiStatus = enabled ? 'idle' : 'disabled'
    this.aiRecommendation = null
    this.aiError = null
  }

  setAiLoading() {
    this.aiStatus = 'loading'
    this.aiError = null
  }

  setAiReady(value: TeamBpAiRecommendation) {
    this.aiStatus = 'ready'
    this.aiRecommendation = value
    this.aiError = null
  }

  setAiFailed(error: string) {
    this.aiStatus = 'failed'
    this.aiRecommendation = null
    this.aiError = error
  }
}
