import type { ImageGenerationProvider, ImageGenerationStrategy } from './types.ts'

export interface PickImageGenerationProviderResult {
  provider: ImageGenerationProvider
  reason: string
}

/**
 * Pick an image-generation provider. Mirrors the video router's
 * single-default shape — `auto` picks the only available provider
 * (currently fal). Add more providers here as we wire them; the
 * routing decision is the only thing that needs updating.
 */
export function pickImageGenerationProvider(
  providers: ReadonlyArray<ImageGenerationProvider>,
  strategy: ImageGenerationStrategy,
): PickImageGenerationProviderResult {
  if (strategy === 'fal') {
    const fal = providers.find((p) => p.id === 'fal-image' && p.isAvailable())
    if (!fal) {
      throw new Error('fal image provider is not available (missing FAL_API_KEY)')
    }
    return { provider: fal, reason: 'explicit strategy: fal' }
  }

  // strategy === 'auto'
  const fal = providers.find((p) => p.id === 'fal-image' && p.isAvailable())
  if (fal) return { provider: fal, reason: 'auto: defaulting to fal' }

  throw new Error(
    'No image generation provider is available. Set FAL_API_KEY in .env to enable fal.',
  )
}
