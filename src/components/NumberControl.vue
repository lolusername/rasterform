<script setup lang="ts">
const props = defineProps<{
  modelValue: number
  label: string
  min: number
  max: number
  step: number
  neutral?: number
  unit?: string
  help?: string
  disabled?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: number] }>()
function update(event: Event) {
  const input = event.target as HTMLInputElement
  const value = input.valueAsNumber
  if (!Number.isFinite(value)) { input.value = String(props.modelValue); return }
  emit('update:modelValue', Math.min(props.max, Math.max(props.min, value)))
}
</script>

<template>
  <div class="number-control">
    <label class="number-control__heading"><span>{{ label }}</span><span><input type="number" :aria-label="`${label} value`" :value="modelValue" :min="min" :max="max" :step="step" :disabled="disabled" @change="update" />{{ unit }}</span></label>
    <input type="range" :aria-label="label" :value="modelValue" :min="min" :max="max" :step="step" :disabled="disabled" @input="update" />
    <div v-if="help || neutral !== undefined" class="number-control__help"><small v-if="help">{{ help }}</small><button v-if="neutral !== undefined" type="button" :disabled="disabled || modelValue === neutral" :aria-label="`Reset ${label}`" @click="emit('update:modelValue', neutral)">Reset</button></div>
  </div>
</template>

<style scoped>
.number-control { display: grid; gap: 6px; min-width: 0; }
.number-control__heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: #ccc; font-size: 12px; }
.number-control__heading > span:last-child { display: flex; align-items: center; gap: 3px; }
.number-control input[type=number] { width: 72px; min-width: 0; padding: 4px; border: 1px solid #555; border-radius: 4px; background: #161616; color: #fff; font: inherit; }
.number-control input[type=range] { width: 100%; min-width: 0; }
.number-control__help { display: flex; align-items: start; gap: 8px; justify-content: space-between; }
.number-control__help small { color: #a9a9a9; font-size: 11px; line-height: 1.45; }
.number-control__help button { background: transparent; border: 0; color: #c9ed83; font-size: 11px; padding: 2px; cursor: pointer; }
</style>
