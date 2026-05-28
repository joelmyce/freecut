import { describe, expect, it, vi } from 'vitest'
import { GiphyGifProvider } from './giphy.ts'
import type { ProviderContext } from '../types.ts'

function ctx(signal?: AbortSignal): ProviderContext {
  return {
    bridge: { invokeBrowserAction: async () => undefined },
    signal: signal ?? new AbortController().signal,
  } as unknown as ProviderContext
}

function giphySuccessFetch(entries: ReadonlyArray<unknown>): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ data: entries, meta: { status: 200 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch
}

describe('GiphyGifProvider', () => {
  it('reports unavailable without an API key', () => {
    expect(new GiphyGifProvider({ apiKey: undefined }).isAvailable()).toBe(false)
    expect(new GiphyGifProvider({ apiKey: '' }).isAvailable()).toBe(false)
    expect(new GiphyGifProvider({ apiKey: '   ' }).isAvailable()).toBe(false)
  })

  it('reports available when an API key is provided', () => {
    expect(new GiphyGifProvider({ apiKey: 'k' }).isAvailable()).toBe(true)
  })

  it('parses Giphy search response into candidates', async () => {
    const fetchImpl = giphySuccessFetch([
      {
        id: 'abc123',
        title: 'excited high five',
        images: {
          original: { url: 'https://media.giphy.com/abc123.gif', width: '480', height: '270' },
          fixed_width_still: { url: 'https://media.giphy.com/abc123-still.gif' },
        },
      },
      {
        id: 'def456',
        title: 'celebrating',
        images: {
          original: { url: 'https://media.giphy.com/def456.gif', width: '500', height: '281' },
        },
      },
    ])

    const provider = new GiphyGifProvider({
      apiKey: 'test-key',
      fetchImpl,
      searchUrl: 'https://example.test/search',
    })
    const result = await provider.search({ query: 'excited high five', limit: 5 }, ctx())

    expect(result.candidates).toHaveLength(2)
    expect(result.candidates[0]?.id).toBe('abc123')
    expect(result.candidates[0]?.title).toBe('excited high five')
    expect(result.candidates[0]?.sourceUrl).toBe('https://media.giphy.com/abc123.gif')
    expect(result.candidates[0]?.stillPreviewUrl).toBe('https://media.giphy.com/abc123-still.gif')
    expect(result.candidates[0]?.width).toBe(480)
    expect(result.candidates[0]?.height).toBe(270)
    expect(result.candidates[0]?.mimeType).toBe('image/gif')
    expect(result.modelUsed).toBe('giphy:v1/gifs/search')

    // URL was constructed with the right params
    const callUrl = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(callUrl).toContain('q=excited+high+five')
    expect(callUrl).toContain('limit=5')
    expect(callUrl).toContain('rating=g')
    expect(callUrl).toContain('api_key=test-key')
  })

  it('honors an explicit rating', async () => {
    const fetchImpl = giphySuccessFetch([
      { id: 'x', images: { original: { url: 'https://example.test/x.gif' } } },
    ])
    const provider = new GiphyGifProvider({
      apiKey: 'k',
      fetchImpl,
      searchUrl: 'https://example.test/search',
    })
    await provider.search({ query: 'q', rating: 'pg-13' }, ctx())

    const callUrl = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(callUrl).toContain('rating=pg-13')
  })

  it('clamps the limit param within 1..25', async () => {
    const fetchImpl = giphySuccessFetch([
      { id: 'x', images: { original: { url: 'https://example.test/x.gif' } } },
    ])
    const provider = new GiphyGifProvider({
      apiKey: 'k',
      fetchImpl,
      searchUrl: 'https://example.test/search',
    })

    await provider.search({ query: 'q', limit: 9999 }, ctx())
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain(
      'limit=25',
    )

    await provider.search({ query: 'q', limit: 0 }, ctx())
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]).toContain(
      'limit=1',
    )
  })

  it('skips entries without an original.url', async () => {
    const fetchImpl = giphySuccessFetch([
      { id: 'good', images: { original: { url: 'https://example.test/good.gif' } } },
      { id: 'broken', images: { original: {} } },
      { id: 'no-images' },
    ])
    const provider = new GiphyGifProvider({
      apiKey: 'k',
      fetchImpl,
      searchUrl: 'https://example.test/search',
    })

    const result = await provider.search({ query: 'q' }, ctx())
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.id).toBe('good')
  })

  it('throws when Giphy returns zero usable results', async () => {
    const fetchImpl = giphySuccessFetch([])
    const provider = new GiphyGifProvider({
      apiKey: 'k',
      fetchImpl,
      searchUrl: 'https://example.test/search',
    })

    await expect(provider.search({ query: 'asdfqwer' }, ctx())).rejects.toThrow(/no usable results/)
  })

  it('throws with the API status when Giphy returns a non-2xx response', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('rate limited', { status: 429 }),
    ) as unknown as typeof fetch

    const provider = new GiphyGifProvider({
      apiKey: 'k',
      fetchImpl,
      searchUrl: 'https://example.test/search',
    })

    await expect(provider.search({ query: 'q' }, ctx())).rejects.toThrow(/Giphy search failed: 429/)
  })

  it('throws without an API key', async () => {
    const provider = new GiphyGifProvider({ apiKey: undefined })
    await expect(provider.search({ query: 'q' }, ctx())).rejects.toThrow(/GIPHY_API_KEY/)
  })

  it('rejects empty queries', async () => {
    const provider = new GiphyGifProvider({
      apiKey: 'k',
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })
    await expect(provider.search({ query: '' }, ctx())).rejects.toThrow(/non-empty query/)
    await expect(provider.search({ query: '   ' }, ctx())).rejects.toThrow(/non-empty query/)
  })
})
