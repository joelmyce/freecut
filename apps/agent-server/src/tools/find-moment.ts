import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import { pickTranscriptReasoningProvider } from '../providers/analysis/index.ts'
import type {
  FoundMoment,
  ReasoningTranscript,
  TranscriptReasoningStrategy,
} from '../providers/analysis/index.ts'
import { formatTimecode } from './timecode.ts'

export interface CreateFindMomentToolOptions {
  bridge: BrowserActionBridge
  providers: ProvidersBundle
  abortSignal: AbortSignal
}

/** Payload returned by the browser `read-asset-transcript` handler. */
interface AssetTranscriptPayload {
  mediaId: string
  transcript: ReasoningTranscript | null
  placement: {
    fromSec: number
    sourceStartSec: number
    sourceEndSec: number
  } | null
}

const inputSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      'Natural-language description of the moment to locate — e.g. "when do they mention pricing", "where she talks about the refund policy", "the part about onboarding". This is matched against the clip\'s transcript.',
    ),
  asset_id: z
    .string()
    .describe(
      'The clip to search. Pass the bare uuid from the timeline summary — from "(item:89e1...)" pass "89e1...", from "(media:abc)" pass "abc". An item id maps the result to a timeline timecode; a media id returns source-clip timecodes.',
    ),
  provider: z
    .enum(['auto', 'gemini'])
    .optional()
    .describe(
      'Analysis provider. Defaults to "auto" → Gemini (the only transcript-reasoning backend today). Unlike transcription, Gemini is the default here — there is no local alternative.',
    ),
}

/**
 * `find_moment` — M6 tool #1. Locates WHEN something is said/happens inside a
 * clip by reasoning over its saved transcript. **Read-only side effects:** it
 * returns timestamps and does NOT move the playhead or touch the timeline.
 *
 * Composition (transcript-first, the M6 pattern):
 *   1. read-asset-transcript (browser, read-only) → the clip's transcript +,
 *      when the asset is a placed item, a source→timeline placement block.
 *   2. provider.findMoment (Gemini text reasoning) → best match + alternatives
 *      in source-native time.
 *   3. map source→timeline here using the placement so the agent can quote a
 *      timeline timecode the user can seek to.
 *
 * Requires a saved transcript — errors (recoverably) when none exists so the
 * orchestrator transcribes first and retries, mirroring add_subtitles.
 */
export function createFindMomentTool(options: CreateFindMomentToolOptions) {
  return tool(
    'find_moment',
    'Locate WHEN something is said or happens in a clip by searching its transcript. Use for "when do they mention pricing?", "find where she talks about the refund policy", "jump to the part about onboarding", "where does he say X". Read-only — returns timestamps (best match + up to 3 alternatives), with timeline timecodes when the clip is placed on the timeline; does NOT move the playhead or change anything. Requires a saved transcript: if none exists the tool errors with "no transcript" — transcribe the clip first, then retry. Do NOT use this to add captions (use add_subtitles) or to describe visuals/mood (use analyze_clip).',
    inputSchema,
    async (args) => {
      const strategy: TranscriptReasoningStrategy = args.provider ?? 'auto'
      const { provider, reason: routingReason } = pickTranscriptReasoningProvider(
        options.providers.transcriptReasoning ?? [],
        strategy,
      )

      const asset = await options.bridge.invokeBrowserAction<AssetTranscriptPayload>(
        'read-asset-transcript',
        { assetId: args.asset_id },
        options.abortSignal,
      )

      if (!asset.transcript || asset.transcript.segments.length === 0) {
        throw new Error(
          `find_moment: no transcript saved for ${args.asset_id}. Transcribe the clip first, then call find_moment again.`,
        )
      }

      const result = await provider.findMoment(
        { query: args.query, transcript: asset.transcript },
        { bridge: options.bridge, signal: options.abortSignal },
      )

      const placement = asset.placement
      const payload = {
        query: args.query,
        assetId: args.asset_id,
        mediaId: asset.mediaId,
        provider: provider.id,
        routingReason,
        timebase: placement ? ('timeline' as const) : ('source' as const),
        found: result.found,
        best: result.best ? mapMoment(result.best, placement) : null,
        alternatives: result.alternatives.map((m) => mapMoment(m, placement)),
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
      }
    },
  )
}

interface MappedMoment {
  /** Best timestamp to seek to — timeline seconds when on the timeline, else source seconds. */
  timestampSec: number
  /** Always the source-native timestamp from the transcript. */
  sourceTimestampSec: number
  /** Human-readable mm:ss (or h:mm:ss) of `timestampSec`. */
  timestampLabel: string
  /** True when `timestampSec` is a real timeline position (asset is a placed clip and the moment falls within its window). */
  onTimeline: boolean
  quote: string
  reason: string
  confidence: number
}

function mapMoment(
  moment: FoundMoment,
  placement: AssetTranscriptPayload['placement'],
): MappedMoment {
  let timestampSec = moment.sourceTimestampSec
  let onTimeline = false

  if (placement) {
    const inWindow =
      moment.sourceTimestampSec >= placement.sourceStartSec &&
      moment.sourceTimestampSec <= placement.sourceEndSec
    if (inWindow) {
      timestampSec = placement.fromSec + (moment.sourceTimestampSec - placement.sourceStartSec)
      onTimeline = true
    }
  }

  return {
    timestampSec,
    sourceTimestampSec: moment.sourceTimestampSec,
    timestampLabel: formatTimecode(timestampSec),
    onTimeline,
    quote: moment.quote,
    reason: moment.reason,
    confidence: moment.confidence,
  }
}
