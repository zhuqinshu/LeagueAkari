<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-3 border-b border-black/10 px-5 py-3 dark:border-white/10">
      <NIcon class="text-2xl"><UserMultiple /></NIcon>
      <div class="min-w-0 flex-1">
        <div class="text-base font-bold text-black/85 dark:text-white/85">
          {{ t('teamBp.title') }}
        </div>
        <div class="truncate text-xs text-black/50 dark:text-white/50">
          {{ dataDescription }}
        </div>
      </div>
      <NTag :type="sideTagType" size="small" :bordered="false">{{ sideLabel }}</NTag>
      <NTag size="small" :bordered="false">{{ phaseLabel }}</NTag>
      <NButton secondary size="small" :loading="store.dataStatus === 'loading'" @click="refresh">
        <template #icon
          ><NIcon><RefreshSharp /></NIcon
        ></template>
        {{ t('teamBp.actions.refresh') }}
      </NButton>
      <NButton
        type="primary"
        size="small"
        :loading="store.aiStatus === 'loading'"
        :disabled="!canRequestAi"
        @click="requestAi"
      >
        <template #icon
          ><NIcon><AiStatus /></NIcon
        ></template>
        {{ t('teamBp.actions.aiAnalyze') }}
      </NButton>
      <NButton secondary size="small" @click="showSettings = true">
        <template #icon
          ><NIcon><Settings /></NIcon
        ></template>
      </NButton>
    </div>

    <NAlert v-if="store.dataError" type="error" :show-icon="false" class="mx-5 mt-3">
      {{ t('teamBp.errors.data', { reason: store.dataError }) }}
    </NAlert>

    <div
      class="grid min-h-0 flex-1 grid-cols-[minmax(220px,1fr)_minmax(260px,1.15fr)_minmax(220px,1fr)] gap-3 p-4"
    >
      <div class="flex min-h-0 flex-col gap-2">
        <div class="text-sm font-bold text-blue-600 dark:text-blue-400">
          {{ t('teamBp.board.allyTeam') }}
        </div>
        <TeamMemberSlot
          v-for="position in positions"
          :key="position"
          :member="allyByPosition[position]"
          :position-label="positionLabel(position)"
        />
        <div class="mt-1 flex min-h-11 items-center gap-1.5 rounded bg-blue-500/8 px-2">
          <span class="mr-1 text-xs font-medium">{{ t('teamBp.board.bans') }}</span>
          <ChampionIcon
            v-for="championId in store.session.allyBans"
            :key="championId"
            class="size-7 rounded opacity-65 grayscale"
            :champion-id="championId"
          />
          <span
            v-if="store.session.allyBans.length === 0"
            class="text-xs text-black/40 dark:text-white/40"
            >—</span
          >
        </div>
      </div>

      <div class="flex min-h-0 flex-col gap-3 overflow-hidden">
        <div
          class="flex items-center justify-between rounded border border-black/10 bg-black/3 px-3 py-2 dark:border-white/10 dark:bg-white/5"
        >
          <div>
            <div class="text-xs text-black/50 dark:text-white/50">
              {{ t('teamBp.board.currentAction') }}
            </div>
            <div class="text-sm font-bold">{{ currentActionLabel }}</div>
          </div>
          <div class="text-right">
            <div class="text-xs text-black/50 dark:text-white/50">
              {{ t('teamBp.board.timeLeft') }}
            </div>
            <div class="font-mono text-lg font-bold">{{ timerText }}</div>
          </div>
        </div>

        <div
          class="min-h-0 flex-1 overflow-auto rounded border border-black/10 dark:border-white/10"
        >
          <div class="border-b border-black/10 px-3 py-2 text-sm font-bold dark:border-white/10">
            {{ t('teamBp.recommendations.title') }}
          </div>
          <div class="flex flex-col gap-1.5 p-2">
            <div
              v-for="recommendation in store.recommendations.picks.slice(0, 8)"
              :key="recommendation.championId"
              class="flex items-center gap-2 rounded bg-black/3 px-2 py-1.5 dark:bg-white/5"
            >
              <ChampionIcon class="size-9 rounded" :champion-id="recommendation.championId" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <span class="truncate text-sm font-medium">{{
                    resources.champions.name(recommendation.championId)
                  }}</span>
                  <NTag size="tiny" :bordered="false">{{
                    positionLabel(recommendation.position)
                  }}</NTag>
                </div>
                <div class="truncate text-xs text-black/50 dark:text-white/50">
                  <template v-if="recommendation.playerPuuid">
                    {{ playerLabel(recommendation.playerPuuid) }} ·
                  </template>
                  {{ recommendation.reasons.slice(0, 3).map(reasonLabel).join(' · ') }}
                </div>
              </div>
              <div class="text-right">
                <div class="text-base font-bold text-(--color-akari)">
                  {{ recommendation.score }}
                </div>
                <div class="text-xs text-black/40 dark:text-white/40">
                  {{ confidenceLabel(recommendation.confidence) }}
                </div>
              </div>
            </div>
            <NEmpty
              v-if="store.recommendations.picks.length === 0"
              size="small"
              :description="t('teamBp.recommendations.empty')"
              class="py-8"
            />
          </div>
        </div>

        <div class="rounded border border-black/10 dark:border-white/10">
          <div
            class="flex items-center gap-2 border-b border-black/10 px-3 py-2 dark:border-white/10"
          >
            <NIcon><AiStatus /></NIcon>
            <span class="text-sm font-bold">{{ t('teamBp.ai.title') }}</span>
            <NTag size="tiny" :bordered="false" :type="aiStatusType">{{ aiStatusLabel }}</NTag>
          </div>
          <div v-if="store.aiRecommendation" class="p-3">
            <div class="text-sm font-medium">{{ store.aiRecommendation.summary }}</div>
            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              <span class="text-xs text-black/50 dark:text-white/50">{{
                t('teamBp.ai.primaryPick')
              }}</span>
              <ChampionIcon
                v-if="store.aiRecommendation.primaryPickChampionId"
                class="size-7 rounded"
                :champion-id="store.aiRecommendation.primaryPickChampionId"
              />
              <span class="ml-2 text-xs text-black/50 dark:text-white/50">{{
                t('teamBp.ai.alternatives')
              }}</span>
              <ChampionIcon
                v-for="championId in store.aiRecommendation.alternativePickChampionIds"
                :key="`ai-pick-${championId}`"
                class="size-7 rounded"
                :champion-id="championId"
              />
              <span class="ml-2 text-xs text-black/50 dark:text-white/50">{{
                t('teamBp.ai.bans')
              }}</span>
              <ChampionIcon
                v-for="championId in store.aiRecommendation.banChampionIds"
                :key="`ai-ban-${championId}`"
                class="size-7 rounded opacity-70 grayscale"
                :champion-id="championId"
              />
            </div>
            <div class="mt-2 flex flex-col gap-1 text-xs text-black/60 dark:text-white/60">
              <div v-for="reason in store.aiRecommendation.reasons" :key="reason">
                • {{ reason }}
              </div>
            </div>
          </div>
          <div v-else class="px-3 py-4 text-xs text-black/50 dark:text-white/50">
            {{ store.aiError || t('teamBp.ai.placeholder') }}
          </div>
        </div>
      </div>

      <div class="flex min-h-0 flex-col gap-2">
        <div class="text-sm font-bold text-red-600 dark:text-red-400">
          {{ t('teamBp.board.enemyTeam') }}
        </div>
        <TeamMemberSlot
          v-for="position in positions"
          :key="position"
          :member="enemyByPosition[position]"
          :position-label="positionLabel(position)"
        />
        <div class="mt-1 flex min-h-11 items-center gap-1.5 rounded bg-red-500/8 px-2">
          <span class="mr-1 text-xs font-medium">{{ t('teamBp.board.bans') }}</span>
          <ChampionIcon
            v-for="championId in store.session.enemyBans"
            :key="championId"
            class="size-7 rounded opacity-65 grayscale"
            :champion-id="championId"
          />
          <span
            v-if="store.session.enemyBans.length === 0"
            class="text-xs text-black/40 dark:text-white/40"
            >—</span
          >
        </div>

        <div class="mt-1 rounded border border-black/10 p-2 dark:border-white/10">
          <div class="mb-2 text-xs font-bold">{{ t('teamBp.recommendations.bans') }}</div>
          <div class="flex flex-wrap gap-2">
            <NTooltip
              v-for="recommendation in store.recommendations.bans.slice(0, 5)"
              :key="recommendation.championId"
            >
              <template #trigger>
                <div class="relative">
                  <ChampionIcon class="size-10 rounded" :champion-id="recommendation.championId" />
                  <div
                    class="absolute -right-1 -bottom-1 rounded bg-red-600 px-1 text-xs text-white"
                  >
                    {{ recommendation.score }}
                  </div>
                </div>
              </template>
              {{ resources.champions.name(recommendation.championId) }} ·
              {{ recommendation.reasons.map(reasonLabel).join(' · ') }}
            </NTooltip>
          </div>
        </div>
      </div>
    </div>

    <NModal v-if="showSettings" v-model:show="showSettings" transform-origin="center">
      <TeamBpSettingsModal
        :has-ai-api-key="store.hasAiApiKey"
        @close="showSettings = false"
        @save="saveSettings"
        @clear-key="clearApiKey"
      />
    </NModal>
  </div>
</template>

<script setup lang="ts">
import ChampionIcon from '@renderer-shared/components/widgets/ChampionIcon.vue'
import { useAkariResourceProvider } from '@renderer-shared/providers/akari-resource'
import { useInstance } from '@renderer-shared/shards'
import { TeamBpRenderer } from '@renderer-shared/shards/team-bp'
import { useTeamBpStore } from '@renderer-shared/shards/team-bp/store'
import {
  TEAM_BP_POSITIONS,
  type TeamBpPosition,
  type TeamBpRecommendationReason
} from '@shared/shards/team-bp'
import { AiStatus, UserMultiple } from '@vicons/carbon'
import { RefreshSharp, Settings } from '@vicons/ionicons5'
import { useTranslation } from 'i18next-vue'
import { NAlert, NButton, NEmpty, NIcon, NModal, NTag, NTooltip } from 'naive-ui'
import { computed, ref } from 'vue'

import TeamBpSettingsModal from './TeamBpSettingsModal.vue'
import TeamMemberSlot from './TeamMemberSlot.vue'

const { t } = useTranslation()
const resources = useAkariResourceProvider()
const teamBp = useInstance(TeamBpRenderer)
const store = useTeamBpStore()
const positions = TEAM_BP_POSITIONS
const showSettings = ref(false)

const allyByPosition = computed(() =>
  Object.fromEntries(
    store.session.allies
      .filter((member) => member.position)
      .map((member) => [member.position, member])
  )
)
const enemyByPosition = computed(() =>
  Object.fromEntries(
    store.session.enemies
      .filter((member) => member.position)
      .map((member) => [member.position, member])
  )
)
const sideLabel = computed(() => t(`teamBp.side.${store.session.side}`))
const sideTagType = computed(() =>
  store.session.side === 'blue' ? 'info' : store.session.side === 'red' ? 'error' : 'default'
)
const phaseLabel = computed(() => t(`teamBp.phase.${store.session.phase}`))
const currentActionLabel = computed(() => {
  if (!store.session.isAllyTurn && store.session.currentAction !== 'none') {
    return t('teamBp.action.enemyTurn', {
      action: t(`teamBp.action.${store.session.currentAction}`)
    })
  }
  return t(`teamBp.action.${store.session.currentAction}`)
})
const timerText = computed(() =>
  store.session.timerMs === null ? '—' : `${Math.max(0, Math.ceil(store.session.timerMs / 1000))}s`
)
const dataDescription = computed(() => {
  if (!store.dataMetadata) return t(`teamBp.dataStatus.${store.dataStatus}`)
  return t('teamBp.dataDescription', {
    source:
      store.dataMetadata.source === 'opgg' ? 'OP.GG' : store.dataMetadata.source.toUpperCase(),
    patch: store.dataMetadata.patch || t('teamBp.latestPatch'),
    region: store.dataMetadata.region.toUpperCase(),
    tier:
      store.dataMetadata.tier === 'emerald_plus' ? t('teamBp.fixedTier') : store.dataMetadata.tier,
    time: store.dataMetadata.updatedAt
      ? new Date(store.dataMetadata.updatedAt).toLocaleString()
      : t('teamBp.unknownUpdateTime')
  })
})
const canRequestAi = computed(() => store.hasAiApiKey && store.recommendations.picks.length > 0)
const aiStatusType = computed(() =>
  store.aiStatus === 'ready' ? 'success' : store.aiStatus === 'failed' ? 'error' : 'default'
)
const aiStatusLabel = computed(() => t(`teamBp.ai.status.${store.aiStatus}`))

const positionLabel = (position: TeamBpPosition) => t(`common:positions.${position}`)
const reasonLabel = (reason: TeamBpRecommendationReason) =>
  t(`teamBp.recommendations.reasons.${reason}`)
const confidenceLabel = (confidence: 'high' | 'medium' | 'low') =>
  t(`teamBp.recommendations.confidence.${confidence}`)
const playerLabel = (puuid: string) =>
  store.session.allies.find((member) => member.puuid === puuid)?.displayName ||
  t('teamBp.board.unknownPlayer')
const refresh = () => void teamBp.refreshChampionData()
const requestAi = () => void teamBp.requestAiRecommendation()

const saveSettings = async (apiKey: string) => {
  if (apiKey.trim()) await teamBp.setAiApiKey(apiKey)
  showSettings.value = false
}

const clearApiKey = async () => {
  await teamBp.setAiApiKey('')
  showSettings.value = false
}
</script>
