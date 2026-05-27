import { describe, expect, it } from 'vitest'
import { pickVideoGenerationProvider } from './router.ts'
import type { VideoGenerationProvider } from './types.ts'

function mock(id: VideoGenerationProvider['id'], available: boolean): VideoGenerationProvider {
  return {
    id,
    isAvailable: () => available,
    generate: async () => ({ sourceUrl: '', modelUsed: '', durationSec: 0 }),
  }
}

describe('pickVideoGenerationProvider', () => {
  it('explicit fal works', () => {
    const r = pickVideoGenerationProvider([mock('fal', true)], 'fal')
    expect(r.provider.id).toBe('fal')
    expect(r.reason).toMatch(/explicit/)
  })

  it('explicit fal throws when unavailable', () => {
    expect(() => pickVideoGenerationProvider([mock('fal', false)], 'fal')).toThrow(/FAL_API_KEY/)
  })

  it('explicit kie throws when not registered', () => {
    expect(() => pickVideoGenerationProvider([mock('fal', true)], 'kie')).toThrow()
  })

  it('auto picks fal when available', () => {
    const r = pickVideoGenerationProvider([mock('fal', true), mock('kie', true)], 'auto')
    expect(r.provider.id).toBe('fal')
  })

  it('auto falls through to kie when fal unavailable', () => {
    const r = pickVideoGenerationProvider([mock('fal', false), mock('kie', true)], 'auto')
    expect(r.provider.id).toBe('kie')
  })

  it('auto throws when nothing is available', () => {
    expect(() => pickVideoGenerationProvider([mock('fal', false)], 'auto')).toThrow()
  })
})
