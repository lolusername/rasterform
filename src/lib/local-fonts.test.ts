import { describe, expect, it, vi } from 'vitest'
import {
  PASSIVE_FONT_CANDIDATES,
  SYSTEM_SANS_FONT,
  cleanupRegisteredFont,
  discoverPassiveFonts,
  passiveFontSource,
  queryLocalFontFaces,
  registerLocalFont,
  supportsLocalFontAccess,
  type FontFaceConstructor,
  type FontFaceSetLike,
  type PassiveFontCandidate,
} from './local-fonts'

function fontData(
  family: string,
  fullName: string,
  postscriptName: string,
  style = 'Regular',
): FontData {
  return {
    family,
    fullName,
    postscriptName,
    style,
    blob: vi.fn(async () => new Blob([postscriptName || fullName])),
  }
}

class FakeFontFace {
  static created: FakeFontFace[] = []

  family: string
  source: string | BufferSource
  load = vi.fn(async () => this as unknown as FontFace)

  constructor(family: string, source: string | BufferSource) {
    this.family = family
    this.source = source
    FakeFontFace.created.push(this)
  }
}

function fakeFontSet() {
  const faces = new Set<FontFace>()
  const fontSet: FontFaceSetLike & { check: ReturnType<typeof vi.fn> } = {
    add: vi.fn((face: FontFace) => {
      faces.add(face)
      return fontSet
    }),
    delete: vi.fn((face: FontFace) => faces.delete(face)),
    check: vi.fn(() => {
      throw new Error('document.fonts.check must not be used')
    }),
  }
  return { faces, fontSet }
}

describe('Local Font Access', () => {
  it('requires both a secure context and the query API', () => {
    const query = vi.fn(async () => [])
    expect(supportsLocalFontAccess({ isSecureContext: true, queryLocalFonts: query })).toBe(true)
    expect(supportsLocalFontAccess({ isSecureContext: false, queryLocalFonts: query })).toBe(false)
    expect(supportsLocalFontAccess({ isSecureContext: true })).toBe(false)
    expect(supportsLocalFontAccess(undefined)).toBe(false)
  })

  it('starts the permission-gated query synchronously, then sorts and deduplicates faces', async () => {
    let resolveFaces: ((faces: FontData[]) => void) | undefined
    const pending = new Promise<FontData[]>((resolve) => {
      resolveFaces = resolve
    })
    const scope = {
      isSecureContext: true,
      queryLocalFonts: vi.fn(() => pending),
    }

    const result = queryLocalFontFaces(scope)
    expect(scope.queryLocalFonts).toHaveBeenCalledTimes(1)

    resolveFaces?.([
      fontData('Zed', 'Zed Bold', 'Zed-Bold', 'Bold'),
      fontData('Alpha', 'Alpha Italic', 'Alpha-Italic', 'Italic'),
      fontData('Alpha', 'Alpha Regular duplicate', 'alpha-regular'),
      fontData('Alpha', 'Alpha Regular', 'Alpha-Regular'),
    ])

    const faces = await result
    expect(faces.map(({ label }) => label)).toEqual(['Alpha Italic', 'Alpha Regular', 'Zed Bold'])
    expect(faces[1].fontData.postscriptName).toBe('Alpha-Regular')
  })

  it('returns no queried fonts when the capability is unavailable', async () => {
    const query = vi.fn(async () => [fontData('Alpha', 'Alpha', 'Alpha')])
    await expect(queryLocalFontFaces({ isSecureContext: false, queryLocalFonts: query })).resolves.toEqual([])
    expect(query).not.toHaveBeenCalled()
  })

  it('registers a selected font from bytes and removes it idempotently', async () => {
    FakeFontFace.created = []
    const data = fontData('Example', 'Example Semibold', 'Example-Semibold', 'Semibold')
    const { faces, fontSet } = fakeFontSet()

    const registration = await registerLocalFont(data, {
      FontFace: FakeFontFace as unknown as FontFaceConstructor,
      fontSet,
      aliasPrefix: 'Test Local',
    })

    expect(data.blob).toHaveBeenCalledTimes(1)
    expect(FakeFontFace.created).toHaveLength(1)
    expect(FakeFontFace.created[0].source).toBeInstanceOf(ArrayBuffer)
    expect(registration.choice.cssFamily).toMatch(/^"Test Local Example Semibold \d+"$/)
    expect(registration.choice.postscriptName).toBe('Example-Semibold')
    expect(faces.has(registration.face)).toBe(true)

    cleanupRegisteredFont(registration)
    cleanupRegisteredFont(registration)
    expect(fontSet.delete).toHaveBeenCalledTimes(1)
    expect(faces.size).toBe(0)
  })
})

describe('passive font fallback', () => {
  it('has a system default and probes curated PostScript plus full names with local()', () => {
    expect(SYSTEM_SANS_FONT).toMatchObject({ label: 'System Sans', source: 'default' })
    expect(PASSIVE_FONT_CANDIDATES.length).toBeGreaterThan(10)
    expect(passiveFontSource({
      family: 'Quoted',
      fullName: 'Quoted "Display"',
      postscriptName: 'Quoted-Display',
    })).toBe('local("Quoted-Display"), local("Quoted \\"Display\\"")')
  })

  it('returns only verified passive fonts, registers aliases, and supplies cleanup', async () => {
    const candidates: PassiveFontCandidate[] = [
      { family: 'Installed', fullName: 'Installed Regular', postscriptName: 'Installed-Regular' },
      { family: 'Missing', fullName: 'Missing Regular', postscriptName: 'Missing-Regular' },
    ]
    class ProbeFontFace extends FakeFontFace {
      override load = vi.fn(async () => {
        if (typeof this.source === 'string' && this.source.includes('Missing-Regular')) {
          throw new DOMException('Unavailable', 'NetworkError')
        }
        return this as unknown as FontFace
      })
    }
    const { faces, fontSet } = fakeFontSet()

    const discovery = await discoverPassiveFonts({
      FontFace: ProbeFontFace as unknown as FontFaceConstructor,
      fontSet,
      candidates,
      aliasPrefix: 'Test Detected',
    })

    expect(discovery.choices.map(({ label }) => label)).toEqual(['System Sans', 'Installed Regular'])
    expect(discovery.choices[1]).toMatchObject({
      family: 'Installed',
      source: 'detected',
      postscriptName: 'Installed-Regular',
    })
    expect(discovery.choices[1].cssFamily).toMatch(/^"Test Detected 1 \d+"$/)
    expect(faces.size).toBe(1)
    expect(fontSet.check).not.toHaveBeenCalled()

    discovery.cleanup()
    discovery.cleanup()
    expect(fontSet.delete).toHaveBeenCalledTimes(1)
    expect(faces.size).toBe(0)
  })

  it('still returns System Sans where CSS Font Loading is unavailable', async () => {
    const discovery = await discoverPassiveFonts({ candidates: [] })
    expect(discovery.choices).toEqual([SYSTEM_SANS_FONT])
    expect(() => discovery.cleanup()).not.toThrow()
  })
})
