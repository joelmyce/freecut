import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { BrowserActionBridge } from '../providers/index.ts'

export interface CreateCutSilenceToolOptions {
  bridge: BrowserActionBridge
  abortSignal: AbortSignal
}

interface CutSilenceActionResult {
  silenceRangeCount: number
  removedDurationSec: number
  splitCount: number
  removedItemCount: number
  thresholdDb: number
  minSilenceSec: number
}

const inputSchema = {
  clip_id: z
    .string()
    .describe(
      'The item id of the video or audio clip to cut silences from. Pull from a "(item:XYZ)" tag in the timeline summary (omit the "item:" prefix). Must be a video or audio clip — captions and shapes are not supported.',
    ),
  threshold_db: z
    .number()
    .optional()
    .describe(
      'Silence threshold in dBFS. Audio below this level is considered silence. Defaults to -45. Use -50 for noisier recordings, -30 for very clean studio audio.',
    ),
  min_silence_sec: z
    .number()
    .optional()
    .describe(
      'Minimum silence duration (seconds) before a range is cut. Defaults to 0.5. Shorter values are more aggressive but can chop natural pauses.',
    ),
  padding_ms: z
    .number()
    .optional()
    .describe(
      'Milliseconds of padding kept on each side of a detected silence to avoid clipping the start/end of speech. Defaults to 100.',
    ),
}

export function createCutSilenceTool(options: CreateCutSilenceToolOptions) {
  return tool(
    'cut_silence',
    'Detect and remove silent ranges from a video or audio clip on the timeline. RMS analysis runs locally in the browser — no remote API call, no cost. Splits the clip at every silence boundary, removes the dead segments, ripples the trailing items, and partitions any subtitle cues to stay aligned. Single Ctrl+Z restores everything. Returns the count and total seconds of silence removed.',
    inputSchema,
    async (args) => {
      const result = await options.bridge.invokeBrowserAction<CutSilenceActionResult>(
        'cut-silence',
        {
          clipId: args.clip_id,
          thresholdDb: args.threshold_db,
          minSilenceSec: args.min_silence_sec,
          paddingMs: args.padding_ms,
        },
        options.abortSignal,
      )
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                clipId: args.clip_id,
                ...result,
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
