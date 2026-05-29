import { describe, expect, it } from 'vitest'
import { estimateVideoGenerationCost } from './cost.ts'

describe('estimateVideoGenerationCost', () => {
  it('always flags the figure as an estimate in USD', () => {
    const est = estimateVideoGenerationCost('fal-ai/kling-video/v3/standard/image-to-video', 5)
    expect(est.isEstimate).toBe(true)
    expect(est.currency).toBe('USD')
    expect(est.amount).toBeGreaterThan(0)
  })

  it('scales linearly with duration', () => {
    const model = 'fal-ai/kling-video/v3/standard/image-to-video'
    const five = estimateVideoGenerationCost(model, 5).amount
    const ten = estimateVideoGenerationCost(model, 10).amount
    expect(ten).toBeCloseTo(five * 2, 5)
  })

  it('charges more for pro tiers than standard', () => {
    const pro = estimateVideoGenerationCost('fal-ai/kling-video/v3/pro/image-to-video', 5).amount
    const standard = estimateVideoGenerationCost(
      'fal-ai/kling-video/v3/standard/image-to-video',
      5,
    ).amount
    expect(pro).toBeGreaterThan(standard)
  })

  it('falls back to a sane positive amount for unknown models / bad durations', () => {
    expect(estimateVideoGenerationCost('some/unknown/model', 0).amount).toBeGreaterThan(0)
    expect(estimateVideoGenerationCost('some/unknown/model', Number.NaN).amount).toBeGreaterThan(0)
    expect(estimateVideoGenerationCost('some/unknown/model', -3).amount).toBeGreaterThan(0)
  })

  it('rounds to whole cents', () => {
    const est = estimateVideoGenerationCost('fal-ai/kling-video/v3/standard/image-to-video', 7)
    expect(est.amount).toBe(Math.round(est.amount * 100) / 100)
  })
})
