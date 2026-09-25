<script setup lang="ts">
import { computed, ref } from 'vue'
import FieldPreview from './FieldPreview.vue'
import { inspectChannel } from '../lib/channel-inspection'
import type { ChannelLayer, PixelImage, ScalarField } from '../types'
const props = defineProps<{ image: PixelImage; layers: ChannelLayer[]; selectedId: string; height: ScalarField }>()
const open = ref(false)
const inspection = computed(() => open.value ? inspectChannel(props.image, props.layers, props.selectedId) : null)
</script>
<template>
  <details class="inspector-section" @toggle="open = ($event.target as HTMLDetailsElement).open">
    <summary><span>Inspect transformation</span><small>Source → form</small></summary>
    <div v-if="open" class="inspector-body">
      <p class="inline-note">These are the actual height calculations. White is raised; black is low. Inspection never changes your form.</p>
      <div class="inspection-grid">
        <FieldPreview label="Source image" :image="image" />
        <FieldPreview v-if="inspection" label="Selected signal · before inversion" :field="inspection.signal" />
        <FieldPreview v-if="inspection" label="Composite before selected channel" :field="inspection.before" />
        <FieldPreview v-if="inspection" label="Composite after selected channel" :field="inspection.after" />
        <FieldPreview label="Final height · after Surface controls" :field="height" />
      </div>
      <p v-if="inspection" class="inline-note">{{ !inspection.enabled ? 'This channel is muted, so before and after are identical.' : inspection.isBase ? 'This is the first enabled channel: it establishes the base.' : 'The selected operation uses the composite above it. Later channels may change this result again.' }} The 3D viewport shows the resulting geometry and material.</p>
    </div>
  </details>
</template>
<style scoped>.inspection-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }</style>
