import type { AppearanceSettings, ColorMode } from '../types'

export const FINAL_TILE_EDGE = 1024
export const FINAL_DIFFUSE_SAMPLES = 6144
export const FINAL_SPECULAR_SAMPLES = 8192

export function finalSampleTarget(colorMode: ColorMode, appearance: AppearanceSettings): number {
  return colorMode === 'clay' && appearance.clay.finish !== 'matte'
    ? FINAL_SPECULAR_SAMPLES
    : FINAL_DIFFUSE_SAMPLES
}
