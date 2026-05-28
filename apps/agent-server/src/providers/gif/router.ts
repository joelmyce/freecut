import type { GifSearchProvider, GifSearchStrategy } from './types.ts'

export interface PickGifSearchProviderResult {
  provider: GifSearchProvider
  reason: string
}

/**
 * Pick a GIF search provider. Mirrors the image/video router single-default
 * shape — `auto` picks the only available provider (currently Giphy).
 * Add more providers (Tenor, etc.) here as we wire them; routing is the
 * only thing that needs updating.
 */
export function pickGifSearchProvider(
  providers: ReadonlyArray<GifSearchProvider>,
  strategy: GifSearchStrategy,
): PickGifSearchProviderResult {
  if (strategy === 'giphy') {
    const giphy = providers.find((p) => p.id === 'giphy' && p.isAvailable())
    if (!giphy) {
      throw new Error('Giphy provider is not available (missing GIPHY_API_KEY)')
    }
    return { provider: giphy, reason: 'explicit strategy: giphy' }
  }

  // strategy === 'auto'
  const giphy = providers.find((p) => p.id === 'giphy' && p.isAvailable())
  if (giphy) return { provider: giphy, reason: 'auto: defaulting to giphy' }

  throw new Error('No GIF search provider is available. Set GIPHY_API_KEY in .env to enable Giphy.')
}
