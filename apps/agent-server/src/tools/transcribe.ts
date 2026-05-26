import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import { pickTranscriptionProvider } from '../providers/transcription/index.ts'

export interface CreateTranscribeToolOptions {
  bridge: BrowserActionBridge
  providers: ProvidersBundle
  abortSignal: AbortSignal
}

const inputSchema = {
  asset_id: z
    .string()
    .describe(
      'The mediaId of the clip to transcribe. Pull this from the timeline summary — every clip cell shows its id in parentheses (e.g. "(clip_a8)"). For video/audio items the mediaId IS the asset id.',
    ),
  provider: z
    .enum(['auto', 'local', 'openai'])
    .optional()
    .describe(
      'Which provider to use. "auto" (default) picks local for clips under 30 minutes and OpenAI for longer clips when OPENAI_API_KEY is set. Force "local" for browser-side whisper or "openai" for the cloud API.',
    ),
  language: z
    .string()
    .optional()
    .describe('Optional ISO language code (e.g. "en", "es", "ja"). Omit to auto-detect.'),
}

export function createTranscribeTool(options: CreateTranscribeToolOptions) {
  return tool(
    'transcribe',
    'Transcribe a video or audio clip and save the transcript to the workspace. Does NOT modify the timeline. Returns segment count, duration, and which provider was used.',
    inputSchema,
    async (args) => {
      const strategy = args.provider ?? 'auto'
      const { provider, reason } = pickTranscriptionProvider(
        options.providers.transcription,
        strategy,
        { assetId: args.asset_id, language: args.language },
      )

      const transcript = await provider.transcribe(
        { assetId: args.asset_id, language: args.language },
        {
          bridge: options.bridge,
          signal: options.abortSignal,
        },
      )

      const result = {
        transcriptId: args.asset_id,
        segmentCount: transcript.segments.length,
        durationSec: transcript.durationSec,
        provider: provider.id,
        routingReason: reason,
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      }
    },
  )
}
