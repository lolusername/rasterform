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

/**
 * A separable grayscale dilation. Each one-dimensional pass maintains a
 * monotonic deque, so increasing the radius does not increase the amount of
 * work per pixel.
 */
function dilateField(values: Float32Array, width: number, height: number, radius: number): Float32Array {
  const horizontalRadius = Math.min(Math.max(0, radius), Math.max(0, width - 1))
  const verticalRadius = Math.min(Math.max(0, radius), Math.max(0, height - 1))
  if (horizontalRadius === 0 && verticalRadius === 0) return new Float32Array(values)

  const horizontal = new Float32Array(values.length)
  const output = new Float32Array(values.length)
  const deque = new Int32Array(Math.max(width, height))

  for (let y = 0; y < height; y += 1) {
    const row = y * width
    let head = 0
    let tail = 0
    let next = 0

    for (let x = 0; x < width; x += 1) {
      const right = Math.min(width - 1, x + horizontalRadius)
      while (next <= right) {
        const value = values[row + next] ?? 0
        while (tail > head && (values[row + (deque[tail - 1] ?? 0)] ?? 0) <= value) tail -= 1
        deque[tail] = next
        tail += 1
        next += 1
      }

      const left = x - horizontalRadius
      while (tail > head && (deque[head] ?? 0) < left) head += 1
      horizontal[row + x] = values[row + (deque[head] ?? 0)] ?? 0
    }
  }

  for (let x = 0; x < width; x += 1) {
    let head = 0
    let tail = 0
    let next = 0

    for (let y = 0; y < height; y += 1) {
      const bottom = Math.min(height - 1, y + verticalRadius)
      while (next <= bottom) {
        const value = horizontal[next * width + x] ?? 0
        while (tail > head && (horizontal[(deque[tail - 1] ?? 0) * width + x] ?? 0) <= value) tail -= 1
        deque[tail] = next
        tail += 1
        next += 1
      }

      const top = y - verticalRadius
      while (tail > head && (deque[head] ?? 0) < top) head += 1
      output[y * width + x] = horizontal[(deque[head] ?? 0) * width + x] ?? 0
    }
  }

  return output
}

function boxBlurHorizontal(
  input: Float32Array,
  output: Float32Array,
  width: number,
  height: number,
  radius: number,
): void {
  const boundedRadius = Math.min(radius, Math.max(0, width - 1))
  const divisor = boundedRadius * 2 + 1
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    let sum = 0
    for (let offset = -boundedRadius; offset <= boundedRadius; offset += 1) {
      const x = Math.min(width - 1, Math.max(0, offset))
      sum += input[row + x] ?? 0
    }

    for (let x = 0; x < width; x += 1) {
      output[row + x] = sum / divisor
      const leaving = Math.min(width - 1, Math.max(0, x - boundedRadius))
      const entering = Math.min(width - 1, Math.max(0, x + boundedRadius + 1))
      sum += (input[row + entering] ?? 0) - (input[row + leaving] ?? 0)
    }
  }
}

function boxBlurVertical(
  input: Float32Array,
  output: Float32Array,
  width: number,
  height: number,
  radius: number,
): void {
  const boundedRadius = Math.min(radius, Math.max(0, height - 1))
  const divisor = boundedRadius * 2 + 1
  for (let x = 0; x < width; x += 1) {
    let sum = 0
    for (let offset = -boundedRadius; offset <= boundedRadius; offset += 1) {
      const y = Math.min(height - 1, Math.max(0, offset))
      sum += input[y * width + x] ?? 0
    }

    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = sum / divisor
      const leaving = Math.min(height - 1, Math.max(0, y - boundedRadius))
      const entering = Math.min(height - 1, Math.max(0, y + boundedRadius + 1))
      sum += (input[entering * width + x] ?? 0) - (input[leaving * width + x] ?? 0)
    }
  }
}

/** Three linear-time box passes closely approximate a soft Gaussian profile. */
function smoothBlobField(
  values: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  if (radius <= 0) return new Float32Array(values)

  const horizontal = new Float32Array(values.length)
  const first = new Float32Array(values.length)
  const second = new Float32Array(values.length)
  let current = values

  for (let pass = 0; pass < 3; pass += 1) {
    const output = pass % 2 === 0 ? first : second
    boxBlurHorizontal(current, horizontal, width, height, radius)
    boxBlurVertical(horizontal, output, width, height, radius)
    current = output
  }

  return current
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

  if (settings.finish !== 'blob') return { ...field, values }

  const dilation = Math.max(0, Math.round(Number.isFinite(settings.blobDilation) ? settings.blobDilation : 0))
  const smoothing = Math.max(0, Math.round(Number.isFinite(settings.blobSmoothing) ? settings.blobSmoothing : 0))
  const dilated = dilation > 0
    ? dilateField(values, field.width, field.height, dilation)
    : values
  const blob = smoothing > 0
    ? smoothBlobField(dilated, field.width, field.height, smoothing)
    : dilated

  for (let index = 0; index < blob.length; index += 1) blob[index] = clamp01(blob[index] ?? 0)
  return { ...field, values: blob }
}
