import type { ProviderContext } from '../types.ts'

export type VideoGenerationProviderId = 'fal' | 'kie'

export type VideoGenerationStrategy = 'auto' | 'fal' | 'kie'

export type VideoAspectRatio = '16:9' | '9:16' | '1:1'

export interface VideoGenerationInput {
  prompt: string
  aspect: VideoAspectRatio
  /** Desired duration of the generated clip in seconds; provider may snap to nearest supported. */
  targetDurationSec: number
  /** Optional provider-specific model id. Each provider has its own default. */
  model?: string
}

export interface VideoGenerationResult {
  /** Direct URL to the rendered video bytes. */
  sourceUrl: string
  /** Provider's actual model id used (in case input.model was omitted). */
  modelUsed: string
  /** Actual duration of the rendered clip; provider-reported when known, else estimated. */
  durationSec: number
  /** USD cost when the provider exposes it; undefined otherwise. */
  cost?: { amount: number; currency: 'USD' }
  /** MIME hint for the source URL (defaults to video/mp4). */
  mimeType?: string
}

export interface VideoGenerationProvider {
  readonly id: VideoGenerationProviderId
  isAvailable(): boolean
  generate(input: VideoGenerationInput, ctx: ProviderContext): Promise<VideoGenerationResult>
}
