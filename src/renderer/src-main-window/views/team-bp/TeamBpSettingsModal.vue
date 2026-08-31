<template>
  <NCard
    class="w-150! max-w-[92vw]"
    :title="t('teamBp.settings.title')"
    closable
    @close="emit('close')"
  >
    <NForm label-placement="left" label-width="130" size="small">
      <NAlert type="info" :show-icon="false">
        {{ t('teamBp.settings.fixedDataScope') }}
      </NAlert>
      <NAlert class="mt-2" type="success" :show-icon="false">
        {{ t('teamBp.settings.fixedAiModel') }}
      </NAlert>

      <NDivider>{{ t('teamBp.settings.aiSection') }}</NDivider>
      <NFormItem :label="t('teamBp.settings.aiApiKey')">
        <div class="flex w-full gap-2">
          <NInput
            v-model:value="apiKey"
            type="password"
            show-password-on="click"
            :placeholder="
              hasAiApiKey
                ? t('teamBp.settings.aiApiKeyConfigured')
                : t('teamBp.settings.aiApiKeyRequired')
            "
          />
          <NButton v-if="hasAiApiKey" secondary type="error" @click="emit('clear-key')">
            {{ t('teamBp.settings.clearApiKey') }}
          </NButton>
        </div>
      </NFormItem>
    </NForm>

    <template #footer>
      <div class="flex justify-end gap-2">
        <NButton secondary @click="emit('close')">{{ t('teamBp.settings.cancel') }}</NButton>
        <NButton type="primary" @click="emit('save', apiKey)">
          {{ t('teamBp.settings.save') }}
        </NButton>
      </div>
    </template>
  </NCard>
</template>

<script setup lang="ts">
import { useTranslation } from 'i18next-vue'
import { NAlert, NButton, NCard, NDivider, NForm, NFormItem, NInput } from 'naive-ui'
import { ref } from 'vue'

defineProps<{
  hasAiApiKey: boolean
}>()
const emit = defineEmits<{
  close: []
  save: [apiKey: string]
  'clear-key': []
}>()

const { t } = useTranslation()
const apiKey = ref('')
</script>
