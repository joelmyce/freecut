import { describe, expect, it, vi } from 'vitest'
import { createGenerateVoiceoverTool } from './generate-voiceover.ts'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import type { TtsProvider, TtsResult } from '../providers/tts/index.ts'

function mockTtsProvider(
  id: TtsProvider['id'],
  available = true,
  result?: Partial<TtsResult>,
): TtsProvider {
  return {
    id,
    isAvailable: () => available,
    synthesize: async () =>
      ({
        audioBytesBase64: 'AAAA',
        mimeType: id === 'kokoro' ? 'audio/wav' : 'audio/mpeg',
        durationSec: 1.5,
        modelUsed: id === 'kokoro' ? 'fp32' : 'eleven_multilingual_v2',
        ...result,
      }) satisfies TtsResult,
  }
}

function recordingBridge() {
  const calls: Array<{ action: string; args: unknown }> = []
  const responses = new Map<string, unknown>([
    [
      'insert-voiceover',
      {
        clipId: 'audio-clip-1',
        mediaId: 'media-audio-1',
        trackId: 'track-vo-1',
        from: 60,
        durationInFrames: 45,
        durationSec: 1.5,
      },
    ],
  ])
  const bridge: BrowserActionBridge = {
    invokeBrowserAction: async <T = unknown>(
      action: string,
      args: unknown,
      _signal: AbortSignal,
    ): Promise<T> => {
      calls.push({ action, args })
      return (responses.get(action) ?? {}) as T
    },
  }
  return { bridge, calls }
}

function emptyProviders(tts: TtsProvider[]): ProvidersBundle {
  return {
    transcription: [],
    videoGeneration: [],
    analysis: [],
    imageGeneration: [],
    gifSearch: [],
    tts,
  }
}

async function callTool(toolDef: ReturnType<typeof createGenerateVoiceoverTool>, args: unknown) {
  return await toolDef.handler(args as Parameters<typeof toolDef.handler>[0], undefined)
}

describe('createGenerateVoiceoverTool', () => {
  it('happy path (auto): picks kokoro, synthesizes, inserts via the bridge', async () => {
    const kokoro = mockTtsProvider('kokoro', true)
    const synth = vi.spyOn(kokoro, 'synthesize')
    const { bridge, calls } = recordingBridge()

    const toolDef = createGenerateVoiceoverTool({
      bridge,
      providers: emptyProviders([kokoro]),
      abortSignal: new AbortController().signal,
    })
    const result = await callTool(toolDef, { text: 'Welcome to the show', insert_at_seconds: 2 })
    const parsed = JSON.parse((result.content[0] as { text: string }).text)

    expect(parsed).toMatchObject({
      clipId: 'audio-clip-1',
      mediaId: 'media-audio-1',
      trackId: 'track-vo-1',
      providerUsed: 'kokoro',
      modelUsed: 'fp32',
      voiceId: 'af_heart',
      routingReason: 'auto: defaulting to local kokoro',
    })

    // Synthesize was called with the user's text + kokoro default voice
    expect(synth).toHaveBeenCalledOnce()
    expect(synth.mock.calls[0]?.[0]).toMatchObject({
      text: 'Welcome to the show',
      voiceId: 'af_heart',
    })

    // Bridge insert-voiceover received the synthesized payload
    expect(calls.map((c) => c.action)).toEqual(['insert-voiceover'])
    const insertArgs = calls[0]?.args as Record<string, unknown>
    expect(insertArgs).toMatchObject({
      audioBytesBase64: 'AAAA',
      mimeType: 'audio/wav',
      durationSec: 1.5,
      text: 'Welcome to the show',
      voiceId: 'af_heart',
      providerId: 'kokoro',
      modelUsed: 'fp32',
      insertAtSeconds: 2,
    })
  })

  it('routes to elevenlabs when explicitly requested', async () => {
    const kokoro = mockTtsProvider('kokoro', true)
    const eleven = mockTtsProvider('elevenlabs', true)
    const synthEleven = vi.spyOn(eleven, 'synthesize')
    const { bridge } = recordingBridge()

    const toolDef = createGenerateVoiceoverTool({
      bridge,
      providers: emptyProviders([kokoro, eleven]),
      abortSignal: new AbortController().signal,
    })
    const result = await callTool(toolDef, {
      text: 'narration',
      provider: 'elevenlabs',
    })
    const parsed = JSON.parse((result.content[0] as { text: string }).text)

    expect(synthEleven).toHaveBeenCalledOnce()
    expect(parsed.providerUsed).toBe('elevenlabs')
    expect(parsed.voiceId).toBe('21m00Tcm4TlvDq8ikWAM')
    expect(parsed.routingReason).toMatch(/explicit/)
  })

  it('falls back to elevenlabs when kokoro is unavailable on auto', async () => {
    const kokoro = mockTtsProvider('kokoro', false)
    const eleven = mockTtsProvider('elevenlabs', true)
    const { bridge } = recordingBridge()

    const toolDef = createGenerateVoiceoverTool({
      bridge,
      providers: emptyProviders([kokoro, eleven]),
      abortSignal: new AbortController().signal,
    })
    const result = await callTool(toolDef, { text: 'fallback test' })
    const parsed = JSON.parse((result.content[0] as { text: string }).text)

    expect(parsed.providerUsed).toBe('elevenlabs')
    expect(parsed.routingReason).toMatch(/kokoro unavailable/)
  })

  it('honors an explicit voice_id when provided', async () => {
    const kokoro = mockTtsProvider('kokoro', true)
    const synth = vi.spyOn(kokoro, 'synthesize')
    const { bridge, calls } = recordingBridge()

    const toolDef = createGenerateVoiceoverTool({
      bridge,
      providers: emptyProviders([kokoro]),
      abortSignal: new AbortController().signal,
    })
    const result = await callTool(toolDef, { text: 'hi', voice_id: 'am_michael' })
    const parsed = JSON.parse((result.content[0] as { text: string }).text)

    const synthCall = synth.mock.calls[0]
    expect(synthCall).toBeDefined()
    expect(synthCall![0].voiceId).toBe('am_michael')
    expect(parsed.voiceId).toBe('am_michael')
    expect(calls[0]).toBeDefined()
    const insertArgs = calls[0]!.args as { voiceId: string }
    expect(insertArgs.voiceId).toBe('am_michael')
  })

  it('forwards speed + model to the provider', async () => {
    const kokoro = mockTtsProvider('kokoro', true)
    const synth = vi.spyOn(kokoro, 'synthesize')
    const { bridge } = recordingBridge()

    const toolDef = createGenerateVoiceoverTool({
      bridge,
      providers: emptyProviders([kokoro]),
      abortSignal: new AbortController().signal,
    })
    await callTool(toolDef, { text: 'hi', speed: 1.25, model: 'fp32' })

    expect(synth.mock.calls[0]?.[0]).toMatchObject({ speed: 1.25, model: 'fp32' })
  })

  it('rejects empty / whitespace text', async () => {
    const kokoro = mockTtsProvider('kokoro', true)
    const { bridge } = recordingBridge()
    const toolDef = createGenerateVoiceoverTool({
      bridge,
      providers: emptyProviders([kokoro]),
      abortSignal: new AbortController().signal,
    })
    // zod min(1) catches empty literal at parse time
    await expect(callTool(toolDef, { text: '' })).rejects.toThrow()
    // whitespace-only passes zod but the tool body trims and re-checks
    await expect(callTool(toolDef, { text: '   ' })).rejects.toThrow(/text must not be empty/)
  })

  it('throws clearly when no TTS provider is available', async () => {
    const { bridge } = recordingBridge()
    const toolDef = createGenerateVoiceoverTool({
      bridge,
      providers: emptyProviders([]),
      abortSignal: new AbortController().signal,
    })

    await expect(callTool(toolDef, { text: 'hi' })).rejects.toThrow(/No TTS provider is available/)
  })

  it('throws helpful error when explicit elevenlabs is unavailable', async () => {
    const kokoro = mockTtsProvider('kokoro', true)
    const eleven = mockTtsProvider('elevenlabs', false)
    const { bridge } = recordingBridge()

    const toolDef = createGenerateVoiceoverTool({
      bridge,
      providers: emptyProviders([kokoro, eleven]),
      abortSignal: new AbortController().signal,
    })
    await expect(callTool(toolDef, { text: 'hi', provider: 'elevenlabs' })).rejects.toThrow(
      /ELEVENLABS_API_KEY/,
    )
  })
})
