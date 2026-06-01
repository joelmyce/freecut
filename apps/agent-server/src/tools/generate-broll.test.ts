import { describe, expect, it, vi } from 'vitest'
import { createGenerateBrollTool } from './generate-broll.ts'
import type {
  BrowserActionBridge,
  ConfirmationDecision,
  ProvidersBundle,
} from '../providers/index.ts'
import type { ConfirmationCard } from '../bridge/protocol.ts'
import type { VideoGenerationProvider } from '../providers/video/index.ts'

function mockProvider(
  available: boolean,
  generateImpl?: VideoGenerationProvider['generate'],
): VideoGenerationProvider {
  return {
    id: 'fal',
    isAvailable: () => available,
    generate:
      generateImpl ??
      (async () => ({
        sourceUrl: 'https://fal.media/abc.mp4',
        modelUsed: 'fal-ai/luma-dream-machine',
        durationSec: 5,
        cost: { amount: 0.4, currency: 'USD' as const },
      })),
  }
}

function recordingBridge() {
  const calls: Array<{ action: string; args: unknown }> = []
  const responses = new Map<string, unknown>([
    [
      'insert-generation-placeholder',
      { placeholderId: 'ph-1', trackId: 'track-new', from: 360, durationInFrames: 180 },
    ],
    [
      'swap-generation-placeholder-with-url',
      {
        clipId: 'clip-1',
        mediaId: 'media-1',
        trackId: 'track-new',
        from: 360,
        durationInFrames: 150,
      },
    ],
    ['remove-generation-placeholder', {}],
    ['mark-generation-placeholder-error', {}],
    // §6.5.1 transcript grounding lookup. Default to "no transcript" so
    // existing tests assert the plain-prompt path; specific tests override.
    [
      'read-transcript-context-for-range',
      { text: null, sourceMediaIds: [], startSeconds: 0, endSeconds: 0 },
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

/** Wraps recordingBridge with a fixed-decision M5.2 spend gate; records cards. */
function confirmingBridge(decision: ConfirmationDecision) {
  const base = recordingBridge()
  const cards: ConfirmationCard[] = []
  const bridge: BrowserActionBridge = {
    invokeBrowserAction: base.bridge.invokeBrowserAction,
    requestConfirmation: async (card: ConfirmationCard) => {
      cards.push(card)
      return decision
    },
  }
  return { bridge, calls: base.calls, cards }
}

function providersWith(provider: VideoGenerationProvider): ProvidersBundle {
  return {
    transcription: [],
    videoGeneration: [provider],
    analysis: [],
    imageGeneration: [],
    gifSearch: [],
    tts: [],
  }
}

async function callTool(toolDef: ReturnType<typeof createGenerateBrollTool>, args: unknown) {
  return await toolDef.handler(args as Parameters<typeof toolDef.handler>[0], undefined)
}

describe('createGenerateBrollTool', () => {
  it('happy path: insert placeholder → generate → swap, returns final result', async () => {
    const provider = mockProvider(true)
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [provider],
      analysis: [],
      imageGeneration: [],
      gifSearch: [],
      tts: [],
    }
    const { bridge, calls } = recordingBridge()
    const generateSpy = vi.spyOn(provider, 'generate')

    const toolDef = createGenerateBrollTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })

    const result = await callTool(toolDef, {
      prompt: 'city skyline',
      start_seconds: 12,
      end_seconds: 18,
    })
    const text = (result.content[0] as { type: 'text'; text: string }).text
    const parsed = JSON.parse(text)

    expect(parsed).toMatchObject({
      clipId: 'clip-1',
      mediaId: 'media-1',
      providerUsed: 'fal',
      modelUsed: 'fal-ai/luma-dream-machine',
    })
    expect(parsed.cost).toMatchObject({ amount: 0.4, currency: 'USD' })

    expect(calls.map((c) => c.action)).toEqual([
      'read-transcript-context-for-range',
      'insert-generation-placeholder',
      'swap-generation-placeholder-with-url',
    ])
    const insertCall = calls.find((c) => c.action === 'insert-generation-placeholder')
    expect(insertCall?.args).toMatchObject({
      startSeconds: 12,
      endSeconds: 18,
      prompt: 'city skyline',
      providerId: 'fal',
    })
    expect(generateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'city skyline', targetDurationSec: 6, aspect: '16:9' }),
      expect.objectContaining({ bridge, signal: expect.any(AbortSignal) }),
    )
  })

  it('throws if end_seconds <= start_seconds', async () => {
    const provider = mockProvider(true)
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [provider],
      analysis: [],
      imageGeneration: [],
      gifSearch: [],
      tts: [],
    }
    const { bridge } = recordingBridge()
    const toolDef = createGenerateBrollTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    await expect(
      callTool(toolDef, { prompt: 'x', start_seconds: 10, end_seconds: 10 }),
    ).rejects.toThrow(/end_seconds must be greater/)
  })

  it('passes aspect override into the provider', async () => {
    const provider = mockProvider(true)
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [provider],
      analysis: [],
      imageGeneration: [],
      gifSearch: [],
      tts: [],
    }
    const { bridge } = recordingBridge()
    const generateSpy = vi.spyOn(provider, 'generate')

    const toolDef = createGenerateBrollTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    await callTool(toolDef, { prompt: 'p', start_seconds: 0, end_seconds: 5, aspect: '9:16' })
    expect(generateSpy.mock.calls[0]?.[0].aspect).toBe('9:16')
  })

  it('on provider failure: marks placeholder error and rethrows', async () => {
    const provider = mockProvider(true, async () => {
      throw new Error('fal job failed')
    })
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [provider],
      analysis: [],
      imageGeneration: [],
      gifSearch: [],
      tts: [],
    }
    const { bridge, calls } = recordingBridge()

    const toolDef = createGenerateBrollTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    await expect(
      callTool(toolDef, { prompt: 'x', start_seconds: 0, end_seconds: 5 }),
    ).rejects.toThrow(/fal job failed/)
    const actions = calls.map((c) => c.action)
    expect(actions).toContain('insert-generation-placeholder')
    expect(actions).toContain('mark-generation-placeholder-error')
    expect(actions).not.toContain('swap-generation-placeholder-with-url')
  })

  it('on abort: removes placeholder and rethrows', async () => {
    const controller = new AbortController()
    const provider = mockProvider(true, async (_input, ctx) => {
      // Abort while the provider is "running".
      controller.abort()
      ctx.signal.throwIfAborted()
      return { sourceUrl: '', modelUsed: '', durationSec: 0 }
    })
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [provider],
      analysis: [],
      imageGeneration: [],
      gifSearch: [],
      tts: [],
    }
    const { bridge, calls } = recordingBridge()

    const toolDef = createGenerateBrollTool({
      bridge,
      providers,
      abortSignal: controller.signal,
    })
    await expect(
      callTool(toolDef, { prompt: 'x', start_seconds: 0, end_seconds: 5 }),
    ).rejects.toThrow()
    const actions = calls.map((c) => c.action)
    expect(actions).toContain('remove-generation-placeholder')
    expect(actions).not.toContain('swap-generation-placeholder-with-url')
    expect(actions).not.toContain('mark-generation-placeholder-error')
  })

  it('§6.5.1: prepends transcript VIDEO CONTEXT to the model prompt when the browser returns one', async () => {
    const provider = mockProvider(true)
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [provider],
      analysis: [],
      imageGeneration: [],
      gifSearch: [],
      tts: [],
    }
    const { bridge } = recordingBridge()
    const generateSpy = vi.spyOn(provider, 'generate')

    // Override the default no-transcript response with real text.
    const ctxResponse = {
      text: 'we ship every Friday and recap on Monday',
      sourceMediaIds: ['m1'],
      startSeconds: 12,
      endSeconds: 18,
    }
    const wrappedBridge = {
      invokeBrowserAction: async <T = unknown>(
        action: string,
        args: unknown,
        signal: AbortSignal,
      ): Promise<T> => {
        if (action === 'read-transcript-context-for-range') return ctxResponse as T
        return bridge.invokeBrowserAction<T>(action, args, signal)
      },
    }

    const toolDef = createGenerateBrollTool({
      bridge: wrappedBridge,
      providers,
      abortSignal: new AbortController().signal,
    })

    const result = await callTool(toolDef, {
      prompt: 'desk in a startup office',
      start_seconds: 12,
      end_seconds: 18,
    })
    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.usedTranscriptContext).toBe(true)

    const generatedPrompt = generateSpy.mock.calls[0]?.[0].prompt as string
    expect(generatedPrompt).toContain('VIDEO CONTEXT')
    expect(generatedPrompt).toContain('we ship every Friday and recap on Monday')
    expect(generatedPrompt).toContain('desk in a startup office')
    // The user's prompt must appear after the context block, not in front of it.
    expect(generatedPrompt.indexOf('VIDEO CONTEXT')).toBeLessThan(
      generatedPrompt.indexOf('desk in a startup office'),
    )
  })

  it('M5.2 gate: approve shows a labeled cost card, then runs the full generation', async () => {
    const provider = mockProvider(true)
    const { bridge, calls, cards } = confirmingBridge({ decision: 'approve' })
    const generateSpy = vi.spyOn(provider, 'generate')
    const toolDef = createGenerateBrollTool({
      bridge,
      providers: providersWith(provider),
      abortSignal: new AbortController().signal,
    })
    await callTool(toolDef, { prompt: 'city skyline', start_seconds: 12, end_seconds: 18 })
    expect(cards).toHaveLength(1)
    expect(cards[0]?.summary).toBe('city skyline')
    expect(cards[0]?.costEstimate?.isEstimate).toBe(true)
    expect(calls.map((c) => c.action)).toContain('insert-generation-placeholder')
    expect(generateSpy).toHaveBeenCalledTimes(1)
  })

  it('M5.2 gate: reject returns status:"declined" and makes NO mutation (not even the read)', async () => {
    const provider = mockProvider(true)
    const { bridge, calls, cards } = confirmingBridge({ decision: 'reject' })
    const generateSpy = vi.spyOn(provider, 'generate')
    const toolDef = createGenerateBrollTool({
      bridge,
      providers: providersWith(provider),
      abortSignal: new AbortController().signal,
    })
    const result = await callTool(toolDef, { prompt: 'x', start_seconds: 0, end_seconds: 5 })
    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.status).toBe('declined')
    expect(cards).toHaveLength(1)
    expect(generateSpy).not.toHaveBeenCalled()
    // The gate runs before any bridge call — declining touches nothing.
    expect(calls).toHaveLength(0)
  })

  it('M5.2 gate: edit applies the prompt override to the render + placeholder', async () => {
    const provider = mockProvider(true)
    const { bridge, calls } = confirmingBridge({
      decision: 'edit',
      edits: { prompt: 'neon alley at night' },
    })
    const generateSpy = vi.spyOn(provider, 'generate')
    const toolDef = createGenerateBrollTool({
      bridge,
      providers: providersWith(provider),
      abortSignal: new AbortController().signal,
    })
    await callTool(toolDef, { prompt: 'original prompt', start_seconds: 0, end_seconds: 5 })
    expect(generateSpy.mock.calls[0]?.[0].prompt).toBe('neon alley at night')
    const insert = calls.find((c) => c.action === 'insert-generation-placeholder')
    expect((insert?.args as { prompt: string }).prompt).toBe('neon alley at night')
  })

  it('throws when no video provider is available', async () => {
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [mockProvider(false)],
      analysis: [],
      imageGeneration: [],
      gifSearch: [],
      tts: [],
    }
    const { bridge } = recordingBridge()
    const toolDef = createGenerateBrollTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    await expect(
      callTool(toolDef, { prompt: 'x', start_seconds: 0, end_seconds: 5 }),
    ).rejects.toThrow(/No video generation provider/)
  })
})
