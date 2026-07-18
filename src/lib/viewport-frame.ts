export interface ViewportFrame {
  width: number
  height: number
}

function positiveIntegerBound(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  return Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)))
}

/** Fit an aspect ratio inside integer stage bounds without exceeding either axis. */
export function fitViewportFrame(
  aspectRatio: number,
  maxWidth: number,
  maxHeight: number,
): ViewportFrame {
  const widthBound = positiveIntegerBound(maxWidth)
  const heightBound = positiveIntegerBound(maxHeight)
  const aspect = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1

  if (aspect >= widthBound / heightBound) {
    return {
      width: widthBound,
      height: Math.max(1, Math.min(heightBound, Math.round(widthBound / aspect))),
    }
  }

  return {
    width: Math.max(1, Math.min(widthBound, Math.round(heightBound * aspect))),
    height: heightBound,
  }
}
