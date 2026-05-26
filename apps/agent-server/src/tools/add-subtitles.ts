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
      'When true, removes any existing auto-generated transcript captions for this clip before inserting fresh ones. Use this when re-running after a re-transcribe.',
    ),
}

export function createAddSubtitlesTool(options: CreateAddSubtitlesToolOptions) {
  return tool(
    'add_subtitles',
    'Insert the saved transcript for a clip as a caption track on the timeline. Auto-creates a caption track above the clip if needed; one Ctrl+Z removes the whole insertion. Errors with "No transcript found" if transcribe has not been run yet — call transcribe first and retry.',
    inputSchema,
    async (args) => {
      const result = await options.bridge.invokeBrowserAction<AddSubtitlesActionResult>(
        'add-subtitles',
        {
          mediaId: args.asset_id,
          replaceExisting: args.replace_existing,
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
