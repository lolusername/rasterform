import { describe, expect, it } from 'vitest'
import { inspectChannel } from './channel-inspection'
import { composeChannelStack } from './channel-stack'
import { createDemoImage } from './image'
import type { ChannelLayer } from '../types'

describe('channel inspection does not reinterpret or modify the stack', () => {
  const image = createDemoImage(8, 6)
  const layers: ChannelLayer[] = [
    { id: 'a', source: 'red', enabled: true, invert: false, amount: .8, hueOrigin: 0, blend: 'add' },
    { id: 'b', source: 'edges', enabled: true, invert: true, amount: .3, hueOrigin: 0, blend: 'multiply' },
  ]
  it('shows the actual prefix before and after a nonlinear operation', () => {
    const original = JSON.stringify(layers)
    const inspected = inspectChannel(image, layers, 'b')!
    expect(inspected.before).toEqual(composeChannelStack(image, layers.slice(0, 1)))
    expect(inspected.after).toEqual(composeChannelStack(image, layers))
    expect(JSON.stringify(layers)).toBe(original)
  })
  it('shows a muted operation as no change and identifies the first enabled base', () => {
    const muted = layers.map(layer => ({ ...layer, enabled: layer.id === 'b' }))
    expect(inspectChannel(image, muted, 'a')!.before).toEqual(inspectChannel(image, muted, 'a')!.after)
    expect(inspectChannel(image, muted, 'b')!.isBase).toBe(true)
    expect(inspectChannel(image, layers, 'missing')).toBeNull()
  })
})
