import type { ChampionDataSourceId } from '@shared/data-adapter/champion-data'

export const TEAM_BP_MAIN_NAMESPACE = 'team-bp-main'
export const TEAM_BP_RENDERER_NAMESPACE = 'team-bp-renderer'
export const TEAM_BP_DATA_SOURCE = 'opgg' as const
export const TEAM_BP_DATA_REGION = 'kr'
export const TEAM_BP_DATA_TIER = 'emerald_plus'
export const TEAM_BP_AI_ENDPOINT = 'https://api.deepseek.com/chat/completions'
export const TEAM_BP_AI_MODEL = 'deepseek-v4-flash'

export const TEAM_BP_POSITIONS = ['top', 'jungle', 'middle', 'bottom', 'utility'] as const

export type TeamBpPosition = (typeof TEAM_BP_POSITIONS)[number]
export type TeamBpSide = 'blue' | 'red' | 'unknown'
export type TeamBpActionType = 'pick' | 'ban' | 'none'

export interface TeamBpMember {
  cellId: number
  puuid: string
  displayName: string
  position: TeamBpPosition | null
  championId: number
  championPickIntent: number
}

export interface TeamBpSession {
  phase: 'unavailable' | 'lobby' | 'champ-select'
  side: TeamBpSide
  currentAction: TeamBpActionType
  isAllyTurn: boolean
  currentActorCellId: number | null
  timerMs: number | null
  allies: TeamBpMember[]
  enemies: TeamBpMember[]
  allyBans: number[]
  enemyBans: number[]
}

export type TeamBpRecommendationReason =
  | 'meta-strong'
  | 'player-familiar'
  | 'safe-blind-pick'
  | 'counter-risk'
  | 'fills-open-position'
  | 'flexible-pick'

export interface TeamBpPickRecommendation {
  championId: number
  position: TeamBpPosition
  playerPuuid: string | null
  score: number
  confidence: 'high' | 'medium' | 'low'
  reasons: TeamBpRecommendationReason[]
  breakdown: {
    meta: number
    familiarity: number
    matchup: number
    draftValue: number
  }
}

export interface TeamBpBanRecommendation {
  championId: number
  score: number
  reasons: TeamBpRecommendationReason[]
}

export interface TeamBpRecommendations {
  picks: TeamBpPickRecommendation[]
  bans: TeamBpBanRecommendation[]
}

export interface TeamBpAiRecommendation {
  primaryPickChampionId: number | null
  alternativePickChampionIds: number[]
  banChampionIds: number[]
  summary: string
  reasons: string[]
}

export interface TeamBpDataMetadata {
  source: ChampionDataSourceId
  patch: string | null
  updatedAt: string | null
  region: string
  tier: string
}

export interface TeamBpStateData {
  session: TeamBpSession
  recommendations: TeamBpRecommendations
  dataStatus: 'idle' | 'loading' | 'ready' | 'failed'
  dataMetadata: TeamBpDataMetadata | null
  dataError: string | null
  hasAiApiKey: boolean
  aiStatus: 'disabled' | 'idle' | 'loading' | 'ready' | 'failed'
  aiRecommendation: TeamBpAiRecommendation | null
  aiError: string | null
}

export function createEmptyTeamBpSession(): TeamBpSession {
  return {
    phase: 'unavailable',
    side: 'unknown',
    currentAction: 'none',
    isAllyTurn: false,
    currentActorCellId: null,
    timerMs: null,
    allies: [],
    enemies: [],
    allyBans: [],
    enemyBans: []
  }
}

export function createEmptyTeamBpRecommendations(): TeamBpRecommendations {
  return { picks: [], bans: [] }
}
