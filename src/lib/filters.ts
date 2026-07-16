import { clamp01 } from './channels'
import type { FieldSettings, ScalarField } from '../types'

function gaussianKernel(radius: number): Float32Array {
  if (radius <= 0) return new Float32Array([1])
  const size = radius * 2 + 1
  const sigma = Math.max(0.75, radius * 0.62)
  const kernel = new Float32Array(size)
  let sum = 0
  for (let index = 0; index < size; index += 1) {
    const distance = index - radius
    const weight = Math.exp(-(distance * distance) / (2 * sigma * sigma))
    kernel[index] = weight
    sum += weight
  }
  for (let index = 0; index < size; index += 1) kernel[index] = (kernel[index] ?? 0) / sum
  return kernel
}

function blurField(field: ScalarField, radius: number): Float32Array {
  if (radius <= 0) return new Float32Array(field.values)
  const kernel = gaussianKernel(radius)
  const horizontal = new Float32Array(field.values.length)
  const output = new Float32Array(field.values.length)

  for (let y = 0; y < field.height; y += 1) {
    for (let x = 0; x < field.width; x += 1) {
      let value = 0
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sampleX = Math.min(field.width - 1, Math.max(0, x + offset))
        value += (field.values[y * field.width + sampleX] ?? 0) * (kernel[offset + radius] ?? 0)
      }
      horizontal[y * field.width + x] = value
    }
  }

  for (let y = 0; y < field.height; y += 1) {
    for (let x = 0; x < field.width; x += 1) {
      let value = 0
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sampleY = Math.min(field.height - 1, Math.max(0, y + offset))
        value += (horizontal[sampleY * field.width + x] ?? 0) * (kernel[offset + radius] ?? 0)
      }
      output[y * field.width + x] = value
    }
  }
  return output
}

export function processScalarField(field: ScalarField, settings: FieldSettings): ScalarField {
  const radius = Math.max(0, Math.round(settings.blur))
  const values = blurField(field, radius)
  const contrast = Math.pow(2, settings.contrast / 50)
  const steps = Math.max(0, Math.round(settings.quantize))

  for (let index = 0; index < values.length; index += 1) {
    let value = clamp01(((values[index] ?? 0) - 0.5) * contrast + 0.5)
    if (settings.invert) value = 1 - value
    if (steps >= 2) value = Math.round(value * (steps - 1)) / (steps - 1)
    values[index] = clamp01(value)
  }

  return { ...field, values }
}
