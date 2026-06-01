import { describe, expect, it } from 'vitest'
import { lowerThirdTemplate } from './lower-third.ts'
import { getMotionGraphicTemplate, MOTION_GRAPHIC_TEMPLATE_IDS } from './index.ts'
import type { MgShapeLayer, MgTextLayer } from './types.ts'

describe('lower_third template', () => {
  it('is registered and discoverable by id', () => {
    expect(MOTION_GRAPHIC_TEMPLATE_IDS).toContain('lower_third')
    expect(getMotionGraphicTemplate('lower_third')).toBe(lowerThirdTemplate)
    expect(getMotionGraphicTemplate('nope')).toBeUndefined()
  })

  it('requires a name', () => {
    expect(lowerThirdTemplate.requiredContent).toEqual(['name'])
  })

  it('builds a 2-layer card (panel + name) when no role is given', () => {
    const spec = lowerThirdTemplate.build({ name: 'Alex Rivera' })

    expect(spec.templateId).toBe('lower_third')
    expect(spec.defaultDurationSec).toBe(5)
    expect(spec.layers).toHaveLength(2)

    // BACK → FRONT: index 0 is the panel (shape), index 1 the name (text).
    const panel = spec.layers[0]!
    const name = spec.layers[1] as MgTextLayer
    expect(panel.kind).toBe('shape')
    expect(name.kind).toBe('text')
    expect(name.text).toBe('Alex Rivera')
    expect(name.fontWeight).toBe('bold')
  })

  it('adds a third role layer with the default accent color', () => {
    const spec = lowerThirdTemplate.build({ name: 'Alex Rivera', role: 'Founder, Acme' })

    expect(spec.layers).toHaveLength(3)
    const role = spec.layers[2] as MgTextLayer
    expect(role.kind).toBe('text')
    expect(role.text).toBe('Founder, Acme')
    expect(role.color).toBe('#3B82F6') // default accent
  })

  it('themes the role line with a custom accent color', () => {
    const spec = lowerThirdTemplate.build(
      { name: 'Alex Rivera', role: '@alex' },
      { accentColor: '#22D3EE' },
    )
    const role = spec.layers[2] as MgTextLayer
    expect(role.color).toBe('#22D3EE')
  })

  it('applies brand style: panel surface, name color, accent role, and font', () => {
    const spec = lowerThirdTemplate.build(
      { name: 'Alex Rivera', role: 'Fundador' },
      {
        surfaceColor: '#FAF7F2',
        titleColor: '#0B1220',
        accentColor: '#2B5CE6',
        fontFamily: 'Fraunces',
      },
    )
    const panel = spec.layers[0] as MgShapeLayer
    expect(panel.fillColor).toBe('#FAF7F2')
    const name = spec.layers[1] as MgTextLayer
    expect(name.color).toBe('#0B1220')
    expect(name.fontFamily).toBe('Fraunces')
    const role = spec.layers[2] as MgTextLayer
    expect(role.color).toBe('#2B5CE6')
    expect(role.fontFamily).toBe('Fraunces')
  })

  it('grows the panel taller when a role line is present', () => {
    const withoutRole = lowerThirdTemplate.build({ name: 'Alex' }).layers[0] as MgShapeLayer
    const withRole = lowerThirdTemplate.build({ name: 'Alex', role: 'CEO' })
      .layers[0] as MgShapeLayer
    expect(withRole.heightFrac).toBeGreaterThan(withoutRole.heightFrac)
  })

  it('animates every layer with a slide-in (x) and fade (opacity) track', () => {
    const spec = lowerThirdTemplate.build({ name: 'Alex Rivera', role: 'Founder' })
    for (const layer of spec.layers) {
      const props = (layer.animations ?? []).map((a) => a.property)
      expect(props).toContain('x')
      expect(props).toContain('opacity')

      // The opacity track fades in from 0 and ends fading out to 0 (anchored to
      // the clip end so it adapts to any duration).
      const opacity = layer.animations!.find((a) => a.property === 'opacity')!
      expect(opacity.keyframes[0]).toMatchObject({ atSec: 0, value: 0 })
      const last = opacity.keyframes[opacity.keyframes.length - 1]!
      expect(last).toMatchObject({ beforeEndSec: 0, value: 0 })
    }
  })

  it('keeps all geometry within the canvas as center-origin fractions', () => {
    const spec = lowerThirdTemplate.build({ name: 'Alex Rivera', role: 'Founder' })
    for (const layer of spec.layers) {
      // Center-origin: |x| + width/2 must stay within half the canvas (0.5).
      expect(Math.abs(layer.xFrac) + layer.widthFrac / 2).toBeLessThanOrEqual(0.5)
      expect(Math.abs(layer.yFrac) + layer.heightFrac / 2).toBeLessThanOrEqual(0.5)
    }
  })
})
