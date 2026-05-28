import { describe, expect, it, vi } from 'vitest'
import { createAnalyzeClipTool } from './analyze-clip.ts'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import type { VideoAnalysisProvider, VideoAnalysisResult } from '../providers/analysis/index.ts'

const FIXTURE: VideoAnalysisResult = {
  visualDescription: 'Slow handheld push-in on coffee cup in golden hour',
  mood: 'contemplative',
  lighting: 'golden hour',
  colorPalette: ['amber', 'cream'],
  cameraMovement: 'handheld push-in',
  subject: 'coffee cup',
  audioSummary: 'ambient piano',
  pace: 'slow',
  hasOnScreenText: false,
  suggestedBrollPrompts: [
    'Slow drift across an empty café',
    'Steam rising from coffee',
    'Soft rain on window',
  ],
}

function mockProvider(
  available: boolean,
  analyzeImpl?: VideoAnalysisProvider['analyze'],
): VideoAnalysisProvider {
  return {
    id: 'gemini-flash-video',
    isAvailable: () => available,
    analyze: analyzeImpl ?? (async () => FIXTURE),
  }
}

function emptyBridge(): BrowserActionBridge {
  return {
    invokeBrowserAction: async <T = unknown>() => ({}) as T,
  }
}

async function callTool(toolDef: ReturnType<typeof createAnalyzeClipTool>, args: unknown) {
  return await toolDef.handler(args as Parameters<typeof toolDef.handler>[0], undefined)
}

function parseResult(result: Awaited<ReturnType<typeof callTool>>): {
  clipId: string
  focus: string
  provider: string
  routingReason: string
  focusRange: { startSeconds: number; endSeconds: number } | null
  analysis: VideoAnalysisResult
} {
  const text = (result as unknown as { content: Array<{ text: string }> }).content[0]?.text
  if (!text) throw new Error('tool result missing content[0].text')
  return JSON.parse(text)
}

describe('createAnalyzeClipTool', () => {
  it('happy path: returns structured analysis JSON with provider + routing info', async () => {
    const provider = mockProvider(true)
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [],
      analysis: [provider],
      imageGeneration: [],
      gifSearch: [],
    }

    const toolDef = createAnalyzeClipTool({
      bridge: emptyBridge(),
      providers,
      abortSignal: new AbortController().signal,
    })

    const result = await callTool(toolDef, { clip_id: 'item:abc' })
    const parsed = parseResult(result)

    expect(parsed.clipId).toBe('item:abc')
    expect(parsed.focus).toBe('all')
    expect(parsed.provider).toBe('gemini-flash-video')
    expect(parsed.routingReason).toMatch(/auto: defaulting to gemini/)
    expect(parsed.focusRange).toBe(null)
    expect(parsed.analysis.visualDescription).toBe(FIXTURE.visualDescription)
    expect(parsed.analysis.suggestedBrollPrompts).toHaveLength(3)
  })

  it('forwards focus + start/end to the provider and reports the focusRange', async () => {
    const spy = vi.fn(async () => FIXTURE)
    const provider = mockProvider(true, spy)
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [],
      analysis: [provider],
      imageGeneration: [],
      gifSearch: [],
    }

    const toolDef = createAnalyzeClipTool({
      bridge: emptyBridge(),
      providers,
      abortSignal: new AbortController().signal,
    })

    const result = await callTool(toolDef, {
      clip_id: 'item:abc',
      focus: 'mood',
      start_seconds: 4,
      end_seconds: 9.5,
    })
    const parsed = parseResult(result)

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        clipId: 'item:abc',
        focus: 'mood',
        startSeconds: 4,
        endSeconds: 9.5,
      }),
      expect.anything(),
    )
    expect(parsed.focus).toBe('mood')
    expect(parsed.focusRange).toEqual({ startSeconds: 4, endSeconds: 9.5 })
  })

  it('rejects partial start/end ranges', async () => {
    const provider = mockProvider(true)
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [],
      analysis: [provider],
      imageGeneration: [],
      gifSearch: [],
    }

    const toolDef = createAnalyzeClipTool({
      bridge: emptyBridge(),
      providers,
      abortSignal: new AbortController().signal,
    })

    await expect(callTool(toolDef, { clip_id: 'item:abc', start_seconds: 2 })).rejects.toThrow(
      /pass start_seconds and end_seconds together/,
    )
    await expect(callTool(toolDef, { clip_id: 'item:abc', end_seconds: 5 })).rejects.toThrow(
      /pass start_seconds and end_seconds together/,
    )
  })

  it('rejects end_seconds <= start_seconds', async () => {
    const provider = mockProvider(true)
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [],
      analysis: [provider],
      imageGeneration: [],
      gifSearch: [],
    }

    const toolDef = createAnalyzeClipTool({
      bridge: emptyBridge(),
      providers,
      abortSignal: new AbortController().signal,
    })

    await expect(
      callTool(toolDef, { clip_id: 'item:abc', start_seconds: 5, end_seconds: 5 }),
    ).rejects.toThrow(/must be greater than start_seconds/)
    await expect(
      callTool(toolDef, { clip_id: 'item:abc', start_seconds: 5, end_seconds: 2 }),
    ).rejects.toThrow(/must be greater than start_seconds/)
  })

  it('throws clearly when no analysis provider is available', async () => {
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [],
      analysis: [mockProvider(false)],
      imageGeneration: [],
      gifSearch: [],
    }

    const toolDef = createAnalyzeClipTool({
      bridge: emptyBridge(),
      providers,
      abortSignal: new AbortController().signal,
    })

    await expect(callTool(toolDef, { clip_id: 'item:abc' })).rejects.toThrow(
      /No video analysis provider is available/,
    )
  })

  it('honors explicit provider=gemini', async () => {
    const provider = mockProvider(true)
    const providers: ProvidersBundle = {
      transcription: [],
      videoGeneration: [],
      analysis: [provider],
      imageGeneration: [],
      gifSearch: [],
    }

    const toolDef = createAnalyzeClipTool({
      bridge: emptyBridge(),
      providers,
      abortSignal: new AbortController().signal,
    })

    const result = await callTool(toolDef, { clip_id: 'item:abc', provider: 'gemini' })
    const parsed = parseResult(result)
    expect(parsed.routingReason).toMatch(/explicit strategy: gemini/)
  })
})
