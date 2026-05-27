import { describe, expect, it } from 'vitest'
import { pickImageGenerationProvider } from './router.ts'
import type { ImageGenerationProvider, ImageGenerationResult } from './types.ts'

function mockProvider(available: boolean): ImageGenerationProvider {
  return {
    id: 'fal-image',
    isAvailable: () => available,
    generate: async (): Promise<ImageGenerationResult> => ({
      sourceUrl: 'https://x/y.png',
      modelUsed: 'fal-ai/openai/gpt-image-2',
    }),
  }
}

describe('pickImageGenerationProvider', () => {
  it('returns fal when "fal" is requested and available', () => {
    const result = pickImageGenerationProvider([mockProvider(true)], 'fal')
    expect(result.provider.id).toBe('fal-image')
    expect(result.reason).toMatch(/explicit/)
  })

  it('throws when "fal" is requested but unavailable', () => {
    expect(() => pickImageGenerationProvider([mockProvider(false)], 'fal')).toThrow(/FAL_API_KEY/)
  })

  it('auto defaults to fal when available', () => {
    const result = pickImageGenerationProvider([mockProvider(true)], 'auto')
    expect(result.provider.id).toBe('fal-image')
    expect(result.reason).toMatch(/auto: defaulting to fal/)
  })

  it('auto throws when no provider is available', () => {
    expect(() => pickImageGenerationProvider([mockProvider(false)], 'auto')).toThrow(
      /No image generation provider is available/,
    )
  })
})
