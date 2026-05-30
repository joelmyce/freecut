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
    .enum(['auto', 'local', 'openai', 'gemini'])
    .optional()
    .describe(
      'Which provider to use. "auto" (default) ALWAYS uses the local in-browser Whisper — it gives the best results on real content (including non-English) and never sends audio to the cloud. "openai" (OpenAI Whisper) and "gemini" (Gemini 3.5 Flash) are BOTH opt-in only and are never picked by auto. Engage them ONLY when the user explicitly names one ("transcribe X using openai" / "...using gemini"). OpenAI needs OPENAI_API_KEY; Gemini needs GEMINI_API_KEY.',
    ),
  language: z
    .string()
    .optional()
    .describe(
      'Optional ISO language code (e.g. "en", "es", "ja"). **Omit by default** — Whisper auto-detects the source language and preserves it (the transcript stays in the original language). Only pass a code when the user EXPLICITLY names a target language ("transcribe in Spanish", "force English"). Never pass "en" as a defensive default — that would force English output even on a Spanish or Japanese clip.',
    ),
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
