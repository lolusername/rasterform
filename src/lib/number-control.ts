export interface NumberControlRange {
  min: number
  max: number
  step: number
}

function decimalPlaces(value: number): number {
  const [coefficient, exponent = '0'] = value.toString().split('e')
  return Math.max(0, (coefficient!.split('.')[1]?.length ?? 0) - Number(exponent))
}

function roundingTolerance(value: number): number {
  return Number.EPSILON * Math.max(1, Math.abs(value)) * 4
}

/** Match the range input's min-relative step grid, including upward half ties. */
export function normalizeNumberControlValue(value: number, { min, max, step }: NumberControlRange): number | null {
  if (![min, max, step].every(Number.isFinite) || min > max || step <= 0) {
    throw new RangeError('Number controls require finite ordered bounds and a positive step.')
  }
  if (!Number.isFinite(value)) return null
  const bounded = Math.min(max, Math.max(min, value))
  const index = (bounded - min) / step
  const maximumIndex = (max - min) / step
  // An unaligned max is not itself a valid range value. Keep the last step
  // inside the bounds instead of snapping above max and creating a mismatch.
  const lastStep = Math.floor(maximumIndex + roundingTolerance(maximumIndex))
  const nearestStep = Math.min(lastStep, Math.round(index + roundingTolerance(index)))
  const precision = Math.min(100, Math.max(decimalPlaces(min), decimalPlaces(step)))
  const normalized = Number((min + nearestStep * step).toFixed(precision))
  return Math.min(max, Math.max(min, normalized))
}
