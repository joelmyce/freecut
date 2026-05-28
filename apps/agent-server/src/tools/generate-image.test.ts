import { describe, expect, it, vi } from 'vitest'
import { createGenerateImageTool } from './generate-image.ts'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import type { ImageGenerationProvider } from '../providers/image/index.ts'

function mockProvider(
  available = true,
  generateImpl?: ImageGenerationProvider['generate'],
): ImageGenerationProvider {
  return {
    id: 'fal-image',
    isAvailable: () => available,
    generate:
      generateImpl ??
      (async () => ({
        sourceUrl: 'https://fal.media/img.png',
        modelUsed: 'openai/gpt-image-2',
        width: 1920,
        height: 1080,
        mimeType: 'image/png',
      })),
  }
}

function recordingBridge() {
  const calls: Array<{ action: string; args: unknown }> = []
  const responses = new Map<string, unknown>([
    [
      'insert-generation-placeholder',
      { placeholderId: 'ph-img-1', trackId: 'track-img', from: 60, durationInFrames: 90 },
    ],
    [
      'swap-generation-placeholder-with-url',
      {
        clipId: 'img-clip-1',
        mediaId: 'media-img-1',
        trackId: 'track-img',
        from: 60,
        durationInFrames: 90,
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

async function callTool(toolDef: ReturnType<typeof createGenerateImageTool>, args: unknown) {
  return await toolDef.handler(args as Parameters<typeof toolDef.handler>[0], undefined)
}

describe('createGenerateImageTool', () => {
  it('happy path: insert placeholder → generate → swap with mediaKind: image', async () => {
    const provider = mockProvider(true)
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [],
      analysis: [],
      imageGeneration: [provider],
      gifSearch: [],
      tts: [],
    }
    const { bridge, calls } = recordingBridge()
    const generateSpy = vi.spyOn(provider, 'generate')

    const toolDef = createGenerateImageTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    const result = await callTool(toolDef, {
      prompt: 'screenshot of a VS Code editor with React code',
      start_seconds: 2,
      end_seconds: 5,
    })
    const parsed = JSON.parse((result.content[0] as { text: string }).text)

    expect(parsed).toMatchObject({
      clipId: 'img-clip-1',
      mediaId: 'media-img-1',
      providerUsed: 'fal-image',
      modelUsed: 'openai/gpt-image-2',
      mediaKind: 'image',
      routingReason: 'auto: defaulting to fal',
    })

    expect(calls.map((c) => c.action)).toEqual([
      'insert-generation-placeholder',
      'swap-generation-placeholder-with-url',
    ])

    const swapArgs = calls[1]?.args as Record<string, unknown>
    expect(swapArgs.mediaKind).toBe('image')
    expect(swapArgs.sourceUrl).toBe('https://fal.media/img.png')

    expect(generateSpy.mock.calls[0]?.[0].prompt).toBe(
      'screenshot of a VS Code editor with React code',
    )
    expect(generateSpy.mock.calls[0]?.[0].aspect).toBe('16:9')
  })

  it('passes aspect ratio through to the provider', async () => {
    const provider = mockProvider(true)
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [],
      analysis: [],
      imageGeneration: [provider],
      gifSearch: [],
      tts: [],
    }
    const generateSpy = vi.spyOn(provider, 'generate')
    const { bridge } = recordingBridge()

    const toolDef = createGenerateImageTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    await callTool(toolDef, {
      prompt: 'p',
      start_seconds: 0,
      end_seconds: 3,
      aspect: '9:16',
    })
    expect(generateSpy.mock.calls[0]?.[0].aspect).toBe('9:16')
  })

  it('rejects when end_seconds <= start_seconds', async () => {
    const provider = mockProvider(true)
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [],
      analysis: [],
      imageGeneration: [provider],
      gifSearch: [],
      tts: [],
    }
    const { bridge } = recordingBridge()

    const toolDef = createGenerateImageTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    await expect(
      callTool(toolDef, { prompt: 'p', start_seconds: 5, end_seconds: 5 }),
    ).rejects.toThrow(/end_seconds must be greater than start_seconds/)
  })

  it('throws when no image generation provider is available', async () => {
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [],
      analysis: [],
      imageGeneration: [mockProvider(false)],
      gifSearch: [],
      tts: [],
    }
    const { bridge } = recordingBridge()

    const toolDef = createGenerateImageTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    await expect(
      callTool(toolDef, { prompt: 'p', start_seconds: 0, end_seconds: 3 }),
    ).rejects.toThrow(/No image generation provider is available/)
  })

  it('marks placeholder with error message when generation fails', async () => {
    const provider = mockProvider(true, async () => {
      throw new Error('fal exploded')
    })
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [],
      analysis: [],
      imageGeneration: [provider],
      gifSearch: [],
      tts: [],
    }
    const { bridge, calls } = recordingBridge()

    const toolDef = createGenerateImageTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    await expect(
      callTool(toolDef, { prompt: 'p', start_seconds: 0, end_seconds: 3 }),
    ).rejects.toThrow(/fal exploded/)

    // Placeholder was inserted, then the error path marked it.
    const actions = calls.map((c) => c.action)
    expect(actions).toContain('insert-generation-placeholder')
    expect(actions).toContain('mark-generation-placeholder-error')
  })
})
