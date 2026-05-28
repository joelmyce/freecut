import { describe, expect, it, vi } from 'vitest'
import { ElevenLabsTtsProvider } from './elevenlabs.ts'
import type { ProviderContext } from '../types.ts'

function ctx(signal?: AbortSignal): ProviderContext {
  return {
    bridge: { invokeBrowserAction: async () => undefined },
    signal: signal ?? new AbortController().signal,
  } as unknown as ProviderContext
}

function audioResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes, {
    status,
    headers: { 'content-type': 'audio/mpeg' },
  })
}

describe('ElevenLabsTtsProvider', () => {
  it('reports unavailable without an API key', () => {
    expect(new ElevenLabsTtsProvider({ apiKey: undefined }).isAvailable()).toBe(false)
    expect(new ElevenLabsTtsProvider({ apiKey: '' }).isAvailable()).toBe(false)
    expect(new ElevenLabsTtsProvider({ apiKey: '   ' }).isAvailable()).toBe(false)
  })

  it('reports available when an API key is provided', () => {
    expect(new ElevenLabsTtsProvider({ apiKey: 'k' }).isAvailable()).toBe(true)
  })

  it('POSTs to /v1/text-to-speech/{voice_id} with xi-api-key header and JSON body', async () => {
    const bytes = new Uint8Array([0x49, 0x44, 0x33]) // "ID3" — start of an mp3 file
    const fetchImpl = vi.fn(async () => audioResponse(bytes)) as unknown as typeof fetch

    const provider = new ElevenLabsTtsProvider({
      apiKey: 'sk-test',
      fetchImpl,
      baseUrl: 'https://example.test/v1/text-to-speech',
    })

    const result = await provider.synthesize(
      { text: 'hello world', voiceId: 'voice-abc', model: 'eleven_turbo_v2_5' },
      ctx(),
    )

    expect(fetchImpl).toHaveBeenCalledOnce()
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call).toBeDefined()
    const url = call![0] as string
    const init = call![1] as RequestInit
    expect(url).toBe('https://example.test/v1/text-to-speech/voice-abc?output_format=mp3_44100_128')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('sk-test')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    const body = JSON.parse(init.body as string) as { text: string; model_id: string }
    expect(body).toEqual({ text: 'hello world', model_id: 'eleven_turbo_v2_5' })

    expect(result.mimeType).toBe('audio/mpeg')
    expect(result.modelUsed).toBe('eleven_turbo_v2_5')
    expect(result.durationSec).toBe(0) // ElevenLabs doesn't return inline duration
    // Base64 of 'ID3' bytes.
    expect(Buffer.from(result.audioBytesBase64, 'base64')).toEqual(Buffer.from(bytes))
  })

  it('uses defaults (eleven_multilingual_v2 + Rachel voice) when omitted', async () => {
    const fetchImpl = vi.fn(async () =>
      audioResponse(new Uint8Array([1, 2, 3])),
    ) as unknown as typeof fetch

    const provider = new ElevenLabsTtsProvider({
      apiKey: 'k',
      fetchImpl,
      baseUrl: 'https://example.test/v1/text-to-speech',
    })

    // Empty voiceId triggers the constructor-level default.
    const result = await provider.synthesize({ text: 'hi', voiceId: '' }, ctx())

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call).toBeDefined()
    const url = call![0] as string
    expect(url).toContain('/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM')
    const init = call![1] as RequestInit
    const body = JSON.parse(init.body as string) as { model_id: string }
    expect(body.model_id).toBe('eleven_multilingual_v2')
    expect(result.modelUsed).toBe('eleven_multilingual_v2')
  })

  it('URL-encodes the voice id and output format', async () => {
    const fetchImpl = vi.fn(async () =>
      audioResponse(new Uint8Array([0])),
    ) as unknown as typeof fetch
    const provider = new ElevenLabsTtsProvider({
      apiKey: 'k',
      fetchImpl,
      defaultOutputFormat: 'wav_48000',
      baseUrl: 'https://example.test/v1/text-to-speech',
    })

    await provider.synthesize({ text: 'hi', voiceId: 'weird id/with-slash' }, ctx())

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call).toBeDefined()
    const url = call![0] as string
    expect(url).toContain('weird%20id%2Fwith-slash')
    expect(url).toContain('output_format=wav_48000')
  })

  it('returns audio/wav mimeType when output format is wav', async () => {
    const fetchImpl = vi.fn(async () =>
      audioResponse(new Uint8Array([0])),
    ) as unknown as typeof fetch
    const provider = new ElevenLabsTtsProvider({
      apiKey: 'k',
      fetchImpl,
      defaultOutputFormat: 'wav_48000',
      baseUrl: 'https://example.test/v1/text-to-speech',
    })

    const result = await provider.synthesize({ text: 'hi', voiceId: 'v' }, ctx())
    expect(result.mimeType).toBe('audio/wav')
  })

  it('throws with the API status when ElevenLabs returns a non-2xx response', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('quota exceeded', { status: 429 }),
    ) as unknown as typeof fetch
    const provider = new ElevenLabsTtsProvider({
      apiKey: 'k',
      fetchImpl,
      baseUrl: 'https://example.test/v1/text-to-speech',
    })

    await expect(provider.synthesize({ text: 'hi', voiceId: 'v' }, ctx())).rejects.toThrow(
      /ElevenLabs synthesize failed: 429/,
    )
  })

  it('throws without an API key', async () => {
    const provider = new ElevenLabsTtsProvider({ apiKey: undefined })
    await expect(provider.synthesize({ text: 'hi', voiceId: 'v' }, ctx())).rejects.toThrow(
      /ELEVENLABS_API_KEY/,
    )
  })

  it('rejects empty text', async () => {
    const provider = new ElevenLabsTtsProvider({
      apiKey: 'k',
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })
    await expect(provider.synthesize({ text: '', voiceId: 'v' }, ctx())).rejects.toThrow(
      /non-empty text/,
    )
    await expect(provider.synthesize({ text: '   ', voiceId: 'v' }, ctx())).rejects.toThrow(
      /non-empty text/,
    )
  })
})
