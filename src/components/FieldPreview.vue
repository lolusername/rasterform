<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { drawPixelImage, drawScalarField } from '../lib/image'
import type { PixelImage, ScalarField } from '../types'
const props = defineProps<{ label: string; field?: ScalarField; image?: PixelImage }>()
const canvas = ref<HTMLCanvasElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const dialog = ref<HTMLDialogElement | null>(null)
const expanded = ref(false)
const enlargedImage = ref('')
const titleId = useId()
const descriptionId = useId()
const dimensions = computed(() => props.field ?? props.image)

function updateEnlargement() {
  if (canvas.value) enlargedImage.value = canvas.value.toDataURL('image/png')
}

watch([canvas, () => props.field, () => props.image], () => {
  if (!canvas.value) return
  if (props.field) drawScalarField(canvas.value, props.field)
  else if (props.image) drawPixelImage(canvas.value, props.image)
  if (expanded.value) updateEnlargement()
}, { immediate: true, flush: 'post' })

async function enlarge() {
  if (!dimensions.value || !canvas.value) return
  updateEnlargement()
  expanded.value = true
  await nextTick()
  dialog.value?.showModal()
}

function closed() {
  expanded.value = false
  enlargedImage.value = ''
  if (trigger.value?.getClientRects().length) {
    trigger.value.focus({ preventScroll: true })
    return
  }
  // A resize can hide the originating inspector behind a compact-layout tab.
  // Return to its visible entry point instead of leaving focus on the body.
  let ancestor: HTMLElement | null = trigger.value?.parentElement ?? null
  while (ancestor) {
    const ancestorId = ancestor.id
    if (ancestorId) {
      const entry = [...document.querySelectorAll<HTMLElement>('button[aria-controls], [role="tab"][aria-controls]')]
        .find(element => element.getAttribute('aria-controls')?.split(/\s+/).includes(ancestorId) && element.getClientRects().length)
      if (entry) {
        entry.focus({ preventScroll: true })
        return
      }
    }
    ancestor = ancestor.parentElement
  }
}

function closeFromBackdrop(event: MouseEvent) {
  if (event.target !== dialog.value || !dialog.value) return
  const bounds = dialog.value.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
    dialog.value.close()
  }
}
</script>
<template>
  <figure>
    <figcaption>{{ label }}</figcaption>
    <button ref="trigger" type="button" class="field-preview-trigger" :aria-label="`Enlarge ${label}`" aria-haspopup="dialog" :disabled="!dimensions" @click="enlarge">
      <canvas ref="canvas" role="img" :aria-label="label" />
      <span aria-hidden="true">Enlarge</span>
    </button>
  </figure>
  <Teleport to="body">
    <dialog ref="dialog" class="field-preview-dialog" :aria-labelledby="titleId" :aria-describedby="descriptionId" @close="closed" @click="closeFromBackdrop" @keydown.stop @keyup.stop>
      <div class="field-preview-dialog__content">
        <header>
          <h2 :id="titleId">{{ label }}</h2>
          <button type="button" class="field-preview-close" autofocus @click="dialog?.close()">Close<span class="field-preview-close__hint" aria-hidden="true"> · Esc</span></button>
        </header>
        <p :id="descriptionId">{{ dimensions?.width }} × {{ dimensions?.height }} px · working-resolution {{ field ? 'height field' : 'source image' }}. Inspection only; your design and export quality are unchanged.</p>
        <img v-if="expanded" :src="enlargedImage" :alt="label" />
        <p v-if="field" class="field-preview-legend"><span>Black · lower value</span><span>White · higher value</span></p>
      </div>
    </dialog>
  </Teleport>
</template>
<style scoped>
figure { margin: 0; min-width: 0; }
figcaption { font-size: 11px; color: #bbb; margin-bottom: 5px; }
canvas { display: block; width: 100%; height: auto; max-height: 150px; object-fit: contain; background: #101010; border-radius: 3px; }
.field-preview-trigger { display: block; width: 100%; padding: 0; overflow: hidden; background: #171717; border: 1px solid #454545; border-radius: 4px; cursor: zoom-in; color: #ccc; }
.field-preview-trigger > span { display: block; padding: 4px 6px; font-size: 11px; }
.field-preview-trigger:hover { border-color: #8eaa66; }
.field-preview-trigger:focus-visible, .field-preview-close:focus-visible { outline: 2px solid #c5f56b; outline-offset: 3px; }
.field-preview-dialog { box-sizing: border-box; position: fixed; width: min(960px, calc(100vw - 24px)); max-width: calc(100vw - 24px); max-height: calc(100dvh - 24px); padding: 16px; overflow: auto; color: #eee; background: #202020; border: 1px solid #626262; border-radius: 10px; }
.field-preview-dialog::backdrop { background: rgb(0 0 0 / 0.78); }
.field-preview-dialog__content { min-width: 0; }
header { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
h2 { margin: 0; font-size: 16px; line-height: 1.4; overflow-wrap: anywhere; }
.field-preview-close { flex: none; min-height: 36px; padding: 6px 12px; color: #eee; background: #363636; border: 1px solid #666; border-radius: 4px; cursor: pointer; }
p { margin: 10px 0; font-size: 12px; line-height: 1.5; color: #bbb; overflow-wrap: anywhere; }
img { display: block; width: 100%; max-height: max(100px, calc(100dvh - 200px)); object-fit: contain; background: #101010; }
.field-preview-legend { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 0; }
@media (max-width: 420px) { .field-preview-dialog { padding: 12px; } .field-preview-close__hint { display: none; } }
</style>
