import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import { pickTranscriptReasoningProvider } from '../providers/analysis/index.ts'
import type {
  ReasoningTranscript,
  TranscriptReasoningStrategy,
} from '../providers/analysis/index.ts'
import { formatTimecode } from './timecode.ts'

export interface CreateDetectChaptersToolOptions {
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

interface AddChapterMarkersResult {
  insertedCount: number
  markers: Array<{ frame: number; label: string }>
}

const inputSchema = {
  asset_id: z
    .string()
    .describe(
      'The clip to chapterize. Pass the bare uuid from the timeline summary — from "(item:89e1...)" pass "89e1...", from "(media:abc)" pass "abc". An item id drops markers at timeline positions; a media id assumes the clip starts at 0:00.',
    ),
  granularity: z
    .enum(['coarse', 'fine'])
    .optional()
    .describe(
      'How finely to segment. "coarse" (default) = fewer, broader chapters (~1 per 2-5 min). "fine" = more chapters capturing smaller topic shifts (~1 per 1-2 min). Use "fine" when the user asks for "detailed" / "granular" chapters or for a short clip.',
    ),
  provider: z
    .enum(['auto', 'gemini'])
    .optional()
    .describe(
      'Analysis provider. Defaults to "auto" → Gemini (the only transcript-reasoning backend). Unlike transcription, Gemini is the default here.',
    ),
}

/**
 * `detect_chapters` — M6 tool #2. Segments a clip's transcript into topical
 * chapters and drops a timeline marker at each boundary. **Side effects:
 * mutate** (adds markers) — but in a SINGLE undo entry, so one Ctrl+Z clears
 * the whole chapter set.
 *
 * Composition (transcript-first, reuses find_moment's machinery):
 *   1. read-asset-transcript (browser, read-only) → transcript + placement.
 *   2. provider.detectChapters (Gemini text reasoning) → ordered chapters in
 *      source-native time.
 *   3. map source→timeline here using the placement, then add-chapter-markers
 *      (browser, mutating) converts seconds→frames and inserts them atomically.
 *
 * Requires a saved transcript — errors recoverably when none exists so the
 * orchestrator transcribes first and retries, mirroring add_subtitles.
 */
export function createDetectChaptersTool(options: CreateDetectChaptersToolOptions) {
  return tool(
    'detect_chapters',
    'Segment a clip into chapters by topic and drop a labeled timeline marker at each chapter boundary. Use for "add chapters", "chapter markers", "break this into sections", "mark the topics", "segment this video". Reads the clip\'s saved transcript, asks the model where the topics shift, and inserts all the markers in ONE step (a single Ctrl+Z removes the whole set). Requires a saved transcript: if it errors with "no transcript", call transcribe first and retry (same recovery as add_subtitles). Pass granularity:"fine" for more, smaller chapters when the user wants detail. This MUTATES the timeline (adds markers) — it does not cut or move any clips.',
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
          `detect_chapters: no transcript saved for ${args.asset_id}. Transcribe the clip first, then call detect_chapters again.`,
        )
      }

      const granularity = args.granularity ?? 'coarse'
      const { chapters } = await provider.detectChapters(
        { transcript: asset.transcript, granularity },
        { bridge: options.bridge, signal: options.abortSignal },
      )

      const placement = asset.placement

      if (chapters.length === 0) {
        return textResult({
          assetId: args.asset_id,
          mediaId: asset.mediaId,
          provider: provider.id,
          routingReason,
          granularity,
          timebase: placement ? 'timeline' : 'source',
          insertedCount: 0,
          chapters: [],
          message: 'No clear chapter boundaries were found in the transcript.',
        })
      }

      // Map each chapter's source-native start onto the timeline. Chapters are
      // structural, so unlike find_moment we map ALL of them (no window filter)
      // — a clip placed at fromSec shifts every boundary by the same offset.
      const mapped = chapters.map((c) => {
        const timelineSec = placement
          ? placement.fromSec + (c.startSec - placement.sourceStartSec)
          : c.startSec
        return { timelineSec: Math.max(0, timelineSec), title: c.title }
      })

      const insert = await options.bridge.invokeBrowserAction<AddChapterMarkersResult>(
        'add-chapter-markers',
        { chapters: mapped.map((m) => ({ timelineSec: m.timelineSec, title: m.title })) },
        options.abortSignal,
      )

      return textResult({
        assetId: args.asset_id,
        mediaId: asset.mediaId,
        provider: provider.id,
        routingReason,
        granularity,
        timebase: placement ? 'timeline' : 'source',
        insertedCount: insert.insertedCount,
        chapters: mapped.map((m) => ({
          timestampSec: m.timelineSec,
          timestampLabel: formatTimecode(m.timelineSec),
          title: m.title,
        })),
      })
    },
  )
}

function textResult(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  }
}
