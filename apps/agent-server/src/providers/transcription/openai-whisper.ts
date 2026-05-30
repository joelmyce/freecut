import type { ProviderContext } from '../types.ts'
import type {
  Transcript,
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptSegment,
} from './types.ts'

const OPENAI_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions'

interface OpenAIVerboseJsonResponse {
  text: string
  language?: string
  duration?: number
  segments?: ReadonlyArray<{
    start: number
    end: number
    text: string
  }>
  /** Flat, top-level word list returned when `timestamp_granularities[]=word` is requested. */
  words?: ReadonlyArray<{
    word: string
    start: number
    end: number
  }>
}

/**
 * Browser-delivered audio bytes are base64-encoded inside the JSON bridge
 * message (WebSocket text frames only carry UTF-8, and a binary subprotocol
 * isn't worth the complexity for v1). Decoded here before the multipart POST.
 */
interface AudioPayload {
  bytes: string
  filename: string
  mimeType: string
}

export interface OpenAIWhisperProviderOptions {
  apiKey: string | undefined
  model?: string
  fetchImpl?: typeof fetch
}

/**
 * Server-side OpenAI Whisper provider. Flow:
 *   1. Ask browser for the conformed audio bytes (re-uses the existing
 *      audio-conform pipeline that already produces WAV for unsupported
 *      codecs — see media-transcription-service in the browser).
 *   2. POST multipart to /v1/audio/transcriptions with verbose_json so we
 *      get timestamps for segments.
 *   3. Send the resulting Transcript back to the browser to persist via
 *      the existing `saveTranscript()` path.
 */
export class OpenAIWhisperProvider implements TranscriptionProvider {
  readonly id = 'openai-whisper' as const
  private readonly apiKey: string | undefined
  private readonly model: string
  private readonly fetchImpl: typeof fetch

  constructor(options: OpenAIWhisperProviderOptions) {
    const trimmed = options.apiKey?.trim()
    this.apiKey = trimmed && trimmed.length > 0 ? trimmed : undefined
    this.model = options.model ?? 'whisper-1'
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey)
  }

  async transcribe(input: TranscriptionInput, ctx: ProviderContext): Promise<Transcript> {
    if (!this.apiKey) {
      throw new Error('OpenAI Whisper requires OPENAI_API_KEY')
    }

    ctx.onProgress?.({ stage: 'fetching-audio' })
    const audio = await ctx.bridge.invokeBrowserAction<AudioPayload>(
      'read-transcribable-audio',
      { mediaId: input.assetId },
      ctx.signal,
    )

    ctx.onProgress?.({ stage: 'uploading' })
    const audioBytes = Buffer.from(audio.bytes, 'base64')
    const form = new FormData()
    form.append('file', new Blob([audioBytes], { type: audio.mimeType }), audio.filename)
    form.append('model', input.model ?? this.model)
    form.append('response_format', 'verbose_json')
    // Ask for word-level timestamps (needed for trim cut-snapping + karaoke).
    // OpenAI returns these as a flat top-level `words` array beside `segments`.
    form.append('timestamp_granularities[]', 'segment')
    form.append('timestamp_granularities[]', 'word')
    if (input.language) {
      form.append('language', input.language)
    }

    ctx.onProgress?.({ stage: 'transcribing' })
    const res = await this.fetchImpl(OPENAI_TRANSCRIPTIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: ctx.signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const suffix = detail ? ` — ${detail.slice(0, 500)}` : ''
      throw new Error(`OpenAI Whisper request failed: ${res.status} ${res.statusText}${suffix}`)
    }
    const json = (await res.json()) as OpenAIVerboseJsonResponse

    const transcript: Transcript = {
      text: json.text,
      language: json.language,
      durationSec: json.duration ?? 0,
      segments: distributeWordsIntoSegments(json.segments ?? [], json.words ?? []),
    }

    ctx.onProgress?.({ stage: 'saving' })
    await ctx.bridge.invokeBrowserAction(
      'save-transcript',
      {
        mediaId: input.assetId,
        transcript,
        providerId: this.id,
      },
      ctx.signal,
    )

    return transcript
  }
}

/**
 * OpenAI returns words as a flat top-level array; attach each word to the
 * segment whose time range contains its start, so the saved transcript carries
 * per-segment word timings (consumed by suggest_trims cut-snapping + karaoke).
 * Falls back to word-less segments when no words were returned.
 */
function distributeWordsIntoSegments(
  segments: ReadonlyArray<{ start: number; end: number; text: string }>,
  words: ReadonlyArray<{ word: string; start: number; end: number }>,
): TranscriptSegment[] {
  return segments.map((segment) => {
    const segmentWords = words
      .filter((w) => w.start >= segment.start - 1e-3 && w.start < segment.end)
      .map((w) => ({ text: w.word.trim(), start: w.start, end: w.end }))
    return {
      text: segment.text.trim(),
      start: segment.start,
      end: segment.end,
      words: segmentWords.length > 0 ? segmentWords : undefined,
    }
  })
}
