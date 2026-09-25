<script setup lang="ts">
import { ref, watch } from 'vue'
import { drawPixelImage, drawScalarField } from '../lib/image'
import type { PixelImage, ScalarField } from '../types'
const props = defineProps<{ label: string; field?: ScalarField; image?: PixelImage }>()
const canvas = ref<HTMLCanvasElement | null>(null)
watch([canvas, () => props.field, () => props.image], () => {
  if (!canvas.value) return
  if (props.field) drawScalarField(canvas.value, props.field)
  else if (props.image) drawPixelImage(canvas.value, props.image)
}, { immediate: true, flush: 'post' })
</script>
<template><figure><figcaption>{{ label }}</figcaption><canvas ref="canvas" :aria-label="label" /></figure></template>
<style scoped>
figure { margin: 0; min-width: 0; }
figcaption { font-size: 11px; color: #bbb; margin-bottom: 5px; }
canvas { display: block; width: 100%; height: auto; max-height: 150px; object-fit: contain; background: #101010; border-radius: 3px; }
</style>
