import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { claySurface, createDefaultAppearanceSettings, createMaterial, heightGradientColors } from './three'

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
