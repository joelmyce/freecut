import { describe, expect, it } from 'vitest'
import { createDetectChaptersTool } from './detect-chapters.ts'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import type {
  DetectChaptersResult,
  TranscriptReasoningProvider,
} from '../providers/analysis/index.ts'

const CHAPTERS: DetectChaptersResult = {
  chapters: [
    { startSec: 0, title: 'Intro' },
    { startSec: 120, title: 'Pricing' },
  ],
}

interface AssetTranscriptPayload {
  mediaId: string
  transcript: {
    segments: Array<{ text: string; start: number; end: number }>
    durationSec: number
  } | null
  placement: { fromSec: number; sourceStartSec: number; sourceEndSec: number } | null
}

const TRANSCRIPT = {
  segments: [
    { text: 'Intro.', start: 0, end: 2 },
    { text: 'Now about pricing.', start: 120, end: 124 },
  ],
  durationSec: 124,
}

function mockProvider(
  available: boolean,
  detectImpl?: TranscriptReasoningProvider['detectChapters'],
): TranscriptReasoningProvider {
  return {
    id: 'gemini-flash-transcript',
    isAvailable: () => available,
    findMoment: async () => ({ found: false, best: null, alternatives: [] }),
    detectChapters: detectImpl ?? (async () => CHAPTERS),
    suggestTrims: async () => ({ trims: [] }),
  }
}

interface BridgeCall {
  action: string
  args: unknown
}

function makeBridge(asset: AssetTranscriptPayload): {
  bridge: BrowserActionBridge
  calls: BridgeCall[]
} {
  const calls: BridgeCall[] = []
  const bridge: BrowserActionBridge = {
    invokeBrowserAction: (async (action: string, args: unknown) => {
      calls.push({ action, args })
      if (action === 'read-asset-transcript') return asset
      if (action === 'add-chapter-markers') {
        const chapters = (args as { chapters: unknown[] }).chapters
        return { insertedCount: chapters.length, markers: [] }
      }
      return {}
    }) as BrowserActionBridge['invokeBrowserAction'],
  }
  return { bridge, calls }
}

function bundle(provider: TranscriptReasoningProvider | null): ProvidersBundle {
  return {
    transcription: [],
    videoGeneration: [],
    analysis: [],
    imageGeneration: [],
    gifSearch: [],
    tts: [],
    transcriptReasoning: provider ? [provider] : [],
  }
}

async function callTool(toolDef: ReturnType<typeof createDetectChaptersTool>, args: unknown) {
  return await toolDef.handler(args as Parameters<typeof toolDef.handler>[0], undefined)
}

interface ParsedChapter {
  timestampSec: number
  timestampLabel: string
  title: string
}
function parseResult(result: Awaited<ReturnType<typeof callTool>>): {
  insertedCount: number
  timebase: 'timeline' | 'source'
  routingReason: string
  chapters: ParsedChapter[]
} {
  const text = (result as unknown as { content: Array<{ text: string }> }).content[0]?.text
  if (!text) throw new Error('tool result missing content[0].text')
  return JSON.parse(text)
}

function addChapterCall(calls: BridgeCall[]): {
  chapters: Array<{ timelineSec: number; title: string }>
} {
  const call = calls.find((c) => c.action === 'add-chapter-markers')
  if (!call) throw new Error('add-chapter-markers was not invoked')
  return call.args as { chapters: Array<{ timelineSec: number; title: string }> }
}

describe('createDetectChaptersTool', () => {
  it('maps chapter source times onto the timeline and inserts markers (placed item)', async () => {
    const { bridge, calls } = makeBridge({
      mediaId: 'media-1',
      transcript: TRANSCRIPT,
      placement: { fromSec: 10, sourceStartSec: 0, sourceEndSec: 200 },
    })
    const toolDef = createDetectChaptersTool({
      bridge,
      providers: bundle(mockProvider(true)),
      abortSignal: new AbortController().signal,
    })

    const parsed = parseResult(await callTool(toolDef, { asset_id: 'item:abc' }))

    expect(parsed.insertedCount).toBe(2)
    expect(parsed.timebase).toBe('timeline')
    // source [0, 120] shifted by fromSec 10 → [10, 130]
    const sent = addChapterCall(calls)
    expect(sent.chapters.map((c) => c.timelineSec)).toEqual([10, 130])
    expect(parsed.chapters.map((c) => c.timestampLabel)).toEqual(['0:10', '2:10'])
  })

  it('uses source times when the asset is a bare media id (no placement)', async () => {
    const { bridge, calls } = makeBridge({
      mediaId: 'media-1',
      transcript: TRANSCRIPT,
      placement: null,
    })
    const toolDef = createDetectChaptersTool({
      bridge,
      providers: bundle(mockProvider(true)),
      abortSignal: new AbortController().signal,
    })

    const parsed = parseResult(await callTool(toolDef, { asset_id: 'media-1' }))
    expect(parsed.timebase).toBe('source')
    expect(addChapterCall(calls).chapters.map((c) => c.timelineSec)).toEqual([0, 120])
  })

  it('inserts nothing when the model finds no chapters', async () => {
    const { bridge, calls } = makeBridge({
      mediaId: 'media-1',
      transcript: TRANSCRIPT,
      placement: null,
    })
    const toolDef = createDetectChaptersTool({
      bridge,
      providers: bundle(mockProvider(true, async () => ({ chapters: [] }))),
      abortSignal: new AbortController().signal,
    })

    const parsed = parseResult(await callTool(toolDef, { asset_id: 'item:abc' }))
    expect(parsed.insertedCount).toBe(0)
    expect(parsed.chapters).toEqual([])
    expect(calls.some((c) => c.action === 'add-chapter-markers')).toBe(false)
  })

  it('errors recoverably when no transcript is saved', async () => {
    const { bridge } = makeBridge({ mediaId: 'media-1', transcript: null, placement: null })
    const toolDef = createDetectChaptersTool({
      bridge,
      providers: bundle(mockProvider(true)),
      abortSignal: new AbortController().signal,
    })
    await expect(callTool(toolDef, { asset_id: 'item:abc' })).rejects.toThrow(
      /no transcript saved.*Transcribe the clip first/,
    )
  })

  it('forwards granularity to the provider', async () => {
    let seenGranularity: string | undefined
    const { bridge } = makeBridge({
      mediaId: 'media-1',
      transcript: TRANSCRIPT,
      placement: null,
    })
    const toolDef = createDetectChaptersTool({
      bridge,
      providers: bundle(
        mockProvider(true, async (input) => {
          seenGranularity = input.granularity
          return CHAPTERS
        }),
      ),
      abortSignal: new AbortController().signal,
    })

    await callTool(toolDef, { asset_id: 'item:abc', granularity: 'fine' })
    expect(seenGranularity).toBe('fine')
  })

  it('throws when no transcript-reasoning provider is available', async () => {
    const { bridge } = makeBridge({ mediaId: 'media-1', transcript: TRANSCRIPT, placement: null })
    const toolDef = createDetectChaptersTool({
      bridge,
      providers: bundle(mockProvider(false)),
      abortSignal: new AbortController().signal,
    })
    await expect(callTool(toolDef, { asset_id: 'item:abc' })).rejects.toThrow(
      /No transcript-reasoning provider is available/,
    )
  })
})
