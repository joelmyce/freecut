import type { ProviderContext } from '../types.ts'
import type { TtsInput, TtsProvider, TtsResult } from './types.ts'

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io/v1/text-to-speech'
/**
 * ElevenLabs' multilingual v2 — the docs' documented default. Good balance
 * of quality / latency / cost vs `eleven_turbo_v2_5` (cheaper, lower quality)
 * or `eleven_v3` (newer, higher cost). Override via the tool's `model` arg.
 */
const DEFAULT_MODEL = 'eleven_multilingual_v2'
/**
 * 128 kbps mp3 @ 44.1 kHz — the docs' default `output_format`. Browser
 * decodes it via the existing media import pipeline. Switch to a wav
 * format if a future caller needs raw PCM.
 */
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128'
/**
 * "Rachel" — ElevenLabs' canonical free-tier sample voice id. Used as the
 * default voice when the agent doesn't pass `voice_id`. Any consumer who
 * actually cares about the voice will pass an explicit id.
 */
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'

interface ElevenLabsRequestBody {
  text: string
  model_id: string
  voice_settings?: {
    stability?: number
    similarity_boost?: number
    style?: number
    use_speaker_boost?: boolean
  }
}

export interface ElevenLabsTtsProviderOptions {
  apiKey: string | undefined
  defaultModel?: string
  defaultVoiceId?: string
  defaultOutputFormat?: string
  fetchImpl?: typeof fetch
  /** Override the base URL — used by tests with a mock server. */
  baseUrl?: string
}

/**
 * ElevenLabs cloud TTS provider.
 *
 * - Auth: `xi-api-key` header (NOT `Authorization`).
 * - Endpoint: `POST /v1/text-to-speech/{voice_id}?output_format=...`
 * - Body: `{ text, model_id, voice_settings? }`
 * - Response: binary audio bytes (Content-Type depends on `output_format`).
 *
 * Validated against
 * https://elevenlabs.io/docs/api-reference/text-to-speech/convert on
 * 2026-05-28. If a future request shape change matters, re-check before
 * inferring.
 */
export class ElevenLabsTtsProvider implements TtsProvider {
  readonly id = 'elevenlabs' as const
  private readonly apiKey: string | undefined
  private readonly defaultModel: string
  private readonly defaultVoiceId: string
  private readonly defaultOutputFormat: string
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string

  constructor(options: ElevenLabsTtsProviderOptions) {
    const trimmed = options.apiKey?.trim()
    this.apiKey = trimmed && trimmed.length > 0 ? trimmed : undefined
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL
    this.defaultVoiceId = options.defaultVoiceId ?? DEFAULT_VOICE_ID
    this.defaultOutputFormat = options.defaultOutputFormat ?? DEFAULT_OUTPUT_FORMAT
    this.fetchImpl = options.fetchImpl ?? fetch
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey)
  }

  async synthesize(input: TtsInput, ctx: ProviderContext): Promise<TtsResult> {
    if (!this.apiKey) {
      throw new Error('ElevenLabs provider requires ELEVENLABS_API_KEY')
    }
    const text = input.text.trim()
    if (text.length === 0) {
      throw new Error('ElevenLabs synthesize requires non-empty text')
    }

    const voiceId = input.voiceId.trim().length > 0 ? input.voiceId : this.defaultVoiceId
    const model = input.model ?? this.defaultModel

    const body: ElevenLabsRequestBody = { text, model_id: model }
    const url = `${this.baseUrl}/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(this.defaultOutputFormat)}`

    ctx.onProgress?.({ stage: 'synthesizing' })
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify(body),
      signal: ctx.signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const suffix = detail ? ` — ${detail.slice(0, 500)}` : ''
      throw new Error(`ElevenLabs synthesize failed: ${res.status} ${res.statusText}${suffix}`)
    }

    const arrayBuffer = await res.arrayBuffer()
    const audioBytesBase64 = Buffer.from(arrayBuffer).toString('base64')
    const mimeType = mimeTypeForOutputFormat(this.defaultOutputFormat)

    return {
      audioBytesBase64,
      mimeType,
      // ElevenLabs doesn't return duration inline — the browser recomputes
      // after decode via mediaProcessorService. 0 is our "unknown" sentinel.
      durationSec: 0,
      modelUsed: model,
    }
  }
}

function mimeTypeForOutputFormat(format: string): string {
  if (format.startsWith('mp3_')) return 'audio/mpeg'
  if (format.startsWith('opus_')) return 'audio/ogg'
  if (format.startsWith('pcm_')) return 'audio/wav'
  if (format.startsWith('wav_')) return 'audio/wav'
  return 'audio/mpeg'
}
