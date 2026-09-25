<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import FieldPreview from './FieldPreview.vue'
import { inspectChannel } from '../lib/channel-inspection'
import { describeChannel } from '../lib/channel-presentation'
import type { ChannelLayer, PixelImage, ScalarField } from '../types'
const props = defineProps<{ image: PixelImage; layers: ChannelLayer[]; selectedId: string; height: ScalarField }>()
const open = ref(false)
const section = ref<HTMLDetailsElement | null>(null)
const heading = ref<HTMLElement | null>(null)
const channel = computed(() => describeChannel(props.layers, props.selectedId))
const inspection = computed(() => open.value ? inspectChannel(props.image, props.layers, props.selectedId) : null)

async function reveal(): Promise<void> {
  open.value = true
  if (section.value) section.value.open = true
  await nextTick()
  heading.value?.focus({ preventScroll: true })
  heading.value?.scrollIntoView({ block: 'start', inline: 'nearest' })
}

defineExpose({ reveal })
</script>
<template>
  <details ref="section" class="inspector-section" @toggle="open = ($event.target as HTMLDetailsElement).open">
    <summary><span>Inspect transformation</span><small>{{ channel ? `${channel.source} · ${channel.status}` : 'Source → form' }}</small></summary>
    <div v-if="open" class="inspector-body">
      <h3 ref="heading" class="inspection-heading" tabindex="-1">{{ channel ? `${channel.source} · channel ${channel.position} of ${channel.count}` : 'Source to form' }}</h3>
      <template v-if="channel">
        <dl class="inspection-facts">
          <div><dt>Status</dt><dd>{{ channel.status }}</dd></div>
          <div><dt>Combine</dt><dd>{{ channel.isBase ? `Base · ${channel.operation} bypassed` : channel.operation + (channel.enabled ? '' : ' · inactive') }}</dd></div>
          <div><dt>Influence</dt><dd>{{ channel.influence }}%{{ channel.enabled ? '' : ' · inactive' }}</dd></div>
          <div><dt>Invert signal</dt><dd>{{ channel.inversion }}</dd></div>
          <div v-if="channel.hue !== null"><dt>Target hue</dt><dd>{{ channel.hue }}°</dd></div>
        </dl>
        <p class="inline-note">{{ channel.rule }}</p>
      </template>
      <p class="inline-note">These are the actual working-resolution calculations, not estimated contributions. White represents a higher field value; black represents a lower value. Inspection never changes your form. Select any map to enlarge it.</p>
      <div class="inspection-grid">
        <FieldPreview label="Source image" :image="image" />
        <FieldPreview v-if="inspection" :label="`${channel?.source ?? 'Selected signal'} · before inversion`" :field="inspection.signal" />
        <FieldPreview v-if="inspection" label="Composite before selected channel" :field="inspection.before" />
        <FieldPreview v-if="inspection" label="Composite after selected channel" :field="inspection.after" />
        <FieldPreview label="Final height · after Surface controls" :field="height" />
      </div>
      <p v-if="inspection" class="inline-note">Before and after show the stack immediately around this channel. Later channels and Surface controls can change it again. These maps show height values, not rendered color, gloss or lighting; the 3D viewport shows the resulting geometry and material.</p>
    </div>
  </details>
</template>
<style scoped>
.inspection-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.inspection-heading { margin: 0 0 10px; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; scroll-margin-block-start: 76px; }
.inspection-heading:focus-visible { outline: 2px solid #c5f56b; outline-offset: 3px; }
.inspection-facts { margin: 0; font-size: 11px; line-height: 1.5; }
.inspection-facts > div { display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: 8px; padding-block: 3px; }
dt { color: #aaa; }
dd { margin: 0; color: #ddd; overflow-wrap: anywhere; }
</style>
