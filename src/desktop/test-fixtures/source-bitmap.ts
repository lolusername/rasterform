import type { SourceTexture } from '../../types'

/** An 8×8 PNG with red/green/blue/yellow quadrants, decoded without Node APIs. */
export function sourceBitmapFixture(): SourceTexture {
  const encoded = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHUlEQVR4nGP4z8DwHxljgTRXgCb///9/BhRMBwUAN5uPcRKBhEQAAAAASUVORK5CYII='
  return {
    data: Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
    width: 8,
    height: 8,
    mimeType: 'image/png',
    name: 'quadrants.png',
  }
}
