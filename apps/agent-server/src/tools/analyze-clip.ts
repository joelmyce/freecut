import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import { pickAnalysisProvider } from '../providers/analysis/index.ts'
import type { AnalysisStrategy } from '../providers/analysis/index.ts'

export interface CreateAnalyzeClipToolOptions {
  bridge: BrowserActionBridge
  providers: ProvidersBundle
  abortSignal: AbortSignal
}

const inputSchema = {
  clip_id: z
    .string()
    .describe(
      'The bare uuid of the timeline clip to analyze. The timeline summary tags clips as "(item:XYZ)" / "(media:XYZ)" — pass JUST the XYZ part, with no "item:" or "media:" prefix. Example: from "(item:89e1fd27-...)" pass "89e1fd27-...". A raw media id (without prefix) also works for source-media-only analysis.',
    ),
  focus: z
    .enum(['visual', 'mood', 'audio', 'all'])
    .optional()
    .describe(
      'Which aspect of the clip to emphasize. Defaults to "all". Use "visual" when about to call generate_broll for matching composition; "mood" for tone-matching b-roll or music suggestions; "audio" when the user is asking about what is said or sounded.',
    ),
  start_seconds: z
    .number()
    .optional()
    .describe(
      'Optional start of a sub-window inside the clip (in seconds, project-time). Pass this together with end_seconds when the user is asking about a specific moment of the clip. Gemini sees the whole clip but is told this window is the focus.',
    ),
  end_seconds: z
    .number()
    .optional()
    .describe('End of the sub-window in seconds. Pair with start_seconds.'),
  provider: z
    .enum(['auto', 'gemini'])
    .optional()
    .describe(
      'Which analysis provider to use. Defaults to "auto" which routes to Gemini (the only available analysis provider today). Unlike transcription, Gemini IS the default for analysis — there is no local alternative that does temporal + audio + visual joint understanding.',
    ),
}

/**
 * `analyze_clip` — Gemini video analysis (M4.6). Read-only side effects:
 * the tool does NOT mutate the timeline. Use BEFORE `generate_broll` when
 * the user is asking for visually matched b-roll ("add b-roll that fits
 * the vibe", "match what's playing", "matching mood", etc).
 *
 * The result includes 3 ready-to-paste b-roll prompts in
 * `suggestedBrollPrompts`. The agent can pick one verbatim or compose its
 * own using `visualDescription` + `mood` + `lighting` + `cameraMovement`.
 */
export function createAnalyzeClipTool(options: CreateAnalyzeClipToolOptions) {
  return tool(
    'analyze_clip',
    'Analyze a video clip using Gemini multimodal: returns structured JSON describing visualDescription, mood, lighting, colorPalette, cameraMovement, subject, audioSummary, pace, and 3 suggested b-roll prompts that visually match the clip. Read-only — does NOT modify the timeline. Use BEFORE generate_broll when the user wants b-roll that matches existing content ("add b-roll that fits the vibe", "match this mood", "feels like what is playing").',
    inputSchema,
    async (args) => {
      if ((args.start_seconds !== undefined) !== (args.end_seconds !== undefined)) {
        throw new Error(
          'analyze_clip: pass start_seconds and end_seconds together, or neither — partial ranges are not supported',
        )
      }
      if (
        args.start_seconds !== undefined &&
        args.end_seconds !== undefined &&
        args.end_seconds <= args.start_seconds
      ) {
        throw new Error(
          `analyze_clip: end_seconds (${args.end_seconds}) must be greater than start_seconds (${args.start_seconds})`,
        )
      }

      const strategy: AnalysisStrategy = args.provider ?? 'auto'
      const { provider, reason } = pickAnalysisProvider(options.providers.analysis, strategy, {
        clipId: args.clip_id,
      })

      const result = await provider.analyze(
        {
          clipId: args.clip_id,
          focus: args.focus ?? 'all',
          startSeconds: args.start_seconds,
          endSeconds: args.end_seconds,
        },
        {
          bridge: options.bridge,
          signal: options.abortSignal,
        },
      )

      const payload = {
        clipId: args.clip_id,
        focus: args.focus ?? 'all',
        provider: provider.id,
        routingReason: reason,
        focusRange:
          args.start_seconds !== undefined && args.end_seconds !== undefined
            ? { startSeconds: args.start_seconds, endSeconds: args.end_seconds }
            : null,
        analysis: result,
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(payload, null, 2),
          },
        ],
      }
    },
  )
}
