import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  addStudioLighting,
  claySurface,
  configureStudioRenderer,
  createDefaultAppearanceSettings,
  createFinalRenderScene,
  createMaterial,
  createStudioFloor,
  createThreeMesh,
  heightGradientColors,
  placeStudioFloor,
} from './three'
import type { MeshData } from '../types'

function meshFixture(): MeshData {
  return {
    positions: new Float32Array([
      -1, -1, 0,
      1, -1, 0.1,
      -1, 1, 0.2,
      1, 1, 0.4,
    ]),
    indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
    colors: new Float32Array([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
      1, 1, 1,
    ]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
    heights: new Float32Array([0, 0.25, 0.5, 1]),
    width: 1,
    height: 1,
    mode: 'plane',
  }
}

describe('viewport materials', () => {
  it('maps the low, movable midpoint, and high gradient colors exactly', () => {
    const gradient = { low: '#102040', mid: '#40c080', high: '#f0d040', midpoint: 0.25 }
    const colors = heightGradientColors(new Float32Array([0, 0.25, 1]), gradient)
    const expected = [new THREE.Color(gradient.low), new THREE.Color(gradient.mid), new THREE.Color(gradient.high)]

    expected.forEach((color, index) => {
      expect(colors[index * 3]).toBeCloseTo(color.r, 6)
      expect(colors[index * 3 + 1]).toBeCloseTo(color.g, 6)
      expect(colors[index * 3 + 2]).toBeCloseTo(color.b, 6)
    })
  })

  it('interpolates independently on both sides of the gradient midpoint', () => {
    const colors = heightGradientColors(
      new Float32Array([0.125, 0.625]),
      { low: '#000000', mid: '#808080', high: '#ffffff', midpoint: 0.25 },
    )
    const low = new THREE.Color('#000000').lerp(new THREE.Color('#808080'), 0.5)
    const high = new THREE.Color('#808080').lerp(new THREE.Color('#ffffff'), 0.5)
    expect(colors[0]).toBeCloseTo(low.r, 6)
    expect(colors[3]).toBeCloseTo(high.r, 6)
  })

  it('creates distinct matte, glossy, and metallic clay surfaces', () => {
    expect(claySurface('matte')).toEqual({ roughness: 0.88, metalness: 0 })
    expect(claySurface('glossy')).toEqual({ roughness: 0.16, metalness: 0.02 })
    expect(claySurface('metallic')).toEqual({ roughness: 0.26, metalness: 1 })
  })

  it('applies the chosen clay color and finish to the whole object material', () => {
    const appearance = createDefaultAppearanceSettings()
    appearance.clay = { color: '#a33bd1', finish: 'metallic' }
    const material = createMaterial('clay', appearance)
    expect(`#${material.color.getHexString(THREE.SRGBColorSpace)}`).toBe('#a33bd1')
    expect(material.vertexColors).toBe(false)
    expect(material.roughness).toBe(0.26)
    expect(material.metalness).toBe(1)
    material.dispose()
  })

  it('keeps all four viewport modes renderable with the expected color source', () => {
    const appearance = createDefaultAppearanceSettings()
    const modes = ['original', 'height', 'clay', 'wireframe'] as const
    for (const mode of modes) {
      const material = createMaterial(mode, appearance)
      expect(material.vertexColors).toBe(mode === 'original' || mode === 'height')
      expect(material.wireframe).toBe(mode === 'wireframe')
      material.dispose()
    }
  })
})

describe('studio rendering', () => {
  it('configures color management, AgX tone mapping, and soft shadow maps', () => {
    const renderer = {
      outputColorSpace: THREE.LinearSRGBColorSpace,
      toneMapping: THREE.NoToneMapping,
      toneMappingExposure: 1,
      shadowMap: { enabled: false, type: THREE.BasicShadowMap },
    } as unknown as THREE.WebGLRenderer

    configureStudioRenderer(renderer)

    expect(renderer.outputColorSpace).toBe(THREE.SRGBColorSpace)
    expect(renderer.toneMapping).toBe(THREE.AgXToneMapping)
    expect(renderer.toneMappingExposure).toBe(1.15)
    expect(renderer.shadowMap.enabled).toBe(true)
    expect(renderer.shadowMap.type).toBe(THREE.PCFSoftShadowMap)
  })

  it('makes relief meshes participate in the studio shadow pass', () => {
    const object = createThreeMesh(meshFixture(), 'original')
    expect(object.name).toBe('Rasterform_plane')
    expect(object.castShadow).toBe(true)
    expect(object.receiveShadow).toBe(true)
    object.geometry.dispose()
    ;(object.material as THREE.Material).dispose()
  })

  it('adds named area lights and a shadow-tuned key light', () => {
    const scene = new THREE.Scene()
    const lights = addStudioLighting(scene)

    expect(lights.hemisphere.name).toBe('Rasterform_Hemisphere')
    expect(lights.key.name).toBe('Rasterform_Key')
    expect(lights.key.castShadow).toBe(true)
    expect(lights.key.shadow.mapSize.toArray()).toEqual([2048, 2048])
    expect(lights.key.shadow.normalBias).toBe(0.025)
    expect(lights.key.target).toBe(lights.keyTarget)
    expect(lights.fill).toBeInstanceOf(THREE.RectAreaLight)
    expect(lights.rim).toBeInstanceOf(THREE.RectAreaLight)
    expect(scene.getObjectByName('Rasterform_Fill')).toBe(lights.fill)
    expect(scene.getObjectByName('Rasterform_Rim')).toBe(lights.rim)
  })

  it('creates and positions a rough standard-material floor below the relief bounds', () => {
    const object = createThreeMesh(meshFixture(), 'clay')
    const floor = placeStudioFloor(createStudioFloor(), object)
    const bounds = new THREE.Box3().setFromObject(object)

    expect(floor.name).toBe('Rasterform_StudioFloor')
    expect(floor.material).toBeInstanceOf(THREE.MeshStandardMaterial)
    expect(floor.material.roughness).toBe(0.92)
    expect(floor.receiveShadow).toBe(true)
    expect(floor.castShadow).toBe(false)
    expect(floor.position.z).toBeLessThan(bounds.min.z)
    expect(floor.scale.x).toBe(7)
    expect(floor.scale.y).toBe(7)

    object.geometry.dispose()
    ;(object.material as THREE.Material).dispose()
    floor.geometry.dispose()
    floor.material.dispose()
  })

  it('builds an isolated final scene with its own resources and HDR environment reference', () => {
    const environment = new THREE.Texture()
    environment.name = 'Test_HDR'
    const first = createFinalRenderScene(
      meshFixture(),
      'height',
      createDefaultAppearanceSettings(),
      environment,
    )
    const second = createFinalRenderScene(meshFixture(), 'height')

    expect(first.scene.name).toBe('Rasterform_FinalRender')
    expect(first.scene.environment).toBe(environment)
    expect(first.scene.background).toBeInstanceOf(THREE.Color)
    expect((first.scene.background as THREE.Color).getHex()).toBe(0x080a0e)
    expect(first.scene.children).toContain(first.object)
    expect(first.scene.children).toContain(first.floor)
    expect(first.floor.position.z).toBeLessThan(0)
    expect(first.lights.fill).toBeInstanceOf(THREE.RectAreaLight)
    expect(first.object.geometry).not.toBe(second.object.geometry)
    expect(first.object.material).not.toBe(second.object.material)
    expect(second.scene.environment).toBeNull()

    for (const renderScene of [first, second]) {
      renderScene.object.geometry.dispose()
      ;(renderScene.object.material as THREE.Material).dispose()
      renderScene.floor.geometry.dispose()
      renderScene.floor.material.dispose()
    }
    environment.dispose()
  })
})
