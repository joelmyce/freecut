import { describe, expect, it } from 'vitest'
import { titleCardTemplate } from './title-card.ts'
import { getMotionGraphicTemplate, MOTION_GRAPHIC_TEMPLATE_IDS } from './index.ts'
import type { MgShapeLayer, MgTextLayer } from './types.ts'

describe('title_card template', () => {
  it('is registered and requires a title', () => {
    expect(MOTION_GRAPHIC_TEMPLATE_IDS).toContain('title_card')
    expect(getMotionGraphicTemplate('title_card')).toBe(titleCardTemplate)
    expect(titleCardTemplate.requiredContent).toEqual(['title'])
  })

  it('builds a divider + title (no subtitle layer) when no subtitle is given', () => {
    const spec = titleCardTemplate.build({ title: 'Chapter One' })
    expect(spec.templateId).toBe('title_card')
    expect(spec.layers).toHaveLength(2)
    expect(spec.layers[0]!.kind).toBe('shape') // accent divider, backmost
    const title = spec.layers[1] as MgTextLayer
    expect(title.kind).toBe('text')
    expect(title.text).toBe('Chapter One')
    expect(title.fontWeight).toBe('bold')
  })

  it('adds a subtitle layer when given', () => {
    const spec = titleCardTemplate.build({ title: 'How It Works', subtitle: 'a quick tour' })
    expect(spec.layers).toHaveLength(3)
    expect((spec.layers[2] as MgTextLayer).text).toBe('a quick tour')
  })

  it('themes the divider with the accent color', () => {
    const divider = titleCardTemplate.build({ title: 'X', accentColor: '#22D3EE' })
      .layers[0] as MgShapeLayer
    expect(divider.fillColor).toBe('#22D3EE')
  })

  it('grows the divider from zero width and scales the title in', () => {
    const spec = titleCardTemplate.build({ title: 'Hello' })
    const divider = spec.layers[0]!
    const widthAnim = (divider.animations ?? []).find((a) => a.property === 'width')!
    expect(widthAnim.keyframes[0]).toMatchObject({ atSec: 0, value: 0 })
    expect(widthAnim.keyframes[widthAnim.keyframes.length - 1]!.value).toBeGreaterThan(0)

    const title = spec.layers[1]!
    const fontAnim = (title.animations ?? []).find((a) => a.property === 'fontSize')!
    // grows from below resting up to resting
    expect(fontAnim.keyframes[0]!.value).toBeLessThan(fontAnim.keyframes[1]!.value)
  })

  it('keeps geometry within the canvas (center-origin fractions)', () => {
    const spec = titleCardTemplate.build({ title: 'Hello', subtitle: 'world' })
    for (const layer of spec.layers) {
      expect(Math.abs(layer.xFrac) + layer.widthFrac / 2).toBeLessThanOrEqual(0.5)
      expect(Math.abs(layer.yFrac) + layer.heightFrac / 2).toBeLessThanOrEqual(0.5)
    }
  })
})
