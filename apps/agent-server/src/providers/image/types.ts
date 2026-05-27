import type { ProviderContext } from '../types.ts'

export type ImageGenerationProviderId = 'fal-image'

export type ImageGenerationStrategy = 'auto' | 'fal'

export type ImageAspectRatio = '16:9' | '9:16' | '1:1' | '4:3' | '3:4'

/**
 * Resolution tier. The provider maps these to concrete pixel dimensions
 * (multiples of 16, ≤3840px per fal's image_size cap):
 *   - `standard` — ~1024px short edge. Fastest, cheapest, lowest quality.
 *   - `high` — ~1080p (1920px long edge). Matches typical 1080p timelines
 *     without upscale-blur.
 *   - `max` — ~2K / 1440p (2560px long edge). Default. Crisp on 4K
 *     timelines, slower + costlier per gen. fal may upsample beyond the
 *     model's native render res, so visible detail caps somewhere
 *     between high and max.
 */
export type ImageResolutionTier = 'standard' | 'high' | 'max'

export interface ImageGenerationInput {
  prompt: string
  aspect: ImageAspectRatio
  /** Resolution tier — defaults to 'max' (2K) when omitted. */
  resolution?: ImageResolutionTier
  /** Optional provider-specific model id. Each provider has its own default. */
  model?: string
}

export interface ImageGenerationResult {
  /** Direct URL to the generated image bytes. */
  sourceUrl: string
  /** Provider's actual model id used (in case input.model was omitted). */
  modelUsed: string
  /** Reported width/height when the provider returns them. Helps the browser pick canvas sizing. */
  width?: number
  height?: number
  /** USD cost when the provider exposes it; undefined otherwise. */
  cost?: { amount: number; currency: 'USD' }
  /** MIME hint for the source URL (e.g. image/png, image/jpeg). */
  mimeType?: string
}

export interface ImageGenerationProvider {
  readonly id: ImageGenerationProviderId
  isAvailable(): boolean
  generate(input: ImageGenerationInput, ctx: ProviderContext): Promise<ImageGenerationResult>
}
