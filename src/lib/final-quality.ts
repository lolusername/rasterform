import type { AppearanceSettings, ColorMode } from '../types'

export const FINAL_TILE_EDGE = 1024
export const FINAL_DIFFUSE_SAMPLES = 6144
export const FINAL_SPECULAR_SAMPLES = 8192

/**
 * The single Final sampling policy used by browser, desktop renderer, and
 * native result validation. Never accept this value from an IPC caller.
 */
export function finalSampleTarget(colorMode: ColorMode, appearance: AppearanceSettings): number {
  return colorMode === 'clay' && appearance.clay.finish !== 'matte'
    ? FINAL_SPECULAR_SAMPLES
    : FINAL_DIFFUSE_SAMPLES
}

export function finalTileCount(width: number, height: number): number {
  const safeWidth = Math.max(1, Math.round(width))
  const safeHeight = Math.max(1, Math.round(height))
  return Math.ceil(safeWidth / FINAL_TILE_EDGE) * Math.ceil(safeHeight / FINAL_TILE_EDGE)
}
