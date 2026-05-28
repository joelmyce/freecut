import { describe, expect, it, vi } from 'vitest'
import { createAddGifTool } from './add-gif.ts'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import type { GifSearchProvider, GifSearchResult } from '../providers/gif/index.ts'

function mockProvider(
  available = true,
  searchImpl?: GifSearchProvider['search'],
): GifSearchProvider {
  return {
    id: 'giphy',
    isAvailable: () => available,
    search:
      searchImpl ??
      (async (): Promise<GifSearchResult> => ({
        candidates: [
          {
            id: 'abc123',
            title: 'excited high five',
            sourceUrl: 'https://media.giphy.com/abc123.gif',
            stillPreviewUrl: 'https://media.giphy.com/abc123-still.gif',
            width: 480,
            height: 270,
            mimeType: 'image/gif',
          },
          {
            id: 'def456',
            title: 'celebrating',
            sourceUrl: 'https://media.giphy.com/def456.gif',
            width: 500,
            height: 281,
            mimeType: 'image/gif',
          },
        ],
        modelUsed: 'giphy:v1/gifs/search',
      })),
  }
}

function recordingBridge() {
  const calls: Array<{ action: string; args: unknown }> = []
  const responses = new Map<string, unknown>([
    [
      'insert-generation-placeholder',
      { placeholderId: 'ph-gif-1', trackId: 'track-gif', from: 60, durationInFrames: 90 },
    ],
    [
      'swap-generation-placeholder-with-url',
      {
        clipId: 'gif-clip-1',
        mediaId: 'media-gif-1',
        trackId: 'track-gif',
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

async function callTool(toolDef: ReturnType<typeof createAddGifTool>, args: unknown) {
  return await toolDef.handler(args as Parameters<typeof toolDef.handler>[0], undefined)
}

describe('createAddGifTool', () => {
  it('happy path: insert placeholder → Giphy search → swap with mediaKind: image', async () => {
    const provider = mockProvider(true)
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [],
      analysis: [],
      imageGeneration: [],
      gifSearch: [provider],
      tts: [],
    }
    const { bridge, calls } = recordingBridge()
    const searchSpy = vi.spyOn(provider, 'search')

    const toolDef = createAddGifTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    const result = await callTool(toolDef, {
      query: 'excited high five',
      start_seconds: 2,
    })
    const parsed = JSON.parse((result.content[0] as { text: string }).text)

    expect(parsed).toMatchObject({
      clipId: 'gif-clip-1',
      mediaId: 'media-gif-1',
      providerUsed: 'giphy',
      modelUsed: 'giphy:v1/gifs/search',
      mediaKind: 'image',
      routingReason: 'auto: defaulting to giphy',
      gif: {
        giphyId: 'abc123',
        title: 'excited high five',
        sourceUrl: 'https://media.giphy.com/abc123.gif',
      },
    })
    expect(parsed.candidates).toHaveLength(2)

    expect(calls.map((c) => c.action)).toEqual([
      'insert-generation-placeholder',
      'swap-generation-placeholder-with-url',
    ])
    const swapArgs = calls[1]?.args as Record<string, unknown>
    expect(swapArgs.mediaKind).toBe('image')
    expect(swapArgs.sourceUrl).toBe('https://media.giphy.com/abc123.gif')

    // Default 5 candidate limit, default rating 'g'
    expect(searchSpy.mock.calls[0]?.[0]).toMatchObject({
      query: 'excited high five',
      limit: 5,
      rating: 'g',
    })

    // Default end_seconds = start_seconds + 3
    const placeholderArgs = calls[0]?.args as Record<string, unknown>
    expect(placeholderArgs.startSeconds).toBe(2)
    expect(placeholderArgs.endSeconds).toBe(5)
  })

  it('honors candidate_index when the user picks a different result', async () => {
    const provider = mockProvider(true)
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [],
      analysis: [],
      imageGeneration: [],
      gifSearch: [provider],
      tts: [],
    }
    const { bridge, calls } = recordingBridge()

    const toolDef = createAddGifTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    const result = await callTool(toolDef, {
      query: 'high five',
      start_seconds: 0,
      candidate_index: 1,
    })
    const parsed = JSON.parse((result.content[0] as { text: string }).text)

    expect(parsed.gif.giphyId).toBe('def456')
    const swapArgs = calls[1]?.args as Record<string, unknown>
    expect(swapArgs.sourceUrl).toBe('https://media.giphy.com/def456.gif')
  })

  it('honors explicit end_seconds for longer holds', async () => {
    const provider = mockProvider(true)
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [],
      analysis: [],
      imageGeneration: [],
      gifSearch: [provider],
      tts: [],
    }
    const { bridge, calls } = recordingBridge()

    const toolDef = createAddGifTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    await callTool(toolDef, { query: 'q', start_seconds: 2, end_seconds: 9 })

    const placeholderArgs = calls[0]?.args as Record<string, unknown>
    expect(placeholderArgs.startSeconds).toBe(2)
    expect(placeholderArgs.endSeconds).toBe(9)
  })

  it('rejects end_seconds <= start_seconds', async () => {
    const provider = mockProvider(true)
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [],
      analysis: [],
      imageGeneration: [],
      gifSearch: [provider],
      tts: [],
    }
    const toolDef = createAddGifTool({
      bridge: recordingBridge().bridge,
      providers,
      abortSignal: new AbortController().signal,
    })

    await expect(
      callTool(toolDef, { query: 'q', start_seconds: 5, end_seconds: 5 }),
    ).rejects.toThrow(/greater than start_seconds/)
    await expect(
      callTool(toolDef, { query: 'q', start_seconds: 5, end_seconds: 3 }),
    ).rejects.toThrow(/greater than start_seconds/)
  })

  it('throws when candidate_index is out of range', async () => {
    const provider = mockProvider(true)
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [],
      analysis: [],
      imageGeneration: [],
      gifSearch: [provider],
      tts: [],
    }
    const { bridge, calls } = recordingBridge()

    const toolDef = createAddGifTool({
      bridge,
      providers,
      abortSignal: new AbortController().signal,
    })
    await expect(
      callTool(toolDef, { query: 'q', start_seconds: 0, candidate_index: 99 }),
    ).rejects.toThrow(/out of range/)

    // Failure path must mark the placeholder as errored, not silently leave it.
    expect(calls.map((c) => c.action)).toContain('mark-generation-placeholder-error')
  })

  it('throws clearly when no gif provider is available', async () => {
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [],
      analysis: [],
      imageGeneration: [],
      gifSearch: [mockProvider(false)],
      tts: [],
    }

    const toolDef = createAddGifTool({
      bridge: recordingBridge().bridge,
      providers,
      abortSignal: new AbortController().signal,
    })

    await expect(callTool(toolDef, { query: 'q', start_seconds: 0 })).rejects.toThrow(
      /No GIF search provider is available/,
    )
  })

  it('cleans up the placeholder when the search aborts', async () => {
    const abortController = new AbortController()
    const provider = mockProvider(true, async () => {
      abortController.abort()
      const err = new Error('AbortError')
      err.name = 'AbortError'
      throw err
    })
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [],
      analysis: [],
      imageGeneration: [],
      gifSearch: [provider],
      tts: [],
    }
    const { bridge, calls } = recordingBridge()

    const toolDef = createAddGifTool({
      bridge,
      providers,
      abortSignal: abortController.signal,
    })

    await expect(callTool(toolDef, { query: 'q', start_seconds: 0 })).rejects.toThrow()

    // Abort path removes the placeholder; mark-error path is for non-abort failures.
    const actions = calls.map((c) => c.action)
    expect(actions).toContain('remove-generation-placeholder')
    expect(actions).not.toContain('mark-generation-placeholder-error')
  })
})
