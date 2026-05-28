import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import { pickTtsProvider, type TtsStrategy } from '../providers/tts/index.ts'

export interface CreateGenerateVoiceoverToolOptions {
  bridge: BrowserActionBridge
  providers: ProvidersBundle
  abortSignal: AbortSignal
}

interface InsertVoiceoverResult {
  clipId: string
  mediaId: string
  trackId: string
  from: number
  durationInFrames: number
  durationSec: number
}

/** Kokoro's most natural-sounding US-English female voice (per kokoro-tts-service voice options). */
const KOKORO_VOICE_DEFAULT = 'af_heart'
/** ElevenLabs' canonical "Rachel" sample voice — works on free tier and reads as a neutral US-English female. */
const ELEVENLABS_VOICE_DEFAULT = '21m00Tcm4TlvDq8ikWAM'

const inputSchema = {
  text: z
    .string()
    .min(1)
    .describe(
      'The text the voice should speak. Punctuation and sentence breaks are honored — write it the way you want it read aloud. Long text (multiple paragraphs) is fine; both providers chunk internally.',
    ),
  voice_id: z
    .string()
    .optional()
    .describe(
      'Provider-specific voice id. Kokoro voices look like "af_heart" (US F), "am_michael" (US M), "bf_emma" (UK F). ElevenLabs voices are 20-char ids like "21m00Tcm4TlvDq8ikWAM" (Rachel). Defaults: "af_heart" for kokoro, "21m00Tcm4TlvDq8ikWAM" (Rachel) for elevenlabs. Omit unless the user names a voice.',
    ),
  provider: z
    .enum(['auto', 'kokoro', 'elevenlabs'])
    .optional()
    .describe(
      '"auto" (default) prefers local Kokoro — free, runs on WebGPU in the browser, ~1-3s. "kokoro" forces local. "elevenlabs" forces the cloud API (requires ELEVENLABS_API_KEY) — pick this when the user explicitly asks for ElevenLabs, names an ElevenLabs voice id, or wants "studio quality" / "more natural" narration.',
    ),
  model: z
    .string()
    .optional()
    .describe(
      'Provider-specific model id. Kokoro: "fp32" (default, best quality). ElevenLabs: "eleven_multilingual_v2" (default), "eleven_turbo_v2_5" (faster, cheaper), "eleven_v3" (newest). Override only when the user names a model.',
    ),
  speed: z
    .number()
    .min(0.5)
    .max(2.0)
    .optional()
    .describe(
      'Playback speed multiplier (1.0 = normal). Kokoro honors 0.5-2.0; ElevenLabs ignores it (set speaking pace via voice_settings on a future arg). Default 1.0.',
    ),
  insert_at_seconds: z
    .number()
    .min(0)
    .optional()
    .describe(
      'Start position on the project timeline, in seconds from project zero. Defaults to the current playhead position (resolved by the browser handler if omitted).',
    ),
  track_id: z
    .string()
    .optional()
    .describe(
      'Optional explicit audio track id. Omit to find or create one automatically — the handler picks the lowest-order existing audio track, or creates a new "Voiceover" track below all existing ones if none is compatible.',
    ),
}

/**
 * `generate_voiceover` — synthesize speech from text and drop it on the
 * timeline as an audio clip (M5, see PHASE-1-PLAN.md §6.4).
 *
 * **Two provider paths:**
 *   - **Kokoro** (default, local, free): delegates to the browser's
 *     existing `kokoroTtsService` via the `synthesize-voiceover-local`
 *     bridge action. Kokoro v1.0 ONNX runs on WebGPU; returns WAV bytes.
 *   - **ElevenLabs** (cloud, paid): direct `POST /v1/text-to-speech/{voice_id}`
 *     with `xi-api-key` auth. Returns mp3 bytes.
 *
 * Either way, the audio is base64-shipped to the browser via the
 * `insert-voiceover` bridge action, which: imports it via
 * `mediaLibraryService.importGeneratedAudio`, marks the media
 * `aiGenerated`, writes a `generation.json` envelope, and inserts an
 * `AudioItem` on a compatible audio track (creating one if needed).
 *
 * **No placeholder pattern** — unlike `generate_broll` / `generate_image`,
 * voiceover duration is unknown until after synthesis (the input is text,
 * not a time range). Synthesis is fast enough (~1-5s) that a placeholder
 * window would either be wrong (estimated) or pointless (post-hoc). The
 * insert lands as a single `ADD_ITEM` undo entry; Ctrl+Z removes it.
 */
export function createGenerateVoiceoverTool(options: CreateGenerateVoiceoverToolOptions) {
  return tool(
    'generate_voiceover',
    'Synthesize speech from text via local Kokoro (default — free, ~1-3s on WebGPU) or ElevenLabs cloud (paid, needs ELEVENLABS_API_KEY). Drops the audio onto the timeline as an audio clip at insert_at_seconds (defaults to the playhead). Use for narration, voiceover, scripted reads — "say X here", "add a voiceover saying X", "narrate this section". Single Ctrl+Z removes the inserted clip.',
    inputSchema,
    async (args) => {
      const text = args.text.trim()
      if (text.length === 0) {
        throw new Error('text must not be empty')
      }

      const strategy: TtsStrategy = args.provider ?? 'auto'
      const { provider, reason: routingReason } = pickTtsProvider(options.providers.tts, strategy)

      const voiceId =
        args.voice_id ??
        (provider.id === 'kokoro' ? KOKORO_VOICE_DEFAULT : ELEVENLABS_VOICE_DEFAULT)

      const result = await provider.synthesize(
        { text, voiceId, speed: args.speed, model: args.model },
        { bridge: options.bridge, signal: options.abortSignal },
      )

      const insertResult = await options.bridge.invokeBrowserAction<InsertVoiceoverResult>(
        'insert-voiceover',
        {
          audioBytesBase64: result.audioBytesBase64,
          mimeType: result.mimeType,
          durationSec: result.durationSec,
          text,
          voiceId,
          providerId: provider.id,
          modelUsed: result.modelUsed,
          insertAtSeconds: args.insert_at_seconds,
          trackId: args.track_id,
        },
        options.abortSignal,
      )

      const payload = {
        clipId: insertResult.clipId,
        mediaId: insertResult.mediaId,
        trackId: insertResult.trackId,
        durationSec: insertResult.durationSec,
        providerUsed: provider.id,
        modelUsed: result.modelUsed,
        voiceId,
        routingReason,
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
      }
    },
  )
}
