import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { BrowserActionBridge } from '../providers/index.ts'

export interface CreateAddSubtitlesToolOptions {
  bridge: BrowserActionBridge
  abortSignal: AbortSignal
}

interface AddSubtitlesActionResult {
  insertedItemCount: number
  removedItemCount: number
  hasWordTimestamps: boolean
}

const inputSchema = {
  asset_id: z
    .string()
    .describe(
      'The mediaId of the clip whose transcript should be inserted as a caption track. Pull from a "media:XYZ" tag in the timeline summary (omit the "media:" prefix). The clip must already have a saved transcript — if not, call transcribe first.',
    ),
  replace_existing: z
    .boolean()
    .optional()
    .describe(
      'When true, removes any existing auto-generated transcript captions for this clip before inserting fresh ones. Use this when re-running after a re-transcribe, or when changing style / highlight color.',
    ),
  style: z
    .enum(['standard', 'karaoke'])
    .optional()
    .describe(
      'Caption playback style. **Defaults to "karaoke"** — every word lights up as it is spoken (driven by Whisper word timestamps). Pass "standard" ONLY when the user explicitly asks for classic per-segment captions ("plain captions", "static captions", "no per-word highlight"). When the saved transcript has only segment-level timing, the renderer silently falls back to standard cues even in karaoke mode — surfaced via hasWordTimestamps in the result.',
    ),
  highlight_color: z
    .string()
    .optional()
    .describe(
      'CSS color (hex like "#FF00FF" or named like "cyan") for the active word in karaoke mode. Defaults to "#FFD700" (gold). Pass when the user picks one ("highlight in cyan", "use purple words"). Ignored when style is "standard".',
    ),
  words_per_cue: z
    .number()
    .int()
    .min(1)
    .max(15)
    .optional()
    .describe(
      'Maximum words on screen at once in karaoke mode. Defaults to 3 (modern Submagic/Captions.app feel — small chunks that advance as you speak). Pass 1 for the most dramatic one-word-stamp ("one word at a time", "stamp each word"). Pass 5+ for more readable per-line captions ("5 words at a time", "more readable", "longer phrases"). Ignored when style is "standard" or the transcript has no word timestamps.',
    ),
}

/**
 * `add_subtitles` — drop the saved transcript onto the timeline as a
 * caption track (M2 + M5.1 default-to-karaoke). Auto-creates a caption
 * track above the clip if needed; one Ctrl+Z removes the insertion.
 *
 * Style default flipped to karaoke (M5.1): every insert highlights the
 * spoken word using Whisper's word timestamps, with graceful fallback
 * to standard cue display when word timing isn't in the transcript.
 * Returns `hasWordTimestamps` so the agent can tell the user when the
 * karaoke effect won't animate.
 */
export function createAddSubtitlesTool(options: CreateAddSubtitlesToolOptions) {
  return tool(
    'add_subtitles',
    'Insert the saved transcript for a clip as a caption track. KARAOKE BY DEFAULT — each word highlights as it is spoken (Whisper word timestamps). Pass style:"standard" only when the user explicitly asks for classic per-segment captions. Auto-creates a caption track above the clip; one Ctrl+Z removes the insertion. Returns hasWordTimestamps so you know whether the highlight will animate. Errors with "No transcript found" if transcribe has not been run yet — call transcribe first and retry.',
    inputSchema,
    async (args) => {
      const result = await options.bridge.invokeBrowserAction<AddSubtitlesActionResult>(
        'add-subtitles',
        {
          mediaId: args.asset_id,
          replaceExisting: args.replace_existing,
          style: args.style,
          karaokeHighlightColor: args.highlight_color,
          wordsPerCue: args.words_per_cue,
        },
        options.abortSignal,
      )
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                mediaId: args.asset_id,
                insertedItemCount: result.insertedItemCount,
                removedItemCount: result.removedItemCount,
                hasWordTimestamps: result.hasWordTimestamps,
                style: args.style ?? 'karaoke',
                highlightColor: args.highlight_color ?? '#FFD700',
                wordsPerCue: args.words_per_cue ?? 3,
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )
}
