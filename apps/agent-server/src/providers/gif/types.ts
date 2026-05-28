import type { ProviderContext } from '../types.ts'

export type GifSearchProviderId = 'giphy'

export type GifSearchStrategy = 'auto' | 'giphy'

/** Content-rating filter passed through to the provider when supported. */
export type GifSearchRating = 'g' | 'pg' | 'pg-13' | 'r'

export interface GifSearchInput {
  /** Free-text search query. */
  query: string
  /**
   * Number of candidates to fetch from the provider. The tool currently
   * picks the top-1 by relevance for the timeline insert, but additional
   * candidates are returned so the agent can echo them in chat or the
   * caller can offer a "use the second one" follow-up.
   */
  limit?: number
  rating?: GifSearchRating
}

export interface GifSearchCandidate {
  /** Provider's canonical id for this gif (e.g. Giphy id). */
  id: string
  title: string
  /** Direct URL to the GIF bytes (animated). */
  sourceUrl: string
  /** URL of a static preview frame, useful for an in-chat thumbnail. */
  stillPreviewUrl?: string
  width?: number
  height?: number
  /**
   * Duration of the GIF's animation in seconds when the provider exposes
   * it. Often missing for Giphy — fall back to a sensible default
   * (e.g. 3s) on the timeline side.
   */
  durationSec?: number
  mimeType?: string
}

export interface GifSearchResult {
  /** Top-N candidates, ordered by provider relevance (best first). */
  candidates: ReadonlyArray<GifSearchCandidate>
  /** Provider's actual model / endpoint id used. */
  modelUsed: string
}

export interface GifSearchProvider {
  readonly id: GifSearchProviderId
  isAvailable(): boolean
  search(input: GifSearchInput, ctx: ProviderContext): Promise<GifSearchResult>
}
