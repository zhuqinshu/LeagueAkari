<template>
  <div
    class="flex min-h-15 items-center gap-2 rounded border border-black/10 bg-black/3 px-2.5 py-2 dark:border-white/10 dark:bg-white/5"
  >
    <div class="w-11 shrink-0 text-xs font-bold text-black/55 dark:text-white/55">
      {{ positionLabel }}
    </div>
    <ChampionIcon
      v-if="displayChampionId > 0"
      class="size-9 shrink-0 rounded"
      :champion-id="displayChampionId"
    />
    <div
      v-else
      class="size-9 shrink-0 rounded border border-dashed border-black/15 bg-black/3 dark:border-white/15 dark:bg-white/5"
    />
    <div class="min-w-0 flex-1">
      <div class="truncate text-sm font-medium text-black/85 dark:text-white/85">
        {{ member?.displayName || t('teamBp.board.unknownPlayer') }}
      </div>
      <div class="truncate text-xs text-black/50 dark:text-white/50">
        {{
          displayChampionId > 0
            ? resources.champions.name(displayChampionId)
            : t('teamBp.board.waitingForPick')
        }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import ChampionIcon from '@renderer-shared/components/widgets/ChampionIcon.vue'
import { useAkariResourceProvider } from '@renderer-shared/providers/akari-resource'
import type { TeamBpMember } from '@shared/shards/team-bp'
import { useTranslation } from 'i18next-vue'
import { computed } from 'vue'

const props = defineProps<{
  member?: TeamBpMember
  positionLabel: string
}>()

const { t } = useTranslation()
const resources = useAkariResourceProvider()
const displayChampionId = computed(
  () => props.member?.championId || props.member?.championPickIntent || 0
)
</script>
