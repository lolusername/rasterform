/** Deterministic educational data, not a production-render benchmark. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createDemoImage } from '../../src/lib/image'
import { extractScalarField } from '../../src/lib/channels'
import { buildMesh } from '../../src/lib/mesh'

const image = createDemoImage(180, 135)
const field = extractScalarField(image, 'luminance', 0)
const mesh = buildMesh(field, image, {
  mode: 'plane', resolution: 64, depth: 0.7, midpoint: 0.5, baseThickness: 0.15,
})
mkdirSync('tmp/pdfs/interview', { recursive: true })
writeFileSync('tmp/pdfs/interview/fixture.json', JSON.stringify({
  width: image.width,
  height: image.height,
  rgba: Array.from(image.data),
  values: Array.from(field.values),
  positions: Array.from(mesh.positions),
  indices: Array.from(mesh.indices),
  colors: Array.from(mesh.colors),
  columns: mesh.width,
  rows: mesh.height,
}))
