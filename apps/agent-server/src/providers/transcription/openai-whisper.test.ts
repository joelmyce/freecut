import { describe, expect, it, vi } from 'vitest'
import { OpenAIWhisperProvider } from './openai-whisper.ts'
import type { BrowserActionBridge, ProviderContext } from '../types.ts'

interface MockResponse {
  ok: boolean
  status: number
  statusText: string
  json?: () => Promise<unknown>
  text?: () => Promise<string>
}

function makeFetch(response: MockResponse): typeof fetch {
  return vi.fn(async () => response) as unknown as typeof fetch
}

describe('OpenAIWhisperProvider', () => {
  describe('isAvailable', () => {
    it('returns false when no API key is set', () => {
      expect(new OpenAIWhisperProvider({ apiKey: undefined }).isAvailable()).toBe(false)
      expect(new OpenAIWhisperProvider({ apiKey: '' }).isAvailable()).toBe(false)
      expect(new OpenAIWhisperProvider({ apiKey: '   ' }).isAvailable()).toBe(false)
    })

    it('returns true when an API key is set', () => {
      expect(new OpenAIWhisperProvider({ apiKey: 'sk-test' }).isAvailable()).toBe(true)
    })
  })

  it('throws when transcribe is called without an API key', async () => {
    const provider = new OpenAIWhisperProvider({ apiKey: undefined })
    const bridge: BrowserActionBridge = { invokeBrowserAction: vi.fn() }
    await expect(
      provider.transcribe({ assetId: 'm1' }, { bridge, signal: new AbortController().signal }),
    ).rejects.toThrow(/OPENAI_API_KEY/)
  })

  it('fetches audio, POSTs to OpenAI, saves transcript, and returns it', async () => {
    const audio = {
      bytes: Buffer.from('fake-wav-bytes').toString('base64'),
      filename: 'm1.wav',
      mimeType: 'audio/wav',
    }
    const openaiResponse = {
      text: 'hello world',
      language: 'en',
      duration: 1.5,
      segments: [{ start: 0, end: 1.5, text: '  hello world  ' }],
    }
    const bridge: BrowserActionBridge = {
      invokeBrowserAction: vi.fn(async (action: string) => {
        if (action === 'read-transcribable-audio') return audio
        if (action === 'save-transcript') return undefined
        throw new Error(`unexpected action: ${action}`)
      }) as BrowserActionBridge['invokeBrowserAction'],
    }
    const fetchImpl = makeFetch({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => openaiResponse,
    })
    const onProgress = vi.fn()
    const ctx: ProviderContext = {
      bridge,
      signal: new AbortController().signal,
      onProgress,
    }

    const provider = new OpenAIWhisperProvider({ apiKey: 'sk-test', fetchImpl })
    const transcript = await provider.transcribe({ assetId: 'm1', language: 'en' }, ctx)

    expect(transcript).toEqual({
      text: 'hello world',
      language: 'en',
      durationSec: 1.5,
      segments: [{ text: 'hello world', start: 0, end: 1.5 }],
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls
    const firstCall = calls[0]
    expect(firstCall).toBeDefined()
    const [url, init] = firstCall as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    expect(init.signal).toBe(ctx.signal)

    expect(bridge.invokeBrowserAction).toHaveBeenCalledTimes(2)
    expect(bridge.invokeBrowserAction).toHaveBeenNthCalledWith(
      1,
      'read-transcribable-audio',
      { mediaId: 'm1' },
      ctx.signal,
    )
    expect(bridge.invokeBrowserAction).toHaveBeenNthCalledWith(
      2,
      'save-transcript',
      expect.objectContaining({
        mediaId: 'm1',
        providerId: 'openai-whisper',
      }),
      ctx.signal,
    )

    const stages = onProgress.mock.calls.map(([event]) => event.stage)
    expect(stages).toEqual(['fetching-audio', 'uploading', 'transcribing', 'saving'])
  })

  it('throws when OpenAI returns a non-ok response', async () => {
    const bridge: BrowserActionBridge = {
      invokeBrowserAction: vi.fn(async () => ({
        bytes: '',
        filename: 'x.wav',
        mimeType: 'audio/wav',
      })) as BrowserActionBridge['invokeBrowserAction'],
    }
    const fetchImpl = makeFetch({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'invalid api key',
    })
    const provider = new OpenAIWhisperProvider({ apiKey: 'sk-bad', fetchImpl })

    await expect(
      provider.transcribe({ assetId: 'm1' }, { bridge, signal: new AbortController().signal }),
    ).rejects.toThrow(/401|Unauthorized|invalid api key/)
  })

  it('uses the configured model when input.model is not set', async () => {
    const audio = {
      bytes: '',
      filename: 'x.wav',
      mimeType: 'audio/wav',
    }
    const bridge: BrowserActionBridge = {
      invokeBrowserAction: vi.fn(async (action: string) =>
        action === 'read-transcribable-audio' ? audio : undefined,
      ) as BrowserActionBridge['invokeBrowserAction'],
    }
    const fetchImpl = makeFetch({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ text: '', duration: 0, segments: [] }),
    })
    const provider = new OpenAIWhisperProvider({
      apiKey: 'sk-test',
      model: 'whisper-large-v3',
      fetchImpl,
    })

    await provider.transcribe({ assetId: 'm1' }, { bridge, signal: new AbortController().signal })

    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls
    const firstCall = calls[0]
    expect(firstCall).toBeDefined()
    const form = (firstCall as [string, RequestInit])[1].body as FormData
    expect(form.get('model')).toBe('whisper-large-v3')
  })
})
