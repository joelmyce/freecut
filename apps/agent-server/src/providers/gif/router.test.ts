import { describe, expect, it } from 'vitest'
import { pickGifSearchProvider } from './router.ts'
import type { GifSearchProvider, GifSearchResult } from './types.ts'

function mockProvider(available: boolean): GifSearchProvider {
  return {
    id: 'giphy',
    isAvailable: () => available,
    search: async (): Promise<GifSearchResult> => ({
      candidates: [],
      modelUsed: 'giphy:v1/gifs/search',
    }),
  }
}

describe('pickGifSearchProvider', () => {
  it('returns giphy when "giphy" is requested and available', () => {
    const result = pickGifSearchProvider([mockProvider(true)], 'giphy')
    expect(result.provider.id).toBe('giphy')
    expect(result.reason).toMatch(/explicit/)
  })

  it('throws when "giphy" is requested but unavailable', () => {
    expect(() => pickGifSearchProvider([mockProvider(false)], 'giphy')).toThrow(
      /Giphy provider is not available/,
    )
  })

  it('returns giphy for "auto" when available', () => {
    const result = pickGifSearchProvider([mockProvider(true)], 'auto')
    expect(result.provider.id).toBe('giphy')
    expect(result.reason).toMatch(/auto: defaulting to giphy/)
  })

  it('throws for "auto" when no provider is available', () => {
    expect(() => pickGifSearchProvider([mockProvider(false)], 'auto')).toThrow(
      /No GIF search provider is available/,
    )
    expect(() => pickGifSearchProvider([], 'auto')).toThrow(/No GIF search provider is available/)
  })
})
