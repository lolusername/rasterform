import type { ImageExportLongEdge } from '../types'

/** Product limits affect file dimensions, never render samples or material quality. */
export function exportProfile(desktop: boolean) {
  return {
    modelFiles: desktop,
    defaultStillEdge: (desktop ? 4096 : 2048) as ImageExportLongEdge,
    stillEdges: (desktop ? [2048, 4096, 8192] : [2048]) as ImageExportLongEdge[],
    loopEdges: (desktop ? [2048, 4096] : [2048]) as Array<2048 | 4096>,
  }
}

export function imageDimensionsForEdition(
  dimensions: { width: number; height: number },
  desktop: boolean,
): { width: number; height: number } {
  const longEdge = Math.max(dimensions.width, dimensions.height)
  if (desktop || longEdge <= 2048) return { ...dimensions }
  const scale = 2048 / longEdge
  return {
    width: Math.max(1, Math.round(dimensions.width * scale)),
    height: Math.max(1, Math.round(dimensions.height * scale)),
  }
}
