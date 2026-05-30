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

  it('requests word timestamps and distributes them into the right segments', async () => {
    const audio = {
      bytes: Buffer.from('x').toString('base64'),
      filename: 'm.wav',
      mimeType: 'audio/wav',
    }
    const openaiResponse = {
      text: 'hello world now',
      language: 'en',
      duration: 3,
      segments: [
        { start: 0, end: 1.5, text: 'hello world' },
        { start: 1.5, end: 3, text: 'now' },
      ],
      words: [
        { word: 'hello', start: 0.0, end: 0.5 },
        { word: 'world', start: 0.6, end: 1.1 },
        { word: 'now', start: 1.6, end: 2.0 },
      ],
    }
    let savedTranscript: { segments?: ReadonlyArray<{ words?: unknown }> } | undefined
    const bridge: BrowserActionBridge = {
      invokeBrowserAction: vi.fn(async (action: string, args: unknown) => {
        if (action === 'read-transcribable-audio') return audio
        if (action === 'save-transcript') {
          savedTranscript = (args as { transcript: typeof savedTranscript }).transcript
          return undefined
        }
        throw new Error(`unexpected action: ${action}`)
      }) as BrowserActionBridge['invokeBrowserAction'],
    }
    const fetchImpl = makeFetch({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => openaiResponse,
    })
    const provider = new OpenAIWhisperProvider({ apiKey: 'sk-test', fetchImpl })
    const transcript = await provider.transcribe(
      { assetId: 'm1' },
      { bridge, signal: new AbortController().signal },
    )

    // Words land in the segment whose time range contains their start.
    expect(transcript.segments[0]?.words).toEqual([
      { text: 'hello', start: 0, end: 0.5 },
      { text: 'world', start: 0.6, end: 1.1 },
    ])
    expect(transcript.segments[1]?.words).toEqual([{ text: 'now', start: 1.6, end: 2.0 }])

    // The request asked OpenAI for word-level timestamps.
    const form = ((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1]
      .body as FormData
    expect(form.getAll('timestamp_granularities[]')).toContain('word')

    // And the words flow through to the persisted transcript.
    expect(savedTranscript?.segments?.[0]?.words).toEqual([
      { text: 'hello', start: 0, end: 0.5 },
      { text: 'world', start: 0.6, end: 1.1 },
    ])
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
