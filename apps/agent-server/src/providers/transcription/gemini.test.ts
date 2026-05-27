import { describe, expect, it, vi } from 'vitest'
import type { BrowserActionBridge, ProviderContext } from '../types.ts'
import { GeminiTranscriptionProvider } from './gemini.ts'

function bridgeWith(audio: { bytes: string; filename: string; mimeType: string }) {
  return {
    invokeBrowserAction: vi.fn(async (action: string) =>
      action === 'read-transcribable-audio' ? audio : undefined,
    ),
  } as unknown as BrowserActionBridge
}

function geminiSuccessFetch(payload: {
  text: string
  segments: Array<{ start: number; end: number; text: string }>
  language?: string
  durationSec?: number
}): typeof fetch {
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

describe('GeminiTranscriptionProvider', () => {
  it('reports unavailable without an API key', () => {
    const provider = new GeminiTranscriptionProvider({ apiKey: undefined })
    expect(provider.isAvailable()).toBe(false)
  })

  it('reports available when an API key is provided', () => {
    const provider = new GeminiTranscriptionProvider({ apiKey: 'k' })
    expect(provider.isAvailable()).toBe(true)
  })

  it('round-trips an inline transcript via the generate endpoint + saves to browser', async () => {
    const bridge = bridgeWith({ bytes: 'aGVsbG8=', filename: 'a.wav', mimeType: 'audio/wav' })
    const fetchImpl = geminiSuccessFetch({
      text: 'hello world',
      language: 'en',
      durationSec: 1.2,
      segments: [
        { start: 0, end: 0.6, text: 'hello ' },
        { start: 0.6, end: 1.2, text: ' world' },
      ],
    })
    const provider = new GeminiTranscriptionProvider({
      apiKey: 'test-key',
      fetchImpl,
      generateUrlTemplate: 'https://example.test/{model}:generateContent',
    })

    const result = await provider.transcribe(
      { assetId: 'media-x', language: 'en' },
      ctx(bridge, new AbortController().signal),
    )

    expect(result.text).toBe('hello world')
    expect(result.language).toBe('en')
    expect(result.segments).toHaveLength(2)
    expect(result.segments[0]?.text).toBe('hello')

    // Verify the bridge was asked for both the audio and the save.
    expect(bridge.invokeBrowserAction).toHaveBeenCalledWith(
      'read-transcribable-audio',
      expect.objectContaining({ mediaId: 'media-x' }),
      expect.any(AbortSignal),
    )
    expect(bridge.invokeBrowserAction).toHaveBeenCalledWith(
      'save-transcript',
      expect.objectContaining({ providerId: 'gemini-flash' }),
      expect.any(AbortSignal),
    )

    // Verify the URL includes the model id.
    const url = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(url).toContain('gemini-3.5-flash')
  })

  it('throws a clear error when Gemini returns an error response', async () => {
    const bridge = bridgeWith({ bytes: 'aGVsbG8=', filename: 'a.wav', mimeType: 'audio/wav' })
    const fetchImpl = vi.fn(
      async () => new Response('quota exceeded', { status: 429 }),
    ) as unknown as typeof fetch

    const provider = new GeminiTranscriptionProvider({
      apiKey: 'k',
      fetchImpl,
      generateUrlTemplate: 'https://example.test/{model}:generateContent',
    })

    await expect(
      provider.transcribe({ assetId: 'media-x' }, ctx(bridge, new AbortController().signal)),
    ).rejects.toThrow(/Gemini transcription failed: 429/)
  })

  it('throws when Gemini blocks the request', async () => {
    const bridge = bridgeWith({ bytes: 'aGVsbG8=', filename: 'a.wav', mimeType: 'audio/wav' })
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch

    const provider = new GeminiTranscriptionProvider({
      apiKey: 'k',
      fetchImpl,
      generateUrlTemplate: 'https://example.test/{model}:generateContent',
    })

    await expect(
      provider.transcribe({ assetId: 'media-x' }, ctx(bridge, new AbortController().signal)),
    ).rejects.toThrow(/blocked the request: SAFETY/)
  })

  it('throws without an API key', async () => {
    const provider = new GeminiTranscriptionProvider({ apiKey: undefined })
    await expect(
      provider.transcribe(
        { assetId: 'media-x' },
        ctx(bridgeWith({ bytes: '', filename: '', mimeType: '' }), new AbortController().signal),
      ),
    ).rejects.toThrow(/GEMINI_API_KEY/)
  })
})
