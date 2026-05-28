import type { ProviderContext } from '../types.ts'
import type {
  GifSearchCandidate,
  GifSearchInput,
  GifSearchProvider,
  GifSearchResult,
} from './types.ts'

const GIPHY_SEARCH_URL = 'https://api.giphy.com/v1/gifs/search'

/**
 * Giphy search REST endpoint (`/v1/gifs/search`).
 *
 * Auth: api key as the `api_key` query param. Validated against
 * https://developers.giphy.com/docs/api/endpoint/#search on 2026-05-27.
 *
 * Response shape (trimmed to what we read):
 *   `{ data: [{ id, title, images: { original: { url, width, height } } }, ...] }`
 *
 * We pull `images.original.url` for the animated GIF and
 * `images.fixed_width_still.url` for an in-chat preview thumbnail.
 */
const DEFAULT_LIMIT = 5

/**
 * Hard ceiling on the limit parameter — keeps the response small even if
 * the agent passes a wild value. Giphy itself accepts up to 50 per page.
 */
const MAX_LIMIT = 25

interface GiphyImage {
  url?: string
  width?: string | number
  height?: string | number
}

interface GiphySearchEntry {
  id: string
  title?: string
  images?: {
    original?: GiphyImage
    fixed_width_still?: GiphyImage
  }
}

interface GiphySearchResponse {
  data?: ReadonlyArray<GiphySearchEntry>
  meta?: { status?: number; msg?: string }
  pagination?: { count?: number; total_count?: number; offset?: number }
}

export interface GiphyGifProviderOptions {
  apiKey: string | undefined
  fetchImpl?: typeof fetch
  /** Override the search URL — used by tests with a mock server. */
  searchUrl?: string
}

export class GiphyGifProvider implements GifSearchProvider {
  readonly id = 'giphy' as const
  private readonly apiKey: string | undefined
  private readonly fetchImpl: typeof fetch
  private readonly searchUrl: string

  constructor(options: GiphyGifProviderOptions) {
    const trimmed = options.apiKey?.trim()
    this.apiKey = trimmed && trimmed.length > 0 ? trimmed : undefined
    this.fetchImpl = options.fetchImpl ?? fetch
    this.searchUrl = options.searchUrl ?? GIPHY_SEARCH_URL
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey)
  }

  async search(input: GifSearchInput, ctx: ProviderContext): Promise<GifSearchResult> {
    if (!this.apiKey) {
      throw new Error('Giphy provider requires GIPHY_API_KEY')
    }
    const query = input.query.trim()
    if (query.length === 0) {
      throw new Error('Giphy search requires a non-empty query')
    }

    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT)))
    const params = new URLSearchParams({
      api_key: this.apiKey,
      q: query,
      limit: String(limit),
      rating: input.rating ?? 'g',
      lang: 'en',
    })
    const url = `${this.searchUrl}?${params.toString()}`

    ctx.onProgress?.({ stage: 'searching-gifs' })
    const res = await this.fetchImpl(url, { method: 'GET', signal: ctx.signal })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const suffix = detail ? ` — ${detail.slice(0, 500)}` : ''
      throw new Error(`Giphy search failed: ${res.status} ${res.statusText}${suffix}`)
    }

    const json = (await res.json()) as GiphySearchResponse
    const entries = json.data ?? []
    const candidates: GifSearchCandidate[] = []
    for (const entry of entries) {
      const original = entry.images?.original
      const originalUrl = typeof original?.url === 'string' ? original.url : undefined
      if (!originalUrl) continue
      const still = entry.images?.fixed_width_still
      candidates.push({
        id: entry.id,
        title: entry.title ?? '',
        sourceUrl: originalUrl,
        stillPreviewUrl: typeof still?.url === 'string' ? still.url : undefined,
        width: toDimension(original?.width),
        height: toDimension(original?.height),
        mimeType: 'image/gif',
      })
    }

    if (candidates.length === 0) {
      throw new Error(`Giphy returned no usable results for "${query}"`)
    }

    return { candidates, modelUsed: 'giphy:v1/gifs/search' }
  }
}

function toDimension(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.length > 0) {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}
