import type { FontChoice } from '../types'

export type LocalFontQuery = (options?: QueryLocalFontsOptions) => Promise<FontData[]>

export interface LocalFontAccessScope {
  isSecureContext?: boolean
  queryLocalFonts?: LocalFontQuery
}

interface AvailableLocalFontAccessScope extends LocalFontAccessScope {
  isSecureContext: true
  queryLocalFonts: LocalFontQuery
}

export interface LocalFontRecord extends FontChoice {
  fullName: string
  fontData: FontData
}

export interface FontFaceSetLike {
  add(font: FontFace): unknown
  delete(font: FontFace): boolean
}

export type FontFaceConstructor = new (
  family: string,
  source: string | BufferSource,
  descriptors?: FontFaceDescriptors,
) => FontFace

export interface FontRegistrationOptions {
  FontFace?: FontFaceConstructor
  fontSet?: FontFaceSetLike
  aliasPrefix?: string
}

export interface RegisteredFont {
  choice: FontChoice
  face: FontFace
  cleanup: () => void
}

export interface PassiveFontCandidate {
  family: string
  fullName: string
  postscriptName: string
  style?: string
}

export interface PassiveFontDiscovery {
  choices: FontChoice[]
  cleanup: () => void
}

export interface PassiveFontOptions extends FontRegistrationOptions {
  candidates?: readonly PassiveFontCandidate[]
}

export const SYSTEM_SANS_FONT: Readonly<FontChoice> = Object.freeze({
  id: 'default:system-sans',
  label: 'System Sans',
  family: 'system-ui',
  style: 'Regular',
  source: 'default',
  cssFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
})

export const PASSIVE_FONT_CANDIDATES: readonly PassiveFontCandidate[] = Object.freeze([
  { family: 'SF Pro Display', fullName: 'SF Pro Display Regular', postscriptName: 'SFProDisplay-Regular' },
  { family: 'Helvetica Neue', fullName: 'Helvetica Neue', postscriptName: 'HelveticaNeue' },
  { family: 'Avenir Next', fullName: 'Avenir Next Regular', postscriptName: 'AvenirNext-Regular' },
  { family: 'Futura', fullName: 'Futura Medium', postscriptName: 'Futura-Medium' },
  { family: 'Gill Sans', fullName: 'Gill Sans', postscriptName: 'GillSans' },
  { family: 'Optima', fullName: 'Optima Regular', postscriptName: 'Optima-Regular' },
  { family: 'Baskerville', fullName: 'Baskerville', postscriptName: 'Baskerville' },
  { family: 'Didot', fullName: 'Didot', postscriptName: 'Didot' },
  { family: 'Arial', fullName: 'Arial', postscriptName: 'ArialMT' },
  { family: 'Georgia', fullName: 'Georgia', postscriptName: 'Georgia' },
  { family: 'Times New Roman', fullName: 'Times New Roman', postscriptName: 'TimesNewRomanPSMT' },
  { family: 'Courier New', fullName: 'Courier New', postscriptName: 'CourierNewPSMT' },
  { family: 'Verdana', fullName: 'Verdana', postscriptName: 'Verdana' },
  { family: 'Trebuchet MS', fullName: 'Trebuchet MS', postscriptName: 'TrebuchetMS' },
  { family: 'Impact', fullName: 'Impact', postscriptName: 'Impact' },
  { family: 'Inter', fullName: 'Inter Regular', postscriptName: 'Inter-Regular' },
  { family: 'Roboto', fullName: 'Roboto Regular', postscriptName: 'Roboto-Regular' },
  { family: 'IBM Plex Sans', fullName: 'IBM Plex Sans Regular', postscriptName: 'IBMPlexSans' },
])

let registrationSequence = 0

function currentScope(): LocalFontAccessScope | undefined {
  return typeof window === 'undefined' ? undefined : window
}

function currentFontFaceConstructor(): FontFaceConstructor | undefined {
  return typeof FontFace === 'undefined' ? undefined : FontFace
}

function currentFontSet(): FontFaceSetLike | undefined {
  return typeof document === 'undefined' ? undefined : document.fonts
}

function normalized(value: string | undefined, fallback = ''): string {
  return value?.trim() || fallback
}

function stableText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
}

function compareText(left: string, right: string): number {
  return stableText(left).localeCompare(stableText(right), 'en-US', {
    numeric: true,
    sensitivity: 'base',
  })
}

function localFontKey(font: FontData): string {
  const postscriptName = normalized(font.postscriptName)
  if (postscriptName) return `postscript:${stableText(postscriptName)}`

  return [font.family, font.fullName, font.style]
    .map((part) => stableText(normalized(part)))
    .join('\u0000')
}

function localFontRecord(fontData: FontData): LocalFontRecord {
  const family = normalized(fontData.family, 'Unknown family')
  const fullName = normalized(fontData.fullName, family)
  const style = normalized(fontData.style, 'Regular')
  const postscriptName = normalized(fontData.postscriptName)
  const key = postscriptName || `${family}-${fullName}-${style}`

  return {
    id: `local:${encodeURIComponent(stableText(key))}`,
    label: fullName,
    family,
    fullName,
    style,
    source: 'local',
    cssFamily: quoteFontFamily(family),
    ...(postscriptName ? { postscriptName } : {}),
    fontData,
  }
}

function requireRegistrationEnvironment(options: FontRegistrationOptions): {
  FontFace: FontFaceConstructor
  fontSet: FontFaceSetLike
} {
  const FontFaceClass = options.FontFace ?? currentFontFaceConstructor()
  const fontSet = options.fontSet ?? currentFontSet()

  if (!FontFaceClass || !fontSet) {
    throw new Error('CSS Font Loading is unavailable in this browser.')
  }

  return { FontFace: FontFaceClass, fontSet }
}

function nextAlias(prefix: string, label: string): string {
  registrationSequence += 1
  const safeLabel = label.replace(/[^a-z0-9]+/gi, ' ').trim().slice(0, 32) || 'Font'
  return `${prefix} ${safeLabel} ${registrationSequence}`
}

function disposableCleanup(fontSet: FontFaceSetLike, faces: readonly FontFace[]): () => void {
  let cleaned = false
  return () => {
    if (cleaned) return
    cleaned = true
    for (const face of faces) fontSet.delete(face)
  }
}

function escapeCssString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r\f]/g, ' ')
}

export function quoteFontFamily(family: string): string {
  return `"${escapeCssString(family)}"`
}

export function supportsLocalFontAccess(
  scope: LocalFontAccessScope | undefined = currentScope(),
): scope is AvailableLocalFontAccessScope {
  return scope?.isSecureContext === true && typeof scope.queryLocalFonts === 'function'
}

export async function queryLocalFontFaces(
  scope: LocalFontAccessScope | undefined = currentScope(),
  options?: QueryLocalFontsOptions,
): Promise<LocalFontRecord[]> {
  if (!supportsLocalFontAccess(scope)) return []

  // Keep the permission-gated call in the initiating click task. In particular,
  // do not put an await (even an apparently harmless one) before this line.
  const fontRequest = scope.queryLocalFonts.call(scope, options)
  const faces = await fontRequest

  const sorted = [...faces].sort((left, right) =>
    compareText(left.family, right.family)
    || compareText(left.fullName, right.fullName)
    || compareText(left.style, right.style)
    || compareText(left.postscriptName, right.postscriptName),
  )
  const seen = new Set<string>()
  const records: LocalFontRecord[] = []

  for (const face of sorted) {
    const key = localFontKey(face)
    if (seen.has(key)) continue
    seen.add(key)
    records.push(localFontRecord(face))
  }

  return records
}

export async function registerLocalFont(
  fontData: FontData,
  options: FontRegistrationOptions = {},
): Promise<RegisteredFont> {
  const environment = requireRegistrationEnvironment(options)
  const blob = await fontData.blob()
  const bytes = await blob.arrayBuffer()
  const family = normalized(fontData.family, 'Local font')
  const fullName = normalized(fontData.fullName, family)
  const style = normalized(fontData.style, 'Regular')
  const postscriptName = normalized(fontData.postscriptName)
  const alias = nextAlias(options.aliasPrefix ?? 'Rasterform Local', fullName)
  const face = new environment.FontFace(alias, bytes)
  const loadedFace = await face.load()
  environment.fontSet.add(loadedFace)

  return {
    choice: {
      id: `registered:${encodeURIComponent(stableText(alias))}`,
      label: fullName,
      family,
      style,
      source: 'local',
      cssFamily: quoteFontFamily(alias),
      ...(postscriptName ? { postscriptName } : {}),
    },
    face: loadedFace,
    cleanup: disposableCleanup(environment.fontSet, [loadedFace]),
  }
}

export function cleanupRegisteredFont(registration: RegisteredFont | undefined): void {
  registration?.cleanup()
}

export function passiveFontSource(candidate: PassiveFontCandidate): string {
  const names = [candidate.postscriptName, candidate.fullName]
    .map((name) => normalized(name))
    .filter((name, index, all) => Boolean(name) && all.indexOf(name) === index)

  return names.map((name) => `local("${escapeCssString(name)}")`).join(', ')
}

export async function discoverPassiveFonts(options: PassiveFontOptions = {}): Promise<PassiveFontDiscovery> {
  const FontFaceClass = options.FontFace ?? currentFontFaceConstructor()
  const fontSet = options.fontSet ?? currentFontSet()
  if (!FontFaceClass || !fontSet) {
    return { choices: [SYSTEM_SANS_FONT], cleanup: () => undefined }
  }

  const candidates = options.candidates ?? PASSIVE_FONT_CANDIDATES
  const loaded = await Promise.all(candidates.map(async (candidate, index) => {
    const alias = nextAlias(options.aliasPrefix ?? 'Rasterform Detected', `${index + 1}`)
    const face = new FontFaceClass(alias, passiveFontSource(candidate))
    try {
      return { candidate, face: await face.load(), alias }
    } catch {
      return undefined
    }
  }))

  const verified = loaded.filter((result): result is NonNullable<typeof result> => Boolean(result))
  for (const result of verified) fontSet.add(result.face)

  const choices = verified.map(({ candidate, alias }) => ({
    id: `detected:${encodeURIComponent(stableText(candidate.postscriptName))}`,
    label: candidate.fullName,
    family: candidate.family,
    style: candidate.style ?? 'Regular',
    source: 'detected' as const,
    cssFamily: quoteFontFamily(alias),
    postscriptName: candidate.postscriptName,
  }))

  return {
    choices: [SYSTEM_SANS_FONT, ...choices],
    cleanup: disposableCleanup(fontSet, verified.map(({ face }) => face)),
  }
}
