import { describe, expect, it, vi } from 'vitest'
import { FalVideoProvider } from './fal.ts'
import type { ProviderContext } from '../types.ts'

function makeCtx(signal: AbortSignal = new AbortController().signal): {
  ctx: ProviderContext
  progress: Array<{ stage: string; fraction?: number; detail?: string }>
} {
  const progress: Array<{ stage: string; fraction?: number; detail?: string }> = []
  return {
    ctx: {
      bridge: { invokeBrowserAction: vi.fn() },
      signal,
      onProgress: (event) => progress.push(event),
    },
    progress,
  }
}

/**
 * Build a deterministic fetch stub that returns each response in order from
 * the supplied queue, matched by URL substring. Throws if no script entry
 * matches the URL, so tests fail loudly on unexpected calls.
 */
function makeFetch(
  script: Array<{ urlMatch: string; status?: number; body?: unknown; statusText?: string }>,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let scriptIndex = 0
  const fetchImpl: typeof fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url
    calls.push({ url, init })
    while (scriptIndex < script.length) {
      const entry = script[scriptIndex]
      if (!entry) break
      if (url.includes(entry.urlMatch)) {
        scriptIndex++
        return {
          ok: (entry.status ?? 200) < 400,
          status: entry.status ?? 200,
          statusText: entry.statusText ?? 'OK',
          json: async () => entry.body,
          text: async () =>
            typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body),
        } as unknown as Response
      }
      scriptIndex++
    }
    throw new Error(`unexpected fetch call: ${url}`)
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('FalVideoProvider', () => {
  it('isAvailable returns false when no api key', () => {
    const fal = new FalVideoProvider({ apiKey: undefined })
    expect(fal.isAvailable()).toBe(false)
  })

  it('isAvailable returns true when api key is present', () => {
    const fal = new FalVideoProvider({ apiKey: 'k' })
    expect(fal.isAvailable()).toBe(true)
  })

  it('throws if generate called without api key', async () => {
    const fal = new FalVideoProvider({ apiKey: undefined })
    const { ctx } = makeCtx()
    await expect(
      fal.generate({ prompt: 'a cat', aspect: '16:9', targetDurationSec: 5 }, ctx),
    ).rejects.toThrow(/FAL_API_KEY/)
  })

  it('happy path: submit → IN_QUEUE → IN_PROGRESS → COMPLETED → result', async () => {
    // Default model post-2026-05-27 is fal-ai/kling-video/v3/standard/text-to-video
    // (the v1.5/standard endpoint was retired by fal that day).
    const { fetchImpl, calls } = makeFetch([
      {
        urlMatch: 'queue.fal.run/fal-ai/kling-video/v3/standard/text-to-video',
        body: {
          request_id: 'req-1',
          status_url:
            'https://queue.fal.run/fal-ai/kling-video/v3/standard/text-to-video/requests/req-1/status',
          response_url:
            'https://queue.fal.run/fal-ai/kling-video/v3/standard/text-to-video/requests/req-1',
          cancel_url:
            'https://queue.fal.run/fal-ai/kling-video/v3/standard/text-to-video/requests/req-1/cancel',
        },
      },
      { urlMatch: '/status', body: { status: 'IN_QUEUE', queue_position: 3 } },
      { urlMatch: '/status', body: { status: 'IN_PROGRESS' } },
      { urlMatch: '/status', body: { status: 'COMPLETED' } },
      {
        urlMatch: 'requests/req-1',
        body: { video: { url: 'https://fal.media/abc.mp4' }, duration: 5 },
      },
    ])
    const fal = new FalVideoProvider({
      apiKey: 'k',
      fetchImpl,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    const { ctx, progress } = makeCtx()
    const result = await fal.generate(
      { prompt: 'city skyline', aspect: '16:9', targetDurationSec: 6 },
      ctx,
    )
    expect(result.sourceUrl).toBe('https://fal.media/abc.mp4')
    expect(result.modelUsed).toBe('fal-ai/kling-video/v3/standard/text-to-video')
    expect(result.durationSec).toBe(5)
    expect(progress.map((p) => p.stage)).toEqual([
      'submitting',
      'queued',
      'running',
      'fetching-result',
    ])
    expect(progress[1]?.detail).toBe('position 3')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: 'Key k' })
    // v3 Kling body — `duration` is a number-shaped string in 3..15 and
    // `generate_audio: false` is required.
    const body = JSON.parse(String(calls[0]?.init?.body))
    expect(body).toMatchObject({
      prompt: 'city skyline',
      aspect_ratio: '16:9',
      duration: '6',
      generate_audio: false,
    })
  })

  it('legacy kling (v1.5) snaps targetDuration to "5" or "10"', async () => {
    async function runWithDuration(seconds: number): Promise<string> {
      const { fetchImpl, calls } = makeFetch([
        { urlMatch: 'queue.fal.run/fal-ai', body: { request_id: 'r' } },
        { urlMatch: '/status', body: { status: 'COMPLETED' } },
        { urlMatch: 'requests/r', body: { video: { url: 'https://x.mp4' } } },
      ])
      const fal = new FalVideoProvider({ apiKey: 'k', fetchImpl, sleep: async () => {} })
      const { ctx } = makeCtx()
      await fal.generate(
        {
          prompt: 'p',
          aspect: '16:9',
          targetDurationSec: seconds,
          // Explicit legacy model — default is now v3 which uses a different
          // duration schema.
          model: 'fal-ai/kling-video/v1.5/standard/text-to-video',
        },
        ctx,
      )
      return JSON.parse(String(calls[0]?.init?.body)).duration as string
    }
    expect(await runWithDuration(3)).toBe('5') // <7.5
    expect(await runWithDuration(7)).toBe('5') // ≤7.5
    expect(await runWithDuration(8)).toBe('10') // >7.5
    expect(await runWithDuration(99)).toBe('10') // capped
  })

  it('kling v3 model uses the 3-15 duration window and generate_audio: false', async () => {
    const { fetchImpl, calls } = makeFetch([
      { urlMatch: 'queue.fal.run/fal-ai/kling-video/v3', body: { request_id: 'r' } },
      { urlMatch: '/status', body: { status: 'COMPLETED' } },
      { urlMatch: 'requests/r', body: { video: { url: 'https://x.mp4' } } },
    ])
    const fal = new FalVideoProvider({ apiKey: 'k', fetchImpl, sleep: async () => {} })
    const { ctx } = makeCtx()
    await fal.generate(
      {
        prompt: 'p',
        aspect: '16:9',
        targetDurationSec: 6,
        model: 'fal-ai/kling-video/v3/standard/text-to-video',
      },
      ctx,
    )
    const body = JSON.parse(String(calls[0]?.init?.body))
    expect(body).toMatchObject({
      prompt: 'p',
      aspect_ratio: '16:9',
      duration: '6',
      generate_audio: false,
    })

    const { fetchImpl: fetchImpl2, calls: calls2 } = makeFetch([
      { urlMatch: 'queue.fal.run/fal-ai/kling-video/v3', body: { request_id: 'r' } },
      { urlMatch: '/status', body: { status: 'COMPLETED' } },
      { urlMatch: 'requests/r', body: { video: { url: 'https://x.mp4' } } },
    ])
    const fal2 = new FalVideoProvider({ apiKey: 'k', fetchImpl: fetchImpl2, sleep: async () => {} })
    await fal2.generate(
      {
        prompt: 'p',
        aspect: '16:9',
        targetDurationSec: 1,
        model: 'fal-ai/kling-video/v3/pro/text-to-video',
      },
      ctx,
    )
    expect(JSON.parse(String(calls2[0]?.init?.body)).duration).toBe('3')
  })

  it('image-to-video model uses start_image_url + omits aspect_ratio + duration 3-15', async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        urlMatch: 'queue.fal.run/fal-ai/kling-video/v3/standard/image-to-video',
        body: { request_id: 'r' },
      },
      { urlMatch: '/status', body: { status: 'COMPLETED' } },
      { urlMatch: 'requests/r', body: { video: { url: 'https://x.mp4' } } },
    ])
    const fal = new FalVideoProvider({ apiKey: 'k', fetchImpl, sleep: async () => {} })
    const { ctx } = makeCtx()
    await fal.generate(
      {
        prompt: 'subtle drift',
        aspect: '16:9',
        targetDurationSec: 6,
        model: 'fal-ai/kling-video/v3/standard/image-to-video',
        imageUrl: 'https://fal.media/files/foo.png',
      },
      ctx,
    )
    const body = JSON.parse(String(calls[0]?.init?.body))
    expect(body).toEqual({
      prompt: 'subtle drift',
      start_image_url: 'https://fal.media/files/foo.png',
      duration: '6',
      generate_audio: false,
    })
    // The body MUST NOT include aspect_ratio — Kling image-to-video
    // auto-detects from the input image and rejects the field.
    expect(body).not.toHaveProperty('aspect_ratio')
  })

  it('image-to-video model rejects calls without imageUrl', async () => {
    const { fetchImpl } = makeFetch([
      { urlMatch: 'queue.fal.run/fal-ai', body: { request_id: 'r' } },
    ])
    const fal = new FalVideoProvider({ apiKey: 'k', fetchImpl, sleep: async () => {} })
    const { ctx } = makeCtx()
    await expect(
      fal.generate(
        {
          prompt: 'p',
          aspect: '16:9',
          targetDurationSec: 5,
          model: 'fal-ai/kling-video/v3/standard/image-to-video',
          // imageUrl deliberately missing
        },
        ctx,
      ),
    ).rejects.toThrow(/requires imageUrl/)
  })

  it('uses an overridden model when input.model is set', async () => {
    const { fetchImpl, calls } = makeFetch([
      { urlMatch: 'queue.fal.run/fal-ai/kling-video', body: { request_id: 'r' } },
      { urlMatch: '/status', body: { status: 'COMPLETED' } },
      { urlMatch: 'requests/r', body: { video: { url: 'https://x.mp4' } } },
    ])
    const fal = new FalVideoProvider({ apiKey: 'k', fetchImpl, sleep: async () => {} })
    const { ctx } = makeCtx()
    const r = await fal.generate(
      { prompt: 'p', aspect: '16:9', targetDurationSec: 5, model: 'fal-ai/kling-video' },
      ctx,
    )
    expect(r.modelUsed).toBe('fal-ai/kling-video')
    expect(calls[0]?.url).toContain('fal-ai/kling-video')
  })

  it('surfaces submit errors with status text and body excerpt', async () => {
    const { fetchImpl } = makeFetch([
      { urlMatch: 'queue.fal.run', status: 401, statusText: 'Unauthorized', body: 'bad key' },
    ])
    const fal = new FalVideoProvider({ apiKey: 'k', fetchImpl, sleep: async () => {} })
    const { ctx } = makeCtx()
    await expect(
      fal.generate({ prompt: 'p', aspect: '16:9', targetDurationSec: 5 }, ctx),
    ).rejects.toThrow(/fal submit failed: 401 Unauthorized.*bad key/)
  })

  it('throws when fal reports FAILED', async () => {
    const { fetchImpl } = makeFetch([
      { urlMatch: 'queue.fal.run/fal-ai', body: { request_id: 'r' } },
      { urlMatch: '/status', body: { status: 'FAILED' } },
    ])
    const fal = new FalVideoProvider({ apiKey: 'k', fetchImpl, sleep: async () => {} })
    const { ctx } = makeCtx()
    await expect(
      fal.generate({ prompt: 'p', aspect: '16:9', targetDurationSec: 5 }, ctx),
    ).rejects.toThrow(/fal job failed/)
  })

  it('throws when completed but no video URL', async () => {
    const { fetchImpl } = makeFetch([
      { urlMatch: 'queue.fal.run/fal-ai', body: { request_id: 'r' } },
      { urlMatch: '/status', body: { status: 'COMPLETED' } },
      { urlMatch: 'requests/r', body: {} },
    ])
    const fal = new FalVideoProvider({ apiKey: 'k', fetchImpl, sleep: async () => {} })
    const { ctx } = makeCtx()
    await expect(
      fal.generate({ prompt: 'p', aspect: '16:9', targetDurationSec: 5 }, ctx),
    ).rejects.toThrow(/no video URL/)
  })

  it('extracts URL from `output.url` shape', async () => {
    const { fetchImpl } = makeFetch([
      { urlMatch: 'queue.fal.run/fal-ai', body: { request_id: 'r' } },
      { urlMatch: '/status', body: { status: 'COMPLETED' } },
      { urlMatch: 'requests/r', body: { output: { url: 'https://o.mp4' } } },
    ])
    const fal = new FalVideoProvider({ apiKey: 'k', fetchImpl, sleep: async () => {} })
    const { ctx } = makeCtx()
    const r = await fal.generate({ prompt: 'p', aspect: '16:9', targetDurationSec: 5 }, ctx)
    expect(r.sourceUrl).toBe('https://o.mp4')
  })

  it('aborts mid-poll and posts to cancel_url', async () => {
    const ac = new AbortController()
    const { fetchImpl, calls } = makeFetch([
      {
        urlMatch: 'queue.fal.run/fal-ai',
        body: {
          request_id: 'r',
          cancel_url: 'https://queue.fal.run/cancel-here',
        },
      },
      // No status entries — we abort before the first status check.
      { urlMatch: 'cancel-here', body: {} },
    ])
    const fal = new FalVideoProvider({
      apiKey: 'k',
      fetchImpl,
      pollIntervalMs: 50,
      sleep: (ms, signal) =>
        new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, ms)
          signal.addEventListener('abort', () => {
            clearTimeout(t)
            reject(new DOMException('Aborted', 'AbortError'))
          })
        }),
    })
    const { ctx } = makeCtx(ac.signal)
    const promise = fal.generate({ prompt: 'p', aspect: '16:9', targetDurationSec: 5 }, ctx)
    setTimeout(() => ac.abort(), 10)
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    // submit + cancel were called.
    expect(calls.some((c) => c.url.includes('cancel-here'))).toBe(true)
  })
})
