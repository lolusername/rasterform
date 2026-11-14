import type { ScalarField } from '../types'
import { scalarFieldPng } from './image'

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export async function exportHeightPng(field: ScalarField) {
  downloadBlob('rasterform-height.png', await scalarFieldPng(field))
}
