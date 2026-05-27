import { describe, expect, it, vi } from 'vitest'
import { createGenerateBrollTool } from './generate-broll.ts'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
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

async function callTool(toolDef: ReturnType<typeof createGenerateBrollTool>, args: unknown) {
  return await toolDef.handler(args as Parameters<typeof toolDef.handler>[0], undefined)
}

describe('createGenerateBrollTool', () => {
  it('happy path: insert placeholder → generate → swap, returns final result', async () => {
    const provider = mockProvider(true)
    const providers: ProvidersBundle = { transcription: [], videoGeneration: [provider] }
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
      'insert-generation-placeholder',
      'swap-generation-placeholder-with-url',
    ])
    const insertArgs = calls[0]?.args as Record<string, unknown>
    expect(insertArgs).toMatchObject({
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
    const providers: ProvidersBundle = { transcription: [], videoGeneration: [provider] }
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
    const providers: ProvidersBundle = { transcription: [], videoGeneration: [provider] }
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
    const providers: ProvidersBundle = { transcription: [], videoGeneration: [provider] }
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
    const providers: ProvidersBundle = { transcription: [], videoGeneration: [provider] }
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

  it('throws when no video provider is available', async () => {
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [mockProvider(false)],
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
