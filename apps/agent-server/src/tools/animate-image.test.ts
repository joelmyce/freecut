import { describe, expect, it, vi } from 'vitest'
import { createAnimateImageTool } from './animate-image.ts'
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
        sourceUrl: 'https://fal.media/animated.mp4',
        modelUsed: 'fal-ai/kling-video/v3/standard/image-to-video',
        durationSec: 5,
        cost: { amount: 0.5, currency: 'USD' as const },
      })),
  }
}

function recordingBridge(overrides: { clipInfo?: unknown } = {}) {
  const calls: Array<{ action: string; args: unknown }> = []
  const responses = new Map<string, unknown>([
    [
      'read-image-clip-for-animation',
      overrides.clipInfo ?? {
        mediaId: 'media-img',
        trackId: 'track-img',
        from: 60,
        durationInFrames: 90,
        itemType: 'image',
        imageSourceUrl: 'https://fal.media/files/foo.png',
        originalGeneration: {
          provider: 'fal-image',
          model: 'openai/gpt-image-2',
          prompt: 'VS Code screenshot',
          params: { aspect: '16:9', resolution: 'max' },
        },
      },
    ],
    [
      'replace-clip-with-placeholder',
      { placeholderId: 'ph-anim', trackId: 'track-img', from: 60, durationInFrames: 90 },
    ],
    [
      'swap-generation-placeholder-with-url',
      {
        clipId: 'clip-anim',
        mediaId: 'media-anim',
        trackId: 'track-img',
        from: 60,
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

async function callTool(toolDef: ReturnType<typeof createAnimateImageTool>, args: unknown) {
  return await toolDef.handler(args as Parameters<typeof toolDef.handler>[0], undefined)
}

describe('createAnimateImageTool', () => {
  it('happy path: read clip → replace with placeholder → generate with imageUrl → swap', async () => {
    const provider = mockProvider('fal')
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [provider],
      analysis: [],
      imageGeneration: [],
    }
    const { bridge, calls } = recordingBridge()
    const generateSpy = vi.spyOn(provider, 'generate')

    const toolDef = createAnimateImageTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    const result = await callTool(toolDef, { image_clip_id: 'img-1' })
    const parsed = JSON.parse((result.content[0] as { text: string }).text)

    expect(parsed).toMatchObject({
      clipId: 'clip-anim',
      mediaId: 'media-anim',
      providerUsed: 'fal',
      modelUsed: 'fal-ai/kling-video/v3/standard/image-to-video',
      sourceImageMediaId: 'media-img',
    })
    expect(parsed.motionPrompt).toMatch(/Subtle natural motion/)

    // Provider was called with imageUrl set so the body builder takes the
    // image-to-video branch.
    const providerArgs = generateSpy.mock.calls[0]?.[0]
    expect(providerArgs?.imageUrl).toBe('https://fal.media/files/foo.png')
    expect(providerArgs?.prompt).toMatch(/Subtle natural motion/)

    expect(calls.map((c) => c.action)).toEqual([
      'read-image-clip-for-animation',
      'replace-clip-with-placeholder',
      'swap-generation-placeholder-with-url',
    ])
  })

  it('honors a user-supplied motion_prompt over the default', async () => {
    const provider = mockProvider('fal')
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [provider],
      analysis: [],
      imageGeneration: [],
    }
    const { bridge } = recordingBridge()
    const generateSpy = vi.spyOn(provider, 'generate')

    const toolDef = createAnimateImageTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    await callTool(toolDef, {
      image_clip_id: 'img-1',
      motion_prompt: 'slow zoom out, parallax depth',
    })
    expect(generateSpy.mock.calls[0]?.[0].prompt).toBe('slow zoom out, parallax depth')
  })

  it('forwards explicit duration_sec to the provider', async () => {
    const provider = mockProvider('fal')
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [provider],
      analysis: [],
      imageGeneration: [],
    }
    const { bridge } = recordingBridge()
    const generateSpy = vi.spyOn(provider, 'generate')

    const toolDef = createAnimateImageTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    await callTool(toolDef, { image_clip_id: 'img-1', duration_sec: 8 })
    expect(generateSpy.mock.calls[0]?.[0].targetDurationSec).toBe(8)
  })

  it('marks placeholder with error message when image-to-video fails', async () => {
    const provider = mockProvider('fal', true, async () => {
      throw new Error('Kling unavailable')
    })
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [provider],
      analysis: [],
      imageGeneration: [],
    }
    const { bridge, calls } = recordingBridge()

    const toolDef = createAnimateImageTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    await expect(callTool(toolDef, { image_clip_id: 'img-1' })).rejects.toThrow(/Kling unavailable/)
    const actions = calls.map((c) => c.action)
    expect(actions).toContain('replace-clip-with-placeholder')
    expect(actions).toContain('mark-generation-placeholder-error')
  })

  it('propagates browser-side errors from read-image-clip-for-animation (non-AI clip)', async () => {
    const provider = mockProvider('fal')
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [provider],
      analysis: [],
      imageGeneration: [],
    }
    // Simulate the browser handler refusing because the clip isn't AI-generated.
    const failingBridge: BrowserActionBridge = {
      invokeBrowserAction: async <T = unknown>(action: string): Promise<T> => {
        if (action === 'read-image-clip-for-animation') {
          throw new Error('image media foo has no generation.json')
        }
        return {} as T
      },
    }
    const toolDef = createAnimateImageTool({
      bridge: failingBridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    await expect(callTool(toolDef, { image_clip_id: 'img-1' })).rejects.toThrow(
      /no generation.json/,
    )
  })
})
