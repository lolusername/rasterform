export const MAX_IMAGE_EDGE = 2048

export function fitWebImageDimensions(
  dimensions: { width: number; height: number },
): { width: number; height: number } {
  const longEdge = Math.max(dimensions.width, dimensions.height)
  if (longEdge <= MAX_IMAGE_EDGE) return { ...dimensions }
  const scale = MAX_IMAGE_EDGE / longEdge
  return {
    width: Math.max(1, Math.round(dimensions.width * scale)),
    height: Math.max(1, Math.round(dimensions.height * scale)),
  }
}
