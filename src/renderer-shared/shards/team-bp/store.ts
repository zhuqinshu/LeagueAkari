import type {
  TeamBpAiRecommendation,
  TeamBpDataMetadata,
  TeamBpStateData
} from '@shared/shards/team-bp'
import { createEmptyTeamBpRecommendations, createEmptyTeamBpSession } from '@shared/shards/team-bp'
import { defineStore } from 'pinia'
import { shallowRef } from 'vue'

export const useTeamBpStore = defineStore('shard:team-bp-renderer', () => {
  const session = shallowRef(createEmptyTeamBpSession())
  const recommendations = shallowRef(createEmptyTeamBpRecommendations())
  const dataStatus = shallowRef<TeamBpStateData['dataStatus']>('idle')
  const dataMetadata = shallowRef<TeamBpDataMetadata | null>(null)
  const dataError = shallowRef<string | null>(null)
  const hasAiApiKey = shallowRef(false)
  const aiStatus = shallowRef<TeamBpStateData['aiStatus']>('disabled')
  const aiRecommendation = shallowRef<TeamBpAiRecommendation | null>(null)
  const aiError = shallowRef<string | null>(null)

  return {
    session,
    recommendations,
    dataStatus,
    dataMetadata,
    dataError,
    hasAiApiKey,
    aiStatus,
    aiRecommendation,
    aiError
  }
})
