<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { addStudioLighting, createThreeMesh } from '../lib/three'
import { GUIDE_LAYER, renderTransparentViewportPng } from '../lib/viewport-export'
import type { AppearanceSettings, ColorMode, MeshData, ViewportExportLongEdge } from '../types'
import type { ViewportPngResult } from '../lib/viewport-export'

const props = defineProps<{ mesh: MeshData; colorMode: ColorMode; appearance: AppearanceSettings }>()
const canvas = ref<HTMLCanvasElement | null>(null)
let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let controls: OrbitControls | null = null
let object: THREE.Mesh | null = null
let resizeObserver: ResizeObserver | null = null
let animationFrame = 0

function disposeObject() {
  if (!object || !scene) return
  scene.remove(object)
  object.geometry.dispose()
  const material = object.material
  if (Array.isArray(material)) material.forEach((item) => item.dispose())
  else material.dispose()
  object = null
}

function updateObject() {
  if (!scene) return
  disposeObject()
  object = createThreeMesh(props.mesh, props.colorMode, props.appearance)
  scene.add(object)
}

async function captureTransparentPng(longEdge: ViewportExportLongEdge): Promise<ViewportPngResult> {
  if (!canvas.value || !renderer || !scene || !camera) throw new Error('Viewport is not ready.')
  controls?.update()
  camera.updateMatrixWorld(true)
  return renderTransparentViewportPng({
    scene,
    camera,
    liveRenderer: renderer,
    viewportWidth: canvas.value.clientWidth,
    viewportHeight: canvas.value.clientHeight,
    longEdge,
  })
}

defineExpose({ captureTransparentPng })

function resize() {
  if (!canvas.value || !renderer || !camera) return
  const width = Math.max(1, canvas.value.clientWidth)
  const height = Math.max(1, canvas.value.clientHeight)
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
}

function render() {
  animationFrame = requestAnimationFrame(render)
  controls?.update()
  if (renderer && scene && camera) renderer.render(scene, camera)
}

onMounted(() => {
  if (!canvas.value) return
  renderer = new THREE.WebGLRenderer({ canvas: canvas.value, antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setClearColor(0x111310, 1)
  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100)
  camera.position.set(2.45, -2.2, 2.15)
  camera.lookAt(0, 0, 0)
  camera.layers.enable(GUIDE_LAYER)
  controls = new OrbitControls(camera, canvas.value)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.minDistance = 1.3
  controls.maxDistance = 8
  controls.target.set(0, 0, 0.12)
  addStudioLighting(scene)
  const grid = new THREE.GridHelper(4, 16, 0x52574e, 0x2a2e29)
  grid.rotation.x = Math.PI / 2
  grid.position.z = -0.03
  grid.layers.set(GUIDE_LAYER)
  scene.add(grid)
  updateObject()
  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(canvas.value)
  resize()
  render()
})

watch(
  () => [
    props.mesh,
    props.colorMode,
    props.appearance.heightGradient.low,
    props.appearance.heightGradient.mid,
    props.appearance.heightGradient.high,
    props.appearance.heightGradient.midpoint,
    props.appearance.clay.color,
    props.appearance.clay.finish,
  ] as const,
  updateObject,
  { deep: false },
)

onBeforeUnmount(() => {
  cancelAnimationFrame(animationFrame)
  resizeObserver?.disconnect()
  controls?.dispose()
  disposeObject()
  renderer?.dispose()
})
</script>

<template>
  <canvas
    ref="canvas"
    class="three-preview"
    aria-label="Orbitable 3D preview of the channel-driven relief. Drag to rotate and scroll to zoom."
  />
</template>
