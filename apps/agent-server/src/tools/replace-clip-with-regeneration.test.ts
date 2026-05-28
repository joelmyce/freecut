import { describe, expect, it, vi } from 'vitest'
import { createReplaceClipWithRegenerationTool } from './replace-clip-with-regeneration.ts'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import type { VideoGenerationProvider } from '../providers/video/index.ts'

function mockProvider(
  id: VideoGenerationProvider['id'] = 'fal',
  available = true,
  generateImpl?: VideoGenerationProvider['generate'],
): VideoGenerationProvider {
  return {
    id,
    isAvailable: () => available,
    generate:
      generateImpl ??
      (async () => ({
        sourceUrl: 'https://fal.media/new.mp4',
        modelUsed: 'fal-ai/kling-video/v1.5/standard/text-to-video',
        durationSec: 5,
        cost: { amount: 0.18, currency: 'USD' as const },
      })),
  }
}

interface BridgeOverrides {
  /** Override the response for `read-clip-for-regen`. */
  clipInfo?: unknown
  /** Override the response for `replace-clip-with-placeholder`. */
  placeholder?: unknown
  /** Override the response for `swap-generation-placeholder-with-url`. */
  swap?: unknown
}

function recordingBridge(overrides: BridgeOverrides = {}) {
  const calls: Array<{ action: string; args: unknown }> = []
  const responses = new Map<string, unknown>([
    [
      'read-clip-for-regen',
      overrides.clipInfo ?? {
        mediaId: 'media-orig',
        trackId: 'track-1',
        from: 0,
        durationInFrames: 150,
        itemType: 'video',
        originalGeneration: {
          provider: 'fal',
          model: 'fal-ai/kling-video/v1.5/standard/text-to-video',
          prompt: 'neon city skyline at dusk',
          cost: { amount: 0.18, currency: 'USD' },
          durationSec: 5,
          params: { aspect: '16:9' },
        },
        transcriptContext: null,
      },
    ],
    [
      'replace-clip-with-placeholder',
      overrides.placeholder ?? {
        placeholderId: 'ph-regen',
        trackId: 'track-1',
        from: 0,
        durationInFrames: 150,
      },
    ],
    [
      'swap-generation-placeholder-with-url',
      overrides.swap ?? {
        clipId: 'clip-new',
        mediaId: 'media-new',
        trackId: 'track-1',
        from: 0,
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

async function callTool(
  toolDef: ReturnType<typeof createReplaceClipWithRegenerationTool>,
  args: unknown,
) {
  return await toolDef.handler(args as Parameters<typeof toolDef.handler>[0], undefined)
}

describe('createReplaceClipWithRegenerationTool', () => {
  it('reuses original prompt when new_prompt omitted; same provider + model preferred', async () => {
    const provider = mockProvider('fal')
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [provider],
      analysis: [],
      imageGeneration: [],
      gifSearch: [],
    }
    const { bridge, calls } = recordingBridge()
    const generateSpy = vi.spyOn(provider, 'generate')

    const toolDef = createReplaceClipWithRegenerationTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    const result = await callTool(toolDef, { clip_id: 'item-old' })
    const parsed = JSON.parse((result.content[0] as { text: string }).text)

    expect(parsed).toMatchObject({
      clipId: 'clip-new',
      mediaId: 'media-new',
      providerUsed: 'fal',
      regenMode: 'identity',
      usedTranscriptContext: false,
    })
    expect(parsed.finalPromptPreview).toBe('neon city skyline at dusk')

    expect(calls.map((c) => c.action)).toEqual([
      'read-clip-for-regen',
      'replace-clip-with-placeholder',
      'swap-generation-placeholder-with-url',
    ])

    const replaceArgs = calls[1]?.args as Record<string, unknown>
    expect(replaceArgs).toMatchObject({
      clipId: 'item-old',
      prompt: 'neon city skyline at dusk',
      providerId: 'fal',
      modelId: 'fal-ai/kling-video/v1.5/standard/text-to-video',
    })

    expect(generateSpy.mock.calls[0]?.[0].prompt).toBe('neon city skyline at dusk')
    expect(generateSpy.mock.calls[0]?.[0].model).toBe(
      'fal-ai/kling-video/v1.5/standard/text-to-video',
    )
  })

  it('errors clearly when clip is not AI-generated and no new_prompt is provided', async () => {
    const provider = mockProvider('fal')
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [provider],
      analysis: [],
      imageGeneration: [],
      gifSearch: [],
    }
    const { bridge, calls } = recordingBridge({
      clipInfo: {
        mediaId: 'media-real',
        trackId: 'track-1',
        from: 0,
        durationInFrames: 150,
        itemType: 'video',
        originalGeneration: null,
        transcriptContext: null,
      },
    })

    const toolDef = createReplaceClipWithRegenerationTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    await expect(callTool(toolDef, { clip_id: 'item-real' })).rejects.toThrow(/not AI-generated/)

    // No mutation requested — read-only call only.
    expect(calls.map((c) => c.action)).toEqual(['read-clip-for-regen'])
  })

  it('accepts new_prompt for a non-AI clip and runs the regeneration', async () => {
    const provider = mockProvider('fal')
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [provider],
      analysis: [],
      imageGeneration: [],
      gifSearch: [],
    }
    const { bridge, calls } = recordingBridge({
      clipInfo: {
        mediaId: 'media-real',
        trackId: 'track-1',
        from: 0,
        durationInFrames: 150,
        itemType: 'video',
        originalGeneration: null,
        transcriptContext: null,
      },
    })
    const generateSpy = vi.spyOn(provider, 'generate')

    const toolDef = createReplaceClipWithRegenerationTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    const result = await callTool(toolDef, {
      clip_id: 'item-real',
      new_prompt: 'a fresh take on the same scene',
    })
    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.regenMode).toBe('replacement')
    expect(generateSpy.mock.calls[0]?.[0].prompt).toBe('a fresh take on the same scene')
    expect(calls.map((c) => c.action)).toEqual([
      'read-clip-for-regen',
      'replace-clip-with-placeholder',
      'swap-generation-placeholder-with-url',
    ])
  })

  it('prompt_modifier appends to the original prompt, preserving the subject (bug fix 2026-05-26)', async () => {
    const provider = mockProvider('fal')
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [provider],
      analysis: [],
      imageGeneration: [],
      gifSearch: [],
    }
    const { bridge } = recordingBridge()
    const generateSpy = vi.spyOn(provider, 'generate')

    const toolDef = createReplaceClipWithRegenerationTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    const result = await callTool(toolDef, {
      clip_id: 'item-old',
      prompt_modifier: 'more cinematic and more dramatic',
    })
    const parsed = JSON.parse((result.content[0] as { text: string }).text)

    expect(parsed.regenMode).toBe('modifier')
    // Verifies the subject ("neon city skyline at dusk") is NOT lost — this
    // is the exact symptom that caused the Roman-soldier mishap.
    const sentPrompt = generateSpy.mock.calls[0]?.[0].prompt as string
    expect(sentPrompt).toContain('neon city skyline at dusk')
    expect(sentPrompt).toContain('more cinematic and more dramatic')
    expect(sentPrompt).toBe('neon city skyline at dusk. more cinematic and more dramatic')
  })

  it('prompt_modifier on a non-AI clip errors with guidance to use new_prompt', async () => {
    const provider = mockProvider('fal')
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [provider],
      analysis: [],
      imageGeneration: [],
      gifSearch: [],
    }
    const { bridge, calls } = recordingBridge({
      clipInfo: {
        mediaId: 'media-real',
        trackId: 'track-1',
        from: 0,
        durationInFrames: 150,
        itemType: 'video',
        originalGeneration: null,
        transcriptContext: null,
      },
    })

    const toolDef = createReplaceClipWithRegenerationTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    await expect(
      callTool(toolDef, { clip_id: 'item-real', prompt_modifier: 'more cinematic' }),
    ).rejects.toThrow(/nothing to append to.*new_prompt/)

    // Read-only — no mutation should have been requested.
    expect(calls.map((c) => c.action)).toEqual(['read-clip-for-regen'])
  })

  it('rejects when both new_prompt and prompt_modifier are passed', async () => {
    const provider = mockProvider('fal')
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [provider],
      analysis: [],
      imageGeneration: [],
      gifSearch: [],
    }
    const { bridge, calls } = recordingBridge()

    const toolDef = createReplaceClipWithRegenerationTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    await expect(
      callTool(toolDef, {
        clip_id: 'item-old',
        new_prompt: 'mountains',
        prompt_modifier: 'cinematic',
      }),
    ).rejects.toThrow(/Pass either new_prompt.*or prompt_modifier/)

    // Rejects before touching the timeline.
    expect(calls.map((c) => c.action)).toEqual([])
  })

  it('reuses the ORIGINAL model id even when the user asks for "more dramatic" via prompt_modifier (bug fix 2026-05-26)', async () => {
    const provider = mockProvider('fal')
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [provider],
      analysis: [],
      imageGeneration: [],
      gifSearch: [],
    }
    const { bridge, calls } = recordingBridge()
    const generateSpy = vi.spyOn(provider, 'generate')

    const toolDef = createReplaceClipWithRegenerationTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    await callTool(toolDef, {
      clip_id: 'item-old',
      prompt_modifier: 'more dramatic',
    })

    // The mocked clipInfo records the original model as Kling 1.5 Standard.
    // Regen MUST preserve it — flipping to a different model based on the
    // word "dramatic" is exactly the bug the user reported.
    const passedModel = generateSpy.mock.calls[0]?.[0].model as string
    expect(passedModel).toBe('fal-ai/kling-video/v1.5/standard/text-to-video')

    // The replace handler also gets told the original model so the placeholder
    // metadata stays accurate.
    const replaceArgs = calls.find((c) => c.action === 'replace-clip-with-placeholder')
      ?.args as Record<string, unknown>
    expect(replaceArgs?.modelId).toBe('fal-ai/kling-video/v1.5/standard/text-to-video')
  })

  it('prepends transcript VIDEO CONTEXT when one covers the clip range (§6.5.1)', async () => {
    const provider = mockProvider('fal')
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [provider],
      analysis: [],
      imageGeneration: [],
      gifSearch: [],
    }
    const { bridge } = recordingBridge({
      clipInfo: {
        mediaId: 'media-orig',
        trackId: 'track-1',
        from: 0,
        durationInFrames: 150,
        itemType: 'video',
        originalGeneration: {
          provider: 'fal',
          model: 'fal-ai/kling-video/v1.5/standard/text-to-video',
          prompt: 'rainy street at night',
          params: {},
        },
        transcriptContext: {
          text: 'the city never sleeps and neither do we',
          sourceStartSec: 0,
          sourceEndSec: 5,
        },
      },
    })
    const generateSpy = vi.spyOn(provider, 'generate')

    const toolDef = createReplaceClipWithRegenerationTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    const result = await callTool(toolDef, { clip_id: 'item-old' })
    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.usedTranscriptContext).toBe(true)

    const sentPrompt = generateSpy.mock.calls[0]?.[0].prompt as string
    expect(sentPrompt).toContain('VIDEO CONTEXT')
    expect(sentPrompt).toContain('the city never sleeps')
    expect(sentPrompt).toContain('rainy street at night')
  })

  it('on provider failure: marks placeholder error and rethrows', async () => {
    const provider = mockProvider('fal', true, async () => {
      throw new Error('fal regen exploded')
    })
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [provider],
      analysis: [],
      imageGeneration: [],
      gifSearch: [],
    }
    const { bridge, calls } = recordingBridge()

    const toolDef = createReplaceClipWithRegenerationTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    await expect(callTool(toolDef, { clip_id: 'item-old' })).rejects.toThrow(/fal regen exploded/)

    const actions = calls.map((c) => c.action)
    expect(actions).toContain('replace-clip-with-placeholder')
    expect(actions).toContain('mark-generation-placeholder-error')
    expect(actions).not.toContain('swap-generation-placeholder-with-url')
  })

  it('on abort: removes placeholder and rethrows', async () => {
    const controller = new AbortController()
    const provider = mockProvider('fal', true, async (_input, ctx) => {
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
    }
    const { bridge, calls } = recordingBridge()

    const toolDef = createReplaceClipWithRegenerationTool({
      bridge,
      providers,
      abortSignal: controller.signal,
    })
    await expect(callTool(toolDef, { clip_id: 'item-old' })).rejects.toThrow()

    const actions = calls.map((c) => c.action)
    expect(actions).toContain('remove-generation-placeholder')
    expect(actions).not.toContain('swap-generation-placeholder-with-url')
    expect(actions).not.toContain('mark-generation-placeholder-error')
  })
})
