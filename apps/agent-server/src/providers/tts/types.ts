import type { ProviderContext } from '../types.ts'

export type TtsProviderId = 'kokoro' | 'elevenlabs'

export type TtsStrategy = 'auto' | 'kokoro' | 'elevenlabs'

export interface TtsInput {
  /** Text to speak. */
  text: string
  /** Provider-specific voice id. The tool fills in a sensible default per provider. */
  voiceId: string
  /** Playback speed multiplier (1.0 = normal). Not all providers honor this. */
  speed?: number
  /** Provider-specific model id. */
  model?: string
}

export interface TtsResult {
  /** Synthesized audio bytes encoded as base64 — sent to the browser as-is. */
  audioBytesBase64: string
  /**
   * MIME type for the bytes. `audio/wav` for kokoro (raw PCM-in-WAV from the
   * runtime), `audio/mpeg` for ElevenLabs' default mp3 output, etc.
   */
  mimeType: string
  /**
   * Duration of the audio in seconds. Kokoro reports the real number from
   * the inference pipeline; ElevenLabs doesn't return it inline (the browser
   * recomputes after decode), so 0 is a valid "unknown" sentinel.
   */
  durationSec: number
  /** The provider's actual model id used (after defaulting). */
  modelUsed: string
}

export interface TtsProvider {
  readonly id: TtsProviderId
  isAvailable(): boolean
  synthesize(input: TtsInput, ctx: ProviderContext): Promise<TtsResult>
}
