import { describe, expect, it, vi } from 'vitest'
import type { BrowserActionBridge, ProviderContext } from '../types.ts'
import { GeminiVideoAnalysisProvider } from './gemini.ts'
import type { VideoAnalysisResult } from './types.ts'

function bridgeWithClip(payload: {
  bytes: string
  filename: string
  mimeType: string
  durationSec: number
}) {
  return {
    invokeBrowserAction: vi.fn(async (action: string) =>
      action === 'read-clip-video-bytes' ? payload : undefined,
    ),
  } as unknown as BrowserActionBridge
}

function geminiSuccessFetch(payload: VideoAnalysisResult): typeof fetch {
  return vi.fn(async () => {
    const responseBody = JSON.stringify(payload)
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: responseBody }] },
            finishReason: 'STOP',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
}

function ctx(bridge: BrowserActionBridge, signal: AbortSignal): ProviderContext {
  return { bridge, signal }
}

const FIXTURE: VideoAnalysisResult = {
  visualDescription: 'Golden hour, slow handheld push-in toward person at high-rise window.',
  mood: 'contemplative',
  lighting: 'golden hour',
  colorPalette: ['amber', 'navy', 'cream'],
  cameraMovement: 'handheld push-in',
  subject: 'person at window',
  audioSummary: 'ambient piano, muted city traffic',
  pace: 'slow contemplative',
  suggestedBrollPrompts: [
    'Slow drift across an empty café in golden hour, muted earth tones',
    'Handheld push-in on rain-streaked window, soft piano underscore',
    'Cinematic close-up of steam rising from coffee in warm afternoon light',
  ],
}

describe('GeminiVideoAnalysisProvider', () => {
  it('reports unavailable without an API key', () => {
    const provider = new GeminiVideoAnalysisProvider({ apiKey: undefined })
    expect(provider.isAvailable()).toBe(false)
  })

  it('reports available when an API key is provided', () => {
    const provider = new GeminiVideoAnalysisProvider({ apiKey: 'k' })
    expect(provider.isAvailable()).toBe(true)
  })

  it('round-trips an analysis via the generate endpoint with inline video bytes', async () => {
    const bridge = bridgeWithClip({
      bytes: 'AAAA',
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      durationSec: 8.5,
    })
    const fetchImpl = geminiSuccessFetch(FIXTURE)
    const provider = new GeminiVideoAnalysisProvider({
      apiKey: 'test-key',
      fetchImpl,
      generateUrlTemplate: 'https://example.test/{model}:generateContent',
    })

    const result = await provider.analyze(
      { clipId: 'item:abc', focus: 'all' },
      ctx(bridge, new AbortController().signal),
    )

    expect(result.visualDescription).toBe(FIXTURE.visualDescription)
    expect(result.suggestedBrollPrompts).toHaveLength(3)
    expect(result.colorPalette).toEqual(['amber', 'navy', 'cream'])

    // Bridge was asked for the bytes only.
    expect(bridge.invokeBrowserAction).toHaveBeenCalledWith(
      'read-clip-video-bytes',
      expect.objectContaining({ clipId: 'item:abc' }),
      expect.any(AbortSignal),
    )

    // URL includes the default model id.
    const url = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(url).toContain('gemini-3.5-flash')
  })

  it('forwards start/end seconds through the bridge args', async () => {
    const bridge = bridgeWithClip({
      bytes: 'AAAA',
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      durationSec: 30,
    })
    const fetchImpl = geminiSuccessFetch(FIXTURE)
    const provider = new GeminiVideoAnalysisProvider({
      apiKey: 'test-key',
      fetchImpl,
      generateUrlTemplate: 'https://example.test/{model}:generateContent',
    })

    await provider.analyze(
      { clipId: 'item:abc', focus: 'visual', startSeconds: 4, endSeconds: 9 },
      ctx(bridge, new AbortController().signal),
    )

    expect(bridge.invokeBrowserAction).toHaveBeenCalledWith(
      'read-clip-video-bytes',
      expect.objectContaining({ clipId: 'item:abc', startSeconds: 4, endSeconds: 9 }),
      expect.any(AbortSignal),
    )

    // The prompt text part should reference the focus window so Gemini scopes
    // its description correctly.
    const fetchCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = JSON.parse(fetchCall?.[1]?.body as string) as {
      contents: Array<{ parts: Array<{ text?: string }> }>
    }
    const promptText = body.contents[0]?.parts?.find((p) => typeof p.text === 'string')?.text ?? ''
    expect(promptText).toMatch(/4\.00s and 9\.00s/)
  })

  it('throws a clear error when Gemini returns an error response', async () => {
    const bridge = bridgeWithClip({
      bytes: 'AAAA',
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      durationSec: 5,
    })
    const fetchImpl = vi.fn(
      async () => new Response('quota exceeded', { status: 429 }),
    ) as unknown as typeof fetch

    const provider = new GeminiVideoAnalysisProvider({
      apiKey: 'k',
      fetchImpl,
      generateUrlTemplate: 'https://example.test/{model}:generateContent',
    })

    await expect(
      provider.analyze({ clipId: 'item:abc' }, ctx(bridge, new AbortController().signal)),
    ).rejects.toThrow(/Gemini video analysis failed: 429/)
  })

  it('throws when Gemini blocks the request', async () => {
    const bridge = bridgeWithClip({
      bytes: 'AAAA',
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      durationSec: 5,
    })
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch

    const provider = new GeminiVideoAnalysisProvider({
      apiKey: 'k',
      fetchImpl,
      generateUrlTemplate: 'https://example.test/{model}:generateContent',
    })

    await expect(
      provider.analyze({ clipId: 'item:abc' }, ctx(bridge, new AbortController().signal)),
    ).rejects.toThrow(/blocked the analysis request: SAFETY/)
  })

  it('throws when Gemini returns invalid JSON', async () => {
    const bridge = bridgeWithClip({
      bytes: 'AAAA',
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      durationSec: 5,
    })
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'not-json' }] }, finishReason: 'STOP' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch

    const provider = new GeminiVideoAnalysisProvider({
      apiKey: 'k',
      fetchImpl,
      generateUrlTemplate: 'https://example.test/{model}:generateContent',
    })

    await expect(
      provider.analyze({ clipId: 'item:abc' }, ctx(bridge, new AbortController().signal)),
    ).rejects.toThrow(/not valid JSON/)
  })

  it('throws without an API key', async () => {
    const provider = new GeminiVideoAnalysisProvider({ apiKey: undefined })
    await expect(
      provider.analyze(
        { clipId: 'item:abc' },
        ctx(
          bridgeWithClip({ bytes: '', filename: '', mimeType: '', durationSec: 0 }),
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow(/GEMINI_API_KEY/)
  })

  describe('File API upload path (clip > inline threshold)', () => {
    function makeLargePayload(): {
      bytes: string
      filename: string
      mimeType: string
      durationSec: number
    } {
      // ~24MB raw → ~32MB base64. Above the 18MB inline threshold.
      const rawBytes = 24 * 1024 * 1024
      // Pad with valid base64 chars; the actual bytes don't matter for the test.
      const bytes = 'A'.repeat(Math.ceil((rawBytes * 4) / 3))
      return { bytes, filename: 'big.mp4', mimeType: 'video/mp4', durationSec: 30 }
    }

    function makeFileApiFetch(args: {
      uploadResponse: { file: { name: string; uri: string; mimeType?: string; state: string } }
      pollResponses: ReadonlyArray<{ state: string; uri: string; name: string; mimeType?: string }>
      analysisResponse: VideoAnalysisResult
    }): typeof fetch {
      const calls: Array<{ url: string; init: RequestInit | undefined }> = []
      let pollIndex = 0
      const impl = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/upload/v1beta/files')) {
          return new Response(JSON.stringify(args.uploadResponse), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        if (url.includes('/v1beta/files/')) {
          const next = args.pollResponses[Math.min(pollIndex, args.pollResponses.length - 1)]
          if (!next) throw new Error('test setup: no poll response available')
          pollIndex++
          return new Response(JSON.stringify(next), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        if (url.includes(':generateContent')) {
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: { parts: [{ text: JSON.stringify(args.analysisResponse) }] },
                  finishReason: 'STOP',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        throw new Error(`unexpected url: ${url}`)
      }) as unknown as typeof fetch
      ;(impl as unknown as { __calls: typeof calls }).__calls = calls
      return impl
    }

    it('uploads to File API, polls until ACTIVE, then calls generateContent with file_data part', async () => {
      const payload = makeLargePayload()
      const bridge = bridgeWithClip(payload)
      const fetchImpl = makeFileApiFetch({
        uploadResponse: {
          file: {
            name: 'files/abc123',
            uri: 'https://gen.googleapis.com/v1beta/files/abc123',
            mimeType: 'video/mp4',
            state: 'PROCESSING',
          },
        },
        pollResponses: [
          {
            name: 'files/abc123',
            uri: 'https://gen.googleapis.com/v1beta/files/abc123',
            state: 'PROCESSING',
          },
          {
            name: 'files/abc123',
            uri: 'https://gen.googleapis.com/v1beta/files/abc123',
            state: 'ACTIVE',
            mimeType: 'video/mp4',
          },
        ],
        analysisResponse: FIXTURE,
      })

      const provider = new GeminiVideoAnalysisProvider({
        apiKey: 'k',
        fetchImpl,
        generateUrlTemplate: 'https://gen.googleapis.com/v1beta/models/{model}:generateContent',
        filesUploadUrl: 'https://gen.googleapis.com/upload/v1beta/files?uploadType=media',
        filesGetUrlTemplate: 'https://gen.googleapis.com/v1beta/{name}',
        pollIntervalMs: 0,
        pollMaxAttempts: 5,
      })

      const result = await provider.analyze(
        { clipId: 'item:big' },
        ctx(bridge, new AbortController().signal),
      )

      expect(result.visualDescription).toBe(FIXTURE.visualDescription)

      const calls = (
        fetchImpl as unknown as { __calls: Array<{ url: string; init?: RequestInit }> }
      ).__calls
      // upload, poll1, poll2, generateContent
      expect(calls.length).toBeGreaterThanOrEqual(4)
      const uploadCall = calls.find((c) => c.url.includes('/upload/v1beta/files'))
      expect(uploadCall).toBeDefined()
      const generateCall = calls.find((c) => c.url.includes(':generateContent'))
      expect(generateCall).toBeDefined()
      const generateBody = JSON.parse(generateCall?.init?.body as string)
      const parts = generateBody.contents[0].parts as Array<Record<string, unknown>>
      // file_data part must be present; inline_data must NOT.
      expect(parts.some((p) => p.fileData)).toBe(true)
      expect(parts.some((p) => p.inlineData)).toBe(false)
      // file uri threaded through correctly
      const fileDataPart = parts.find((p) => p.fileData) as {
        fileData: { fileUri: string; mimeType: string }
      }
      expect(fileDataPart.fileData.fileUri).toContain('files/abc123')
    })

    it('skips polling when the upload returns state=ACTIVE directly', async () => {
      const payload = makeLargePayload()
      const bridge = bridgeWithClip(payload)
      const fetchImpl = makeFileApiFetch({
        uploadResponse: {
          file: {
            name: 'files/active',
            uri: 'https://gen.googleapis.com/v1beta/files/active',
            mimeType: 'video/mp4',
            state: 'ACTIVE',
          },
        },
        pollResponses: [],
        analysisResponse: FIXTURE,
      })

      const provider = new GeminiVideoAnalysisProvider({
        apiKey: 'k',
        fetchImpl,
        generateUrlTemplate: 'https://gen.googleapis.com/v1beta/models/{model}:generateContent',
        filesUploadUrl: 'https://gen.googleapis.com/upload/v1beta/files?uploadType=media',
        filesGetUrlTemplate: 'https://gen.googleapis.com/v1beta/{name}',
        pollIntervalMs: 0,
        pollMaxAttempts: 5,
      })

      await provider.analyze({ clipId: 'item:big' }, ctx(bridge, new AbortController().signal))

      const calls = (fetchImpl as unknown as { __calls: Array<{ url: string }> }).__calls
      // No poll calls — upload was ACTIVE on first response.
      const pollCalls = calls.filter(
        (c) => c.url.includes('/v1beta/files/') && !c.url.includes('/upload/'),
      )
      expect(pollCalls).toHaveLength(0)
    })

    it('throws when the File API reports FAILED state during upload', async () => {
      const payload = makeLargePayload()
      const bridge = bridgeWithClip(payload)
      const fetchImpl = makeFileApiFetch({
        uploadResponse: {
          file: {
            name: 'files/failed',
            uri: 'https://gen.googleapis.com/v1beta/files/failed',
            mimeType: 'video/mp4',
            state: 'FAILED',
          },
        },
        pollResponses: [],
        analysisResponse: FIXTURE,
      })

      const provider = new GeminiVideoAnalysisProvider({
        apiKey: 'k',
        fetchImpl,
        generateUrlTemplate: 'https://gen.googleapis.com/v1beta/models/{model}:generateContent',
        filesUploadUrl: 'https://gen.googleapis.com/upload/v1beta/files?uploadType=media',
        filesGetUrlTemplate: 'https://gen.googleapis.com/v1beta/{name}',
        pollIntervalMs: 0,
        pollMaxAttempts: 5,
      })

      await expect(
        provider.analyze({ clipId: 'item:big' }, ctx(bridge, new AbortController().signal)),
      ).rejects.toThrow(/state=FAILED/)
    })

    it('throws when polling exhausts attempts without ACTIVE state', async () => {
      const payload = makeLargePayload()
      const bridge = bridgeWithClip(payload)
      const fetchImpl = makeFileApiFetch({
        uploadResponse: {
          file: {
            name: 'files/stuck',
            uri: 'https://gen.googleapis.com/v1beta/files/stuck',
            mimeType: 'video/mp4',
            state: 'PROCESSING',
          },
        },
        pollResponses: [
          {
            name: 'files/stuck',
            uri: 'https://gen.googleapis.com/v1beta/files/stuck',
            state: 'PROCESSING',
          },
          {
            name: 'files/stuck',
            uri: 'https://gen.googleapis.com/v1beta/files/stuck',
            state: 'PROCESSING',
          },
        ],
        analysisResponse: FIXTURE,
      })

      const provider = new GeminiVideoAnalysisProvider({
        apiKey: 'k',
        fetchImpl,
        generateUrlTemplate: 'https://gen.googleapis.com/v1beta/models/{model}:generateContent',
        filesUploadUrl: 'https://gen.googleapis.com/upload/v1beta/files?uploadType=media',
        filesGetUrlTemplate: 'https://gen.googleapis.com/v1beta/{name}',
        pollIntervalMs: 0,
        pollMaxAttempts: 2,
      })

      await expect(
        provider.analyze({ clipId: 'item:big' }, ctx(bridge, new AbortController().signal)),
      ).rejects.toThrow(/did not reach ACTIVE state/)
    })

    it('throws with the API status when File API upload returns an error', async () => {
      const payload = makeLargePayload()
      const bridge = bridgeWithClip(payload)
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes('/upload/v1beta/files')) {
          return new Response('quota exceeded', { status: 429 })
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch

      const provider = new GeminiVideoAnalysisProvider({
        apiKey: 'k',
        fetchImpl,
        generateUrlTemplate: 'https://gen.googleapis.com/v1beta/models/{model}:generateContent',
        filesUploadUrl: 'https://gen.googleapis.com/upload/v1beta/files?uploadType=media',
        filesGetUrlTemplate: 'https://gen.googleapis.com/v1beta/{name}',
        pollIntervalMs: 0,
        pollMaxAttempts: 5,
      })

      await expect(
        provider.analyze({ clipId: 'item:big' }, ctx(bridge, new AbortController().signal)),
      ).rejects.toThrow(/Gemini File API upload failed: 429/)
    })
  })
})
