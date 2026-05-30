import { describe, expect, it, vi } from 'vitest'
import { createFindMomentTool } from './find-moment.ts'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import type { FindMomentResult, TranscriptReasoningProvider } from '../providers/analysis/index.ts'

const RESULT: FindMomentResult = {
  found: true,
  best: {
    sourceTimestampSec: 5,
    quote: 'Today we talk about pricing.',
    reason: 'introduces pricing',
    confidence: 0.9,
  },
  alternatives: [
    {
      sourceTimestampSec: 12,
      quote: 'Plans start at ten dollars.',
      reason: 'a price',
      confidence: 0.6,
    },
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
    { text: 'Today we talk about pricing.', start: 5, end: 8 },
  ],
  durationSec: 8,
}

function mockProvider(
  available: boolean,
  findMomentImpl?: TranscriptReasoningProvider['findMoment'],
): TranscriptReasoningProvider {
  return {
    id: 'gemini-flash-transcript',
    isAvailable: () => available,
    findMoment: findMomentImpl ?? (async () => RESULT),
    detectChapters: async () => ({ chapters: [] }),
    suggestTrims: async () => ({ trims: [] }),
  }
}

function bridgeReturning(
  payload: AssetTranscriptPayload,
  spy?: (action: string, args: unknown) => void,
): BrowserActionBridge {
  return {
    invokeBrowserAction: (async (action: string, args: unknown) => {
      spy?.(action, args)
      if (action === 'read-asset-transcript') return payload
      return {}
    }) as BrowserActionBridge['invokeBrowserAction'],
  }
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

async function callTool(toolDef: ReturnType<typeof createFindMomentTool>, args: unknown) {
  return await toolDef.handler(args as Parameters<typeof toolDef.handler>[0], undefined)
}

interface MappedMoment {
  timestampSec: number
  sourceTimestampSec: number
  timestampLabel: string
  onTimeline: boolean
  quote: string
  reason: string
  confidence: number
}
function parseResult(result: Awaited<ReturnType<typeof callTool>>): {
  query: string
  assetId: string
  mediaId: string
  provider: string
  routingReason: string
  timebase: 'timeline' | 'source'
  found: boolean
  best: MappedMoment | null
  alternatives: MappedMoment[]
} {
  const text = (result as unknown as { content: Array<{ text: string }> }).content[0]?.text
  if (!text) throw new Error('tool result missing content[0].text')
  return JSON.parse(text)
}

describe('createFindMomentTool', () => {
  it('maps the found source time onto the timeline when the asset is a placed item', async () => {
    const toolDef = createFindMomentTool({
      bridge: bridgeReturning({
        mediaId: 'media-1',
        transcript: TRANSCRIPT,
        placement: { fromSec: 10, sourceStartSec: 0, sourceEndSec: 30 },
      }),
      providers: bundle(mockProvider(true)),
      abortSignal: new AbortController().signal,
    })

    const parsed = parseResult(await callTool(toolDef, { query: 'pricing', asset_id: 'item:abc' }))

    expect(parsed.found).toBe(true)
    expect(parsed.timebase).toBe('timeline')
    // sourceTimestampSec 5, fromSec 10, sourceStartSec 0 → 10 + (5 - 0) = 15
    expect(parsed.best?.timestampSec).toBe(15)
    expect(parsed.best?.sourceTimestampSec).toBe(5)
    expect(parsed.best?.onTimeline).toBe(true)
    expect(parsed.best?.timestampLabel).toBe('0:15')
    // alternative at source 12 → 10 + 12 = 22
    expect(parsed.alternatives[0]?.timestampSec).toBe(22)
    expect(parsed.alternatives[0]?.onTimeline).toBe(true)
  })

  it('returns source timecodes when the asset is a bare media id (no placement)', async () => {
    const toolDef = createFindMomentTool({
      bridge: bridgeReturning({ mediaId: 'media-1', transcript: TRANSCRIPT, placement: null }),
      providers: bundle(mockProvider(true)),
      abortSignal: new AbortController().signal,
    })

    const parsed = parseResult(await callTool(toolDef, { query: 'pricing', asset_id: 'media-1' }))

    expect(parsed.timebase).toBe('source')
    expect(parsed.best?.timestampSec).toBe(5)
    expect(parsed.best?.onTimeline).toBe(false)
  })

  it('keeps a moment outside the clip window in source time (onTimeline=false)', async () => {
    const outside: FindMomentResult = {
      found: true,
      best: { sourceTimestampSec: 50, quote: 'later', reason: 'r', confidence: 0.8 },
      alternatives: [],
    }
    const toolDef = createFindMomentTool({
      bridge: bridgeReturning({
        mediaId: 'media-1',
        transcript: TRANSCRIPT,
        placement: { fromSec: 10, sourceStartSec: 0, sourceEndSec: 30 },
      }),
      providers: bundle(mockProvider(true, async () => outside)),
      abortSignal: new AbortController().signal,
    })

    const parsed = parseResult(await callTool(toolDef, { query: 'q', asset_id: 'item:abc' }))
    // 50 is past sourceEndSec 30 → not mapped, reported as source time
    expect(parsed.best?.timestampSec).toBe(50)
    expect(parsed.best?.onTimeline).toBe(false)
  })

  it('forwards query + asset_id to read-asset-transcript and the provider', async () => {
    const bridgeSpy = vi.fn()
    const providerSpy = vi.fn(async () => RESULT)
    const toolDef = createFindMomentTool({
      bridge: bridgeReturning(
        { mediaId: 'media-1', transcript: TRANSCRIPT, placement: null },
        bridgeSpy,
      ),
      providers: bundle(mockProvider(true, providerSpy)),
      abortSignal: new AbortController().signal,
    })

    await callTool(toolDef, { query: 'refund policy', asset_id: 'item:xyz' })

    expect(bridgeSpy).toHaveBeenCalledWith('read-asset-transcript', { assetId: 'item:xyz' })
    expect(providerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'refund policy', transcript: TRANSCRIPT }),
      expect.anything(),
    )
  })

  it('errors recoverably when no transcript is saved', async () => {
    const toolDef = createFindMomentTool({
      bridge: bridgeReturning({ mediaId: 'media-1', transcript: null, placement: null }),
      providers: bundle(mockProvider(true)),
      abortSignal: new AbortController().signal,
    })
    await expect(callTool(toolDef, { query: 'q', asset_id: 'item:abc' })).rejects.toThrow(
      /no transcript saved.*Transcribe the clip first/,
    )
  })

  it('throws when no transcript-reasoning provider is available', async () => {
    const toolDef = createFindMomentTool({
      bridge: bridgeReturning({ mediaId: 'media-1', transcript: TRANSCRIPT, placement: null }),
      providers: bundle(mockProvider(false)),
      abortSignal: new AbortController().signal,
    })
    await expect(callTool(toolDef, { query: 'q', asset_id: 'item:abc' })).rejects.toThrow(
      /No transcript-reasoning provider is available/,
    )
  })

  it('honors explicit provider=gemini in the routing reason', async () => {
    const toolDef = createFindMomentTool({
      bridge: bridgeReturning({ mediaId: 'media-1', transcript: TRANSCRIPT, placement: null }),
      providers: bundle(mockProvider(true)),
      abortSignal: new AbortController().signal,
    })
    const parsed = parseResult(
      await callTool(toolDef, { query: 'q', asset_id: 'item:abc', provider: 'gemini' }),
    )
    expect(parsed.routingReason).toMatch(/explicit strategy: gemini/)
  })
})
