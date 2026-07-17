import type { ViewportBackground } from '../types'

export interface ViewportBackgroundPreset {
  value: ViewportBackground
  label: string
  color: string
  hex: number
  shortcut: string
}

export const VIEWPORT_BACKGROUNDS: readonly ViewportBackgroundPreset[] = [
  { value: 'white', label: 'White', color: '#ffffff', hex: 0xffffff, shortcut: 'W' },
  { value: 'dark-gray', label: 'Dark gray', color: '#343434', hex: 0x343434, shortcut: 'G' },
  { value: 'black', label: 'Black', color: '#000000', hex: 0x000000, shortcut: 'B' },
]

export function viewportBackgroundPreset(background: ViewportBackground): ViewportBackgroundPreset {
  return VIEWPORT_BACKGROUNDS.find((preset) => preset.value === background)
    ?? VIEWPORT_BACKGROUNDS[1]!
}

export function viewportBackgroundFromShortcut(key: string): ViewportBackground | null {
  const normalized = key.toUpperCase()
  return VIEWPORT_BACKGROUNDS.find((preset) => preset.shortcut === normalized)?.value ?? null
}

export function isViewportBackground(value: unknown): value is ViewportBackground {
  return VIEWPORT_BACKGROUNDS.some((preset) => preset.value === value)
}
