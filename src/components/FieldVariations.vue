<script setup lang="ts">
import { computed, ref } from 'vue'
import FieldPreview from './FieldPreview.vue'
import { createFieldVariations, FIELD_VARIATIONS, type FieldVariationKey } from '../lib/field-variations'
import type { FieldSettings, ScalarField } from '../types'
const props = defineProps<{ raw: ScalarField; settings: FieldSettings }>()
const emit = defineEmits<{ apply: [key: FieldVariationKey, value: number] }>()
const open = ref(false)
const key = ref<FieldVariationKey>('blur')
const effectiveKey = computed(() => key.value === 'blobDilation' && props.settings.finish !== 'blob' ? 'blur' : key.value)
const choices = computed(() => open.value ? createFieldVariations(props.raw, props.settings, effectiveKey.value) : [])
const option = computed(() => FIELD_VARIATIONS[effectiveKey.value])
</script>
<template>
  <details class="field-variations" @toggle="open = ($event.target as HTMLDetailsElement).open">
    <summary>Compare one setting</summary>
    <div v-if="open">
      <label>Parameter <select v-model="key" aria-label="Parameter to compare"><option value="blur">Base smoothing</option><option value="contrast">Contrast</option><option v-if="settings.finish === 'blob'" value="blobDilation">Dilation</option></select></label>
      <p>Actual height fields; white is raised. Other settings stay fixed. Nothing changes until you apply a value.</p>
      <div class="field-variations__choices"><article v-for="choice in choices" :key="choice.value">
        <FieldPreview :label="`${choice.value}${option.unit}`" :field="choice.field" />
        <button type="button" :aria-label="`Apply ${option.label} ${choice.value}`" :disabled="choice.value === settings[effectiveKey]" @click="emit('apply', effectiveKey, choice.value)">{{ choice.value === settings[effectiveKey] ? 'Current' : 'Apply' }}</button>
      </article></div>
    </div>
  </details>
</template>
<style scoped>
.field-variations { border-top: 1px solid #444; padding-top: 10px; font-size: 12px; }
summary { cursor: pointer; color: #d0eaaa; }
label { display: grid; gap: 5px; margin-top: 10px; }
select { min-width: 0; color: #ddd; background: #222; border: 1px solid #555; padding: 6px; border-radius: 4px; }
p { font-size: 11px; line-height: 1.5; color: #aaa; }
.field-variations__choices { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
button { width: 100%; min-height: 30px; margin-top: 6px; color: #ddd; background: #333; border: 1px solid #555; border-radius: 4px; cursor: pointer; }
button:disabled { color: #aaa; cursor: default; }
</style>
