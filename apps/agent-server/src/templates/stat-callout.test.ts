import { describe, expect, it } from 'vitest'
import { statCalloutTemplate } from './stat-callout.ts'
import { getMotionGraphicTemplate, MOTION_GRAPHIC_TEMPLATE_IDS } from './index.ts'
import type { MgShapeLayer, MgTextLayer } from './types.ts'

describe('stat_callout template', () => {
  it('is registered and requires a value', () => {
    expect(MOTION_GRAPHIC_TEMPLATE_IDS).toContain('stat_callout')
    expect(getMotionGraphicTemplate('stat_callout')).toBe(statCalloutTemplate)
    expect(statCalloutTemplate.requiredContent).toEqual(['value'])
  })

  it('builds a single value layer when no label is given', () => {
    const spec = statCalloutTemplate.build({ value: '10,000+' })
    expect(spec.templateId).toBe('stat_callout')
    expect(spec.layers).toHaveLength(1)
    const valueLayer = spec.layers[0] as MgTextLayer
    expect(valueLayer.kind).toBe('text')
    // value is kept verbatim as a string — formats like commas / units survive
    expect(valueLayer.text).toBe('10,000+')
  })

  it('preserves arbitrary string values like currency and percentages', () => {
    expect((statCalloutTemplate.build({ value: '$2.5M' }).layers[0] as MgTextLayer).text).toBe(
      '$2.5M',
    )
    expect((statCalloutTemplate.build({ value: '98%' }).layers[0] as MgTextLayer).text).toBe('98%')
  })

  it('adds an accent-colored label layer when given', () => {
    const spec = statCalloutTemplate.build(
      { value: '3x', label: 'faster' },
      { accentColor: '#22D3EE' },
    )
    expect(spec.layers).toHaveLength(2)
    const label = spec.layers[1] as MgTextLayer
    expect(label.text).toBe('faster')
    expect(label.color).toBe('#22D3EE')
  })

  it('applies brand style: flat background, value color, label accent, and font', () => {
    const spec = statCalloutTemplate.build(
      { value: '10,000+', label: 'suscriptores' },
      {
        titleColor: '#0B1220',
        accentColor: '#2B5CE6',
        backgroundColor: '#F5F0E8',
        fontFamily: 'Fraunces',
      },
    )
    const bg = spec.layers[0] as MgShapeLayer
    expect(bg.name).toBe('Background')
    expect(bg.fillColor).toBe('#F5F0E8')
    const value = spec.layers.find((l) => l.name === 'Stat value') as MgTextLayer
    expect(value.color).toBe('#0B1220')
    expect(value.fontFamily).toBe('Fraunces')
    const label = spec.layers.find((l) => l.name === 'Stat label') as MgTextLayer
    expect(label.color).toBe('#2B5CE6')
    expect(label.fontFamily).toBe('Fraunces')
  })

  it('pops the value with a font-scale overshoot (mid keyframe exceeds the resting size)', () => {
    const valueLayer = statCalloutTemplate.build({ value: '42' }).layers[0]!
    const fontAnim = (valueLayer.animations ?? []).find((a) => a.property === 'fontSize')!
    expect(fontAnim.keyframes).toHaveLength(3)
    const [start, peak, settle] = fontAnim.keyframes
    expect(peak!.value).toBeGreaterThan(settle!.value) // overshoot above resting
    expect(start!.value).toBeLessThan(settle!.value) // starts small
  })

  it('keeps geometry within the canvas (center-origin fractions)', () => {
    const spec = statCalloutTemplate.build({ value: '10,000+', label: 'subscribers' })
    for (const layer of spec.layers) {
      expect(Math.abs(layer.xFrac) + layer.widthFrac / 2).toBeLessThanOrEqual(0.5)
      expect(Math.abs(layer.yFrac) + layer.heightFrac / 2).toBeLessThanOrEqual(0.5)
    }
  })
})
