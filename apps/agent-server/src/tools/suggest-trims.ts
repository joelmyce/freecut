import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import { pickTranscriptReasoningProvider } from '../providers/analysis/index.ts'
import type {
  ReasoningTranscript,
  TranscriptReasoningStrategy,
} from '../providers/analysis/index.ts'
import { formatTimecode } from './timecode.ts'
import { padTrimsInward, snapTrimsToWordBoundaries } from './trim-word-snap.ts'

/**
 * After aligning cuts to word edges, pull each edge this far INWARD so the cut
 * stays clear of the bordering words' audio even when the word timestamps are
 * imprecise (quiet recordings, small Whisper models). The robust guard against
 * the "regreso cua—" clipping; pairs with the junction audio fade.
 *
 * Measured on quiet Spanish whisper-small audio, the word-END timestamp lands
 * ~0.3s early ("cuando" → "cua—" survived 0.12s of padding), so 0.12 was too
 * small. 0.25 covers most of that error. This is the transcriber-agnostic
 * stopgap; the real fix is sharper timings from server-side OpenAI Whisper
 * (M6 follow-up "b"), since a margin big enough to cover a ~0.3s error also
 * over-shrinks short cuts.
 */
const TRIM_SAFETY_MARGIN_SEC = 0.25

export interface CreateSuggestTrimsToolOptions {
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

interface ApplyTrimsResult {
  removedItemCount: number
  splitCount: number
  analyzedItemCount: number
}

interface DisplayTrim {
  startSec: number
  endSec: number
  tlStart: number
  tlEnd: number
  durationSec: number
  reason: string
}

const inputSchema = {
  clip_id: z
    .string()
    .describe(
      'The placed timeline clip to tighten — pass the bare uuid from an (item:XYZ) tag. suggest_trims cuts THIS clip, so it needs a clip on the timeline, not a media id.',
    ),
  goal: z
    .string()
    .optional()
    .describe(
      'Optional steer for what to cut — "tighten to about 2 minutes", "remove the rambling intro", "cut dead air". Omit for a general tightening pass.',
    ),
  max_trims: z.number().optional().describe('Soft cap on how many cuts to propose. Default 5.'),
  provider: z
    .enum(['auto', 'gemini'])
    .optional()
    .describe(
      'Analysis provider. Defaults to "auto" → Gemini (the only transcript-reasoning backend).',
    ),
}

/**
 * `suggest_trims` — M6 tool #3. Proposes tightening cuts for a clip and applies
 * them ONLY after the user approves. **Side effects: mutate** (cuts the clip),
 * but gated and in a single undo entry.
 *
 * Composition (transcript-first; reuses find_moment's read path + M5.2's gate):
 *   1. read-asset-transcript (browser, read-only) → transcript + placement.
 *   2. provider.suggestTrims (Gemini text reasoning) → removable spans + reasons.
 *   3. bridge.requestConfirmation (M5.2) → a card listing the cuts + time saved.
 *      The gate generalizes from *spend* approval to *decision* approval: a
 *      Reject makes ZERO timeline change. Skipped only when the bridge has no
 *      confirmation channel (unit tests).
 *   4. apply-trims (browser, mutating) → removes the spans via
 *      removeTrimRangesFromItems in ONE undo entry (captions stay aligned).
 *
 * Requires a saved transcript (errors recoverably → transcribe first) and a
 * placed clip (an item id, not a media id).
 */
export function createSuggestTrimsTool(options: CreateSuggestTrimsToolOptions) {
  return tool(
    'suggest_trims',
    'Propose tightening cuts for a clip and apply them AFTER the user approves. Use for "this clip is too long", "tighten this", "cut the dead air / rambling / filler", "make it punchier", "trim the boring parts". Reads the saved transcript, finds removable spans (long pauses, rambling, repetition, false starts) each with a reason, and shows an approval card listing the cuts + total time saved. APPROVAL GATE: nothing is cut until the user approves — if they Reject, the clip is untouched and the result is status:"declined" (do not retry unless asked). On approve it removes the spans in ONE step (a single Ctrl+Z restores the clip) and keeps captions aligned. Requires a saved transcript (on "no transcript", transcribe first and retry) and a clip placed on the timeline (pass an item:XYZ id, not a media id). Returns status:"no-trims" when the clip is already tight. This MUTATES the timeline (cuts the clip) — but only after approval.',
    inputSchema,
    async (args) => {
      const strategy: TranscriptReasoningStrategy = args.provider ?? 'auto'
      const { provider, reason: routingReason } = pickTranscriptReasoningProvider(
        options.providers.transcriptReasoning ?? [],
        strategy,
      )

      const asset = await options.bridge.invokeBrowserAction<AssetTranscriptPayload>(
        'read-asset-transcript',
        { assetId: args.clip_id },
        options.abortSignal,
      )

      if (!asset.transcript || asset.transcript.segments.length === 0) {
        throw new Error(
          `suggest_trims: no transcript saved for ${args.clip_id}. Transcribe the clip first, then call suggest_trims again.`,
        )
      }
      const placement = asset.placement
      if (!placement) {
        throw new Error(
          `suggest_trims needs a clip placed on the timeline — pass an item:XYZ id (the specific clip to cut), not a media id.`,
        )
      }

      const maxTrims = args.max_trims && args.max_trims > 0 ? Math.floor(args.max_trims) : 5
      const { trims: rawTrims } = await provider.suggestTrims(
        { transcript: asset.transcript, goal: args.goal, maxTrims },
        { bridge: options.bridge, signal: options.abortSignal },
      )

      // Snap proposed cut edges to Whisper word boundaries so a cut never lands
      // mid-word ("cuando" → "cua—"). Falls back to the raw spans when the
      // transcript has no word timings. Done BEFORE the card so the approval
      // card and the actual cut agree.
      const words = asset.transcript.segments.flatMap((s) => s.words ?? [])
      const trims = padTrimsInward(
        snapTrimsToWordBoundaries(rawTrims, words),
        TRIM_SAFETY_MARGIN_SEC,
      )

      if (trims.length === 0) {
        return textResult({
          status: 'no-trims',
          clipId: args.clip_id,
          provider: provider.id,
          routingReason,
          message: "I didn't find anything worth trimming — the clip is already tight.",
        })
      }

      const display: DisplayTrim[] = trims.map((t) => ({
        startSec: t.startSec,
        endSec: t.endSec,
        tlStart: Math.max(0, placement.fromSec + (t.startSec - placement.sourceStartSec)),
        tlEnd: Math.max(0, placement.fromSec + (t.endSec - placement.sourceStartSec)),
        durationSec: Math.max(0, t.endSec - t.startSec),
        reason: t.reason,
      }))
      const totalRemovedSec = display.reduce((sum, d) => sum + d.durationSec, 0)

      // M5.2 gate — generalized from spend approval to *decision* approval.
      // Skipped automatically when the bridge has no confirmation channel.
      if (options.bridge.requestConfirmation) {
        const decision = await options.bridge.requestConfirmation(
          {
            title: trims.length === 1 ? 'Trim 1 section?' : `Trim ${trims.length} sections?`,
            summary: `I found ${trims.length} ${trims.length === 1 ? 'stretch' : 'stretches'} to cut, saving about ${Math.round(totalRemovedSec)}s.`,
            details: display.map((d) => ({
              label: `${formatTimecode(d.tlStart)}–${formatTimecode(d.tlEnd)} (${Math.round(d.durationSec)}s)`,
              value: d.reason || 'low-content',
            })),
            approveLabel: 'Trim all',
            rejectLabel: 'Keep all',
          },
          options.abortSignal,
        )

        if (decision.decision === 'reject') {
          return textResult({
            status: 'declined',
            clipId: args.clip_id,
            provider: provider.id,
            routingReason,
            proposedTrimCount: trims.length,
            message: 'You kept the clip as-is. No trims were applied.',
          })
        }
      }

      const applied = await options.bridge.invokeBrowserAction<ApplyTrimsResult>(
        'apply-trims',
        {
          clipId: args.clip_id,
          trims: trims.map((t) => ({ startSec: t.startSec, endSec: t.endSec })),
        },
        options.abortSignal,
      )

      return textResult({
        status: 'applied',
        clipId: args.clip_id,
        provider: provider.id,
        routingReason,
        trimCount: trims.length,
        removedDurationSec: Math.round(totalRemovedSec),
        splitCount: applied.splitCount,
        removedItemCount: applied.removedItemCount,
        trims: display.map((d) => ({
          startLabel: formatTimecode(d.tlStart),
          endLabel: formatTimecode(d.tlEnd),
          durationSec: Math.round(d.durationSec),
          reason: d.reason,
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
