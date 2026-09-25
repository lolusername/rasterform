<script setup lang="ts">
import { computed } from 'vue'
import { normalizeNumberControlDisplayValue, numberControlDisplayValue } from '../lib/number-control'

const props = defineProps<{
  modelValue: number
  label: string
  ariaLabel?: string
  min: number
  max: number
  step: number
  neutral?: number
  unit?: string
  displayScale?: number
  help?: string
  disabled?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: number] }>()
const scale = computed(() => props.displayScale ?? 1)
const controlLabel = computed(() => props.ariaLabel ?? props.label)
const displayValue = computed(() => numberControlDisplayValue(props.modelValue, scale.value))
function update(event: Event, inputScale = 1) {
  const input = event.target as HTMLInputElement
  const value = normalizeNumberControlDisplayValue(input.valueAsNumber, props, inputScale)
  if (value === null) { input.value = String(numberControlDisplayValue(props.modelValue, inputScale)); return }
  // Vue need not rerender when normalization returns the current model value.
  // Still replace the typed text so both controls visibly match authored state.
  input.value = String(numberControlDisplayValue(value, inputScale))
  emit('update:modelValue', value)
}
</script>

<template>
  <div class="number-control">
    <label class="number-control__heading"><span>{{ label }}</span><span><input type="number" :aria-label="`${controlLabel} value`" :value="displayValue" :min="numberControlDisplayValue(min, scale)" :max="numberControlDisplayValue(max, scale)" :step="numberControlDisplayValue(step, scale)" :disabled="disabled" @change="update($event, scale)" />{{ unit }}</span></label>
    <input type="range" :aria-label="controlLabel" :aria-valuetext="`${displayValue}${unit ? ` ${unit}` : ''}`" :value="modelValue" :min="min" :max="max" :step="step" :disabled="disabled" @input="update($event)" />
    <div v-if="help || neutral !== undefined" class="number-control__help"><small v-if="help">{{ help }}</small><button v-if="neutral !== undefined" type="button" :disabled="disabled || modelValue === neutral" :aria-label="`Reset ${controlLabel}`" @click="emit('update:modelValue', neutral)">Reset</button></div>
  </div>
</template>

<style scoped>
.number-control { display: grid; gap: 6px; min-width: 0; }
.number-control__heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: #ccc; font-size: 12px; }
.number-control__heading > span { margin: 0; font-size: 12px; line-height: 1.35; }
.number-control__heading > span:last-child { display: flex; align-items: center; gap: 3px; }
.number-control input[type=number] { width: 72px; min-width: 0; min-height: 28px; padding: 4px; border: 1px solid #555; border-radius: 4px; background: #161616; color: #fff; font: inherit; font-variant-numeric: tabular-nums; }
.number-control input[type=range] { width: 100%; min-width: 0; }
.number-control__help { display: flex; align-items: start; gap: 8px; justify-content: space-between; }
.number-control__help small { color: #a9a9a9; font-size: 11px; line-height: 1.45; }
.number-control__help button { flex-shrink: 0; min-height: 24px; margin-left: auto; padding: 3px 5px; background: transparent; border: 0; color: #c9ed83; font-size: 11px; cursor: pointer; }
.number-control :is(input, button):focus-visible { outline: 2px solid #c9ed83; outline-offset: 2px; }
</style>
