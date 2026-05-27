import { describe, expect, it, vi } from 'vitest'
import { FalImageProvider } from './fal.ts'
import type { ProviderContext } from '../types.ts'

interface MockResponse {
  /** Substring to match against the request URL. First match wins. */
  urlMatch: string
  body: unknown
  status?: number
}

function makeFetch(responses: ReadonlyArray<MockResponse>): {
  fetchImpl: typeof fetch
  calls: Array<{ url: string; init?: RequestInit }>
} {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let index = 0
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const match = responses.slice(index).find((r) => url.includes(r.urlMatch))
    if (!match) throw new Error(`no mock response for url: ${url}`)
    index = responses.indexOf(match) + 1
    return new Response(JSON.stringify(match.body), {
      status: match.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function makeCtx(): {
  ctx: ProviderContext
  progress: Array<{ stage: string; detail?: string }>
} {
  const progress: Array<{ stage: string; detail?: string }> = []
  return {
    ctx: {
      bridge: {
        invokeBrowserAction: async <T = unknown>() => ({}) as T,
      },
      signal: new AbortController().signal,
      onProgress: (e) => progress.push(e),
    },
    progress,
  }
}

describe('FalImageProvider', () => {
  it('reports unavailable without an API key', () => {
    const provider = new FalImageProvider({ apiKey: undefined })
    expect(provider.isAvailable()).toBe(false)
  })

  it('reports available with an API key', () => {
    const provider = new FalImageProvider({ apiKey: 'k' })
    expect(provider.isAvailable()).toBe(true)
  })

  it('happy path: submit → COMPLETED → returns image url + model', async () => {
    // Note: openai/gpt-image-2 is vendor-namespaced on fal — no `fal-ai/`
    // prefix — and the queue URL reflects that.
    const { fetchImpl, calls } = makeFetch([
      {
        urlMatch: 'queue.fal.run/openai/gpt-image-2',
        body: {
          request_id: 'req-img-1',
          status_url: 'https://queue.fal.run/openai/gpt-image-2/requests/req-img-1/status',
          response_url: 'https://queue.fal.run/openai/gpt-image-2/requests/req-img-1',
        },
      },
      { urlMatch: '/status', body: { status: 'COMPLETED' } },
      {
        urlMatch: 'requests/req-img-1',
        body: {
          images: [
            {
              url: 'https://fal.media/img.png',
              width: 1920,
              height: 1080,
              content_type: 'image/png',
            },
          ],
        },
      },
    ])
    const provider = new FalImageProvider({
      apiKey: 'k',
      fetchImpl,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    const { ctx, progress } = makeCtx()
    const result = await provider.generate({ prompt: 'a screenshot', aspect: '16:9' }, ctx)

    expect(result.sourceUrl).toBe('https://fal.media/img.png')
    expect(result.modelUsed).toBe('openai/gpt-image-2')
    expect(result.width).toBe(1920)
    expect(result.height).toBe(1080)
    expect(result.mimeType).toBe('image/png')

    // Mock jumps straight from submission to COMPLETED, so the 'running'
    // progress event (emitted only on an IN_PROGRESS status response) never
    // fires. The router still emits submitting + fetching-result.
    expect(progress.map((p) => p.stage)).toEqual(['submitting', 'fetching-result'])

    const body = JSON.parse(String(calls[0]?.init?.body))
    expect(body.prompt).toBe('a screenshot')
    // Default resolution is "max" — 2K custom dimensions, not the preset name.
    // The "standard" tier still produces the preset string (covered by its
    // own test below).
    expect(body.image_size).toEqual({ width: 2560, height: 1440 })
  })

  it('defaults to "max" (2K) custom dimensions when resolution is omitted', async () => {
    const { fetchImpl, calls } = makeFetch([
      { urlMatch: 'queue.fal.run/openai', body: { request_id: 'r' } },
      { urlMatch: '/status', body: { status: 'COMPLETED' } },
      {
        urlMatch: 'requests/r',
        body: { images: [{ url: 'https://x/y.png', width: 2560, height: 1440 }] },
      },
    ])
    const provider = new FalImageProvider({ apiKey: 'k', fetchImpl, sleep: async () => {} })
    const { ctx } = makeCtx()
    await provider.generate({ prompt: 'p', aspect: '16:9' }, ctx)
    const body = JSON.parse(String(calls[0]?.init?.body))
    expect(body.image_size).toEqual({ width: 2560, height: 1440 })
  })

  it('"standard" tier falls back to fal preset enum names', async () => {
    async function runWithAspect(aspect: '16:9' | '9:16' | '1:1' | '4:3' | '3:4'): Promise<string> {
      const { fetchImpl, calls } = makeFetch([
        { urlMatch: 'queue.fal.run/openai', body: { request_id: 'r' } },
        { urlMatch: '/status', body: { status: 'COMPLETED' } },
        {
          urlMatch: 'requests/r',
          body: { images: [{ url: 'https://x/y.png', width: 100, height: 100 }] },
        },
      ])
      const provider = new FalImageProvider({ apiKey: 'k', fetchImpl, sleep: async () => {} })
      const { ctx } = makeCtx()
      await provider.generate({ prompt: 'p', aspect, resolution: 'standard' }, ctx)
      return JSON.parse(String(calls[0]?.init?.body)).image_size as string
    }
    expect(await runWithAspect('16:9')).toBe('landscape_16_9')
    expect(await runWithAspect('9:16')).toBe('portrait_16_9')
    expect(await runWithAspect('4:3')).toBe('landscape_4_3')
    expect(await runWithAspect('3:4')).toBe('portrait_4_3')
    expect(await runWithAspect('1:1')).toBe('square_hd')
  })

  it('"high" tier sends 1080p-class custom dimensions per aspect', async () => {
    async function runWithAspect(
      aspect: '16:9' | '9:16' | '1:1' | '4:3' | '3:4',
    ): Promise<{ width: number; height: number }> {
      const { fetchImpl, calls } = makeFetch([
        { urlMatch: 'queue.fal.run/openai', body: { request_id: 'r' } },
        { urlMatch: '/status', body: { status: 'COMPLETED' } },
        {
          urlMatch: 'requests/r',
          body: { images: [{ url: 'https://x/y.png', width: 100, height: 100 }] },
        },
      ])
      const provider = new FalImageProvider({ apiKey: 'k', fetchImpl, sleep: async () => {} })
      const { ctx } = makeCtx()
      await provider.generate({ prompt: 'p', aspect, resolution: 'high' }, ctx)
      return JSON.parse(String(calls[0]?.init?.body)).image_size as {
        width: number
        height: number
      }
    }
    expect(await runWithAspect('16:9')).toEqual({ width: 1920, height: 1088 })
    expect(await runWithAspect('9:16')).toEqual({ width: 1088, height: 1920 })
    expect(await runWithAspect('4:3')).toEqual({ width: 1600, height: 1200 })
    expect(await runWithAspect('3:4')).toEqual({ width: 1200, height: 1600 })
    expect(await runWithAspect('1:1')).toEqual({ width: 1536, height: 1536 })
    // All values are multiples of 16 (fal's requirement).
    for (const aspect of ['16:9', '9:16', '4:3', '3:4', '1:1'] as const) {
      const { width, height } = await runWithAspect(aspect)
      expect(width % 16).toBe(0)
      expect(height % 16).toBe(0)
    }
  })

  it('"max" tier sends 2K-class custom dimensions per aspect', async () => {
    async function runWithAspect(
      aspect: '16:9' | '9:16' | '1:1' | '4:3' | '3:4',
    ): Promise<{ width: number; height: number }> {
      const { fetchImpl, calls } = makeFetch([
        { urlMatch: 'queue.fal.run/openai', body: { request_id: 'r' } },
        { urlMatch: '/status', body: { status: 'COMPLETED' } },
        {
          urlMatch: 'requests/r',
          body: { images: [{ url: 'https://x/y.png', width: 100, height: 100 }] },
        },
      ])
      const provider = new FalImageProvider({ apiKey: 'k', fetchImpl, sleep: async () => {} })
      const { ctx } = makeCtx()
      await provider.generate({ prompt: 'p', aspect, resolution: 'max' }, ctx)
      return JSON.parse(String(calls[0]?.init?.body)).image_size as {
        width: number
        height: number
      }
    }
    expect(await runWithAspect('16:9')).toEqual({ width: 2560, height: 1440 })
    expect(await runWithAspect('9:16')).toEqual({ width: 1440, height: 2560 })
    expect(await runWithAspect('4:3')).toEqual({ width: 1920, height: 1440 })
    expect(await runWithAspect('3:4')).toEqual({ width: 1440, height: 1920 })
    expect(await runWithAspect('1:1')).toEqual({ width: 2048, height: 2048 })
    // All under fal's 3840 max edge.
    for (const aspect of ['16:9', '9:16', '4:3', '3:4', '1:1'] as const) {
      const { width, height } = await runWithAspect(aspect)
      expect(width).toBeLessThanOrEqual(3840)
      expect(height).toBeLessThanOrEqual(3840)
    }
  })

  it('handles single-image `image` response shape', async () => {
    const { fetchImpl } = makeFetch([
      { urlMatch: 'queue.fal.run/openai', body: { request_id: 'r' } },
      { urlMatch: '/status', body: { status: 'COMPLETED' } },
      {
        urlMatch: 'requests/r',
        body: { image: { url: 'https://x/single.png', width: 512, height: 512 } },
      },
    ])
    const provider = new FalImageProvider({ apiKey: 'k', fetchImpl, sleep: async () => {} })
    const { ctx } = makeCtx()
    const result = await provider.generate({ prompt: 'p', aspect: '1:1' }, ctx)
    expect(result.sourceUrl).toBe('https://x/single.png')
  })

  it('throws when fal submission fails', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('quota exceeded', { status: 429 }),
    ) as unknown as typeof fetch
    const provider = new FalImageProvider({ apiKey: 'k', fetchImpl, sleep: async () => {} })
    const { ctx } = makeCtx()
    await expect(provider.generate({ prompt: 'p', aspect: '16:9' }, ctx)).rejects.toThrow(
      /fal image submit failed: 429/,
    )
  })

  it('throws when the job ends in FAILED', async () => {
    const { fetchImpl } = makeFetch([
      { urlMatch: 'queue.fal.run/openai', body: { request_id: 'r' } },
      { urlMatch: '/status', body: { status: 'FAILED' } },
    ])
    const provider = new FalImageProvider({ apiKey: 'k', fetchImpl, sleep: async () => {} })
    const { ctx } = makeCtx()
    await expect(provider.generate({ prompt: 'p', aspect: '16:9' }, ctx)).rejects.toThrow(
      /fal image job failed/,
    )
  })

  it('throws when no image URL is in the response', async () => {
    const { fetchImpl } = makeFetch([
      { urlMatch: 'queue.fal.run/openai', body: { request_id: 'r' } },
      { urlMatch: '/status', body: { status: 'COMPLETED' } },
      { urlMatch: 'requests/r', body: { images: [] } },
    ])
    const provider = new FalImageProvider({ apiKey: 'k', fetchImpl, sleep: async () => {} })
    const { ctx } = makeCtx()
    await expect(provider.generate({ prompt: 'p', aspect: '16:9' }, ctx)).rejects.toThrow(
      /no image URL in response/,
    )
  })

  it('throws without an API key', async () => {
    const provider = new FalImageProvider({ apiKey: undefined })
    const { ctx } = makeCtx()
    await expect(provider.generate({ prompt: 'p', aspect: '16:9' }, ctx)).rejects.toThrow(
      /FAL_API_KEY/,
    )
  })
})
