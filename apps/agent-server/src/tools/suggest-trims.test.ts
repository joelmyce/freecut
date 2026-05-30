import { describe, expect, it } from 'vitest'
import { createSuggestTrimsTool } from './suggest-trims.ts'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import type { ConfirmationCard } from '../bridge/protocol.ts'
import type {
  SuggestTrimsResult,
  TranscriptReasoningProvider,
} from '../providers/analysis/index.ts'

const TRIMS: SuggestTrimsResult = {
  trims: [
    { startSec: 5, endSec: 9, reason: 'rambling' },
    { startSec: 30, endSec: 35, reason: 'long pause' },
  ],
}

interface AssetTranscriptPayload {
  mediaId: string
  transcript: {
    segments: Array<{
      text: string
      start: number
      end: number
      words?: Array<{ start: number; end: number }>
    }>
    durationSec: number
  } | null
  placement: { fromSec: number; sourceStartSec: number; sourceEndSec: number } | null
}

const TRANSCRIPT = { segments: [{ text: 'hi', start: 0, end: 40 }], durationSec: 40 }
const PLACED: AssetTranscriptPayload = {
  mediaId: 'media-1',
  transcript: TRANSCRIPT,
  placement: { fromSec: 10, sourceStartSec: 0, sourceEndSec: 200 },
}

function mockProvider(
  available: boolean,
  trimsImpl?: TranscriptReasoningProvider['suggestTrims'],
): TranscriptReasoningProvider {
  return {
    id: 'gemini-flash-transcript',
    isAvailable: () => available,
    findMoment: async () => ({ found: false, best: null, alternatives: [] }),
    detectChapters: async () => ({ chapters: [] }),
    suggestTrims: trimsImpl ?? (async () => TRIMS),
  }
}

interface BridgeCall {
  action: string
  args: unknown
}

function makeBridge(
  asset: AssetTranscriptPayload,
  opts?: { confirmation?: 'approve' | 'reject'; captureCard?: (card: ConfirmationCard) => void },
): { bridge: BrowserActionBridge; calls: BridgeCall[] } {
  const calls: BridgeCall[] = []
  const bridge: BrowserActionBridge = {
    invokeBrowserAction: (async (action: string, args: unknown) => {
      calls.push({ action, args })
      if (action === 'read-asset-transcript') return asset
      if (action === 'apply-trims') {
        return { removedItemCount: 2, splitCount: 4, analyzedItemCount: 1 }
      }
      return {}
    }) as BrowserActionBridge['invokeBrowserAction'],
  }
  if (opts?.confirmation) {
    bridge.requestConfirmation = async (card: ConfirmationCard) => {
      opts.captureCard?.(card)
      return { decision: opts.confirmation! }
    }
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

async function callTool(toolDef: ReturnType<typeof createSuggestTrimsTool>, args: unknown) {
  return await toolDef.handler(args as Parameters<typeof toolDef.handler>[0], undefined)
}

interface ParsedResult {
  status: 'applied' | 'declined' | 'no-trims'
  trimCount?: number
  removedDurationSec?: number
  proposedTrimCount?: number
}
function parseResult(result: Awaited<ReturnType<typeof callTool>>): ParsedResult {
  const text = (result as unknown as { content: Array<{ text: string }> }).content[0]?.text
  if (!text) throw new Error('tool result missing content[0].text')
  return JSON.parse(text)
}

function appliedTrims(calls: BridgeCall[]): Array<{ startSec: number; endSec: number }> | null {
  const call = calls.find((c) => c.action === 'apply-trims')
  if (!call) return null
  return (call.args as { trims: Array<{ startSec: number; endSec: number }> }).trims
}

describe('createSuggestTrimsTool', () => {
  it('applies directly when the bridge has no confirmation channel', async () => {
    const { bridge, calls } = makeBridge(PLACED)
    const toolDef = createSuggestTrimsTool({
      bridge,
      providers: bundle(mockProvider(true)),
      abortSignal: new AbortController().signal,
    })

    const parsed = parseResult(await callTool(toolDef, { clip_id: 'item:abc' }))
    expect(parsed.status).toBe('applied')
    expect(parsed.trimCount).toBe(2)
    // No words → snap is a no-op; the 0.25s safety margin pulls each edge inward.
    expect(appliedTrims(calls)).toEqual([
      { startSec: 5.25, endSec: 8.75 },
      { startSec: 30.25, endSec: 34.75 },
    ])
  })

  it('snaps cut edges to word boundaries then pads inward before applying', async () => {
    const assetWithWords: AssetTranscriptPayload = {
      mediaId: 'media-1',
      transcript: {
        segments: [
          {
            text: 'foo bar',
            start: 0,
            end: 40,
            words: [
              { start: 4.8, end: 5.4 },
              { start: 29.6, end: 30.4 },
            ],
          },
        ],
        durationSec: 40,
      },
      placement: { fromSec: 10, sourceStartSec: 0, sourceEndSec: 200 },
    }
    const { bridge, calls } = makeBridge(assetWithWords)
    const toolDef = createSuggestTrimsTool({
      bridge,
      providers: bundle(
        mockProvider(true, async () => ({
          trims: [
            { startSec: 5, endSec: 9, reason: 'rambling' }, // 5 ∈ word{4.8,5.4} → 4.8
            { startSec: 30, endSec: 35, reason: 'long pause' }, // 30 ∈ word{29.6,30.4} → 29.6
          ],
        })),
      ),
      abortSignal: new AbortController().signal,
    })

    await callTool(toolDef, { clip_id: 'item:abc' })
    // 5 → snap 4.8 → +0.25 = 5.05; 9 → free → −0.25 = 8.75.
    // 30 → snap 29.6 → +0.25 = 29.85; 35 → free → −0.25 = 34.75.
    expect(appliedTrims(calls)).toEqual([
      { startSec: 5.05, endSec: 8.75 },
      { startSec: 29.85, endSec: 34.75 },
    ])
  })

  it('applies when the user approves the card', async () => {
    const { bridge, calls } = makeBridge(PLACED, { confirmation: 'approve' })
    const toolDef = createSuggestTrimsTool({
      bridge,
      providers: bundle(mockProvider(true)),
      abortSignal: new AbortController().signal,
    })

    const parsed = parseResult(await callTool(toolDef, { clip_id: 'item:abc' }))
    expect(parsed.status).toBe('applied')
    expect(appliedTrims(calls)).not.toBeNull()
  })

  it('makes NO mutation when the user rejects the card', async () => {
    const { bridge, calls } = makeBridge(PLACED, { confirmation: 'reject' })
    const toolDef = createSuggestTrimsTool({
      bridge,
      providers: bundle(mockProvider(true)),
      abortSignal: new AbortController().signal,
    })

    const parsed = parseResult(await callTool(toolDef, { clip_id: 'item:abc' }))
    expect(parsed.status).toBe('declined')
    expect(appliedTrims(calls)).toBeNull()
  })

  it('builds a card listing each trim with timeline timecodes', async () => {
    let card: ConfirmationCard | undefined
    const { bridge } = makeBridge(PLACED, {
      confirmation: 'approve',
      captureCard: (c) => {
        card = c
      },
    })
    const toolDef = createSuggestTrimsTool({
      bridge,
      providers: bundle(mockProvider(true)),
      abortSignal: new AbortController().signal,
    })

    await callTool(toolDef, { clip_id: 'item:abc' })
    expect(card?.title).toContain('2')
    expect(card?.details).toHaveLength(2)
    // trim at source 5s, placement fromSec 10 → timeline 0:15
    expect(card?.details?.[0]?.label).toContain('0:15')
    expect(card?.details?.[0]?.value).toBe('rambling')
  })

  it('returns no-trims (no gate, no mutation) when nothing is worth cutting', async () => {
    const { bridge, calls } = makeBridge(PLACED, { confirmation: 'approve' })
    const toolDef = createSuggestTrimsTool({
      bridge,
      providers: bundle(mockProvider(true, async () => ({ trims: [] }))),
      abortSignal: new AbortController().signal,
    })

    const parsed = parseResult(await callTool(toolDef, { clip_id: 'item:abc' }))
    expect(parsed.status).toBe('no-trims')
    expect(appliedTrims(calls)).toBeNull()
  })

  it('errors recoverably when no transcript is saved', async () => {
    const { bridge } = makeBridge({ mediaId: 'media-1', transcript: null, placement: null })
    const toolDef = createSuggestTrimsTool({
      bridge,
      providers: bundle(mockProvider(true)),
      abortSignal: new AbortController().signal,
    })
    await expect(callTool(toolDef, { clip_id: 'item:abc' })).rejects.toThrow(
      /no transcript saved.*Transcribe the clip first/,
    )
  })

  it('errors when the asset is not a placed clip (media id, no placement)', async () => {
    const { bridge } = makeBridge({ mediaId: 'media-1', transcript: TRANSCRIPT, placement: null })
    const toolDef = createSuggestTrimsTool({
      bridge,
      providers: bundle(mockProvider(true)),
      abortSignal: new AbortController().signal,
    })
    await expect(callTool(toolDef, { clip_id: 'media-1' })).rejects.toThrow(
      /needs a clip placed on the timeline/,
    )
  })

  it('throws when no transcript-reasoning provider is available', async () => {
    const { bridge } = makeBridge(PLACED)
    const toolDef = createSuggestTrimsTool({
      bridge,
      providers: bundle(mockProvider(false)),
      abortSignal: new AbortController().signal,
    })
    await expect(callTool(toolDef, { clip_id: 'item:abc' })).rejects.toThrow(
      /No transcript-reasoning provider is available/,
    )
  })
})
