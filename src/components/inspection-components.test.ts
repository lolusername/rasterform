import { createSSRApp } from 'vue'
import { renderToString, type SSRContext } from 'vue/server-renderer'
import { describe, expect, it } from 'vitest'
import ChannelInspection from './ChannelInspection.vue'
import FieldPreview from './FieldPreview.vue'
import { createDemoImage } from '../lib/image'
import type { ChannelLayer } from '../types'

describe('read-only inspection controls', () => {
  const field = { width: 4, height: 3, values: new Float32Array(12) }

  it('keeps expensive channel inspection collapsed by default while naming the selection', async () => {
    const layers: ChannelLayer[] = [{ id: 'a', source: 'hue', blend: 'add', amount: 0.8, invert: false, hueOrigin: 0.5, enabled: true }]
    const html = await renderToString(createSSRApp(ChannelInspection, { image: createDemoImage(4, 3), layers, selectedId: 'a', height: field }))
    expect(html).toContain('Hue target · Base channel')
    expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|>)/)
    expect(html).not.toContain('<canvas')
  })

  it('makes enlargement a named keyboard-operable button with a labeled native dialog', async () => {
    const context: SSRContext = {}
    const html = await renderToString(createSSRApp(FieldPreview, { label: 'Height after channel', field }), context)
    expect(html).toContain('type="button"')
    expect(html).toContain('aria-label="Enlarge Height after channel"')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('role="img"')
    const modal = context.teleports?.body ?? ''
    expect(modal).toContain('<dialog')
    expect(modal).toContain('aria-labelledby=')
    expect(modal).toContain('aria-describedby=')
    expect(modal).toContain('autofocus')
    expect(modal).toContain('4 × 3 px · working-resolution height field')
    expect(modal).toContain('your design and export quality are unchanged')
    expect(modal).not.toContain('<img')
  })

  it('labels the actual working image dimensions rather than implying original-file resolution', async () => {
    const context: SSRContext = {}
    const image = { ...createDemoImage(4, 3), sourceWidth: 4000, sourceHeight: 3000 }
    await renderToString(createSSRApp(FieldPreview, { label: 'Source image', image }), context)
    expect(context.teleports?.body).toContain('4 × 3 px · working-resolution source image')
    expect(context.teleports?.body).not.toContain('4000')
    expect(context.teleports?.body).not.toContain('Black · lower value')
  })
})
