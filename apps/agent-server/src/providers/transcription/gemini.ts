import type { ProviderContext } from '../types.ts'
import type { Transcript, TranscriptionInput, TranscriptionProvider } from './types.ts'

const GEMINI_GENERATE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'

const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash'

interface AudioPayload {
  bytes: string
  filename: string
  mimeType: string
}

/**
 * Schema we ask Gemini to produce — keeps the response in the same shape
 * as the Whisper providers (text + per-segment timestamps) so the
 * `save-transcript` browser handler can persist it without branching.
 */
const TRANSCRIPT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    language: { type: 'string' },
    durationSec: { type: 'number' },
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          start: { type: 'number' },
          end: { type: 'number' },
        },
        required: ['text', 'start', 'end'],
      },
    },
  },
  required: ['text', 'segments'],
} as const

interface GeminiTranscriptResponse {
  text: string
  language?: string
  durationSec?: number
  segments: Array<{ text: string; start: number; end: number }>
}

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>
    }
    finishReason?: string
  }>
  promptFeedback?: { blockReason?: string }
}

export interface GeminiTranscriptionProviderOptions {
  apiKey: string | undefined
  model?: string
  fetchImpl?: typeof fetch
  /** Override the generate URL template — used by tests with a mock server. */
  generateUrlTemplate?: string
}

/**
 * Gemini 3.5 Flash transcription provider (§6.5.4). Multimodal generate API
 * with structured JSON output — we ask the model to transcribe the audio
 * bytes and return the same shape Whisper uses (text + segment timestamps).
 *
 * **Opt-in only.** The router never routes to Gemini under `auto`; the
 * user has to say `provider: 'gemini'` (or "transcribe X using gemini")
 * for this provider to engage. That mirrors the design decision in
 * PHASE-1-PLAN.md §6.5.4 — Gemini is a tool the user reaches for, not
 * a stealth default.
 *
 * **Audio handling:** sends inline base64 bytes in the request body. Per
 * Google's docs, inline audio is capped at ~20MB total request size. For
 * longer clips we'd need the File API uploading flow; deferred until we
 * see a long-form clip in the wild. The browser already converts to a
 * WAV-or-similar container via `read-transcribable-audio`, which is what
 * Gemini accepts.
 */
export class GeminiTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'gemini-flash' as const
  private readonly apiKey: string | undefined
  private readonly model: string
  private readonly fetchImpl: typeof fetch
  private readonly generateUrlTemplate: string

  constructor(options: GeminiTranscriptionProviderOptions) {
    const trimmed = options.apiKey?.trim()
    this.apiKey = trimmed && trimmed.length > 0 ? trimmed : undefined
    this.model = options.model ?? DEFAULT_GEMINI_MODEL
    this.fetchImpl = options.fetchImpl ?? fetch
    this.generateUrlTemplate = options.generateUrlTemplate ?? GEMINI_GENERATE_URL
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey)
  }

  async transcribe(input: TranscriptionInput, ctx: ProviderContext): Promise<Transcript> {
    if (!this.apiKey) {
      throw new Error('Gemini transcription provider requires GEMINI_API_KEY')
    }

    ctx.onProgress?.({ stage: 'fetching-audio' })
    const audio = await ctx.bridge.invokeBrowserAction<AudioPayload>(
      'read-transcribable-audio',
      { mediaId: input.assetId },
      ctx.signal,
    )

    const model = input.model ?? this.model
    const url = this.generateUrlTemplate.replace('{model}', model)

    ctx.onProgress?.({ stage: 'transcribing' })
    const requestBody = {
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: audio.mimeType,
                data: audio.bytes,
              },
            },
            {
              text: buildTranscriptionPrompt(input.language),
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: TRANSCRIPT_RESPONSE_SCHEMA,
        // Transcription is a deterministic task; low temperature avoids
        // creative paraphrasing of what's actually said.
        temperature: 0,
      },
    }

    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify(requestBody),
      signal: ctx.signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const suffix = detail ? ` — ${detail.slice(0, 500)}` : ''
      throw new Error(`Gemini transcription failed: ${res.status} ${res.statusText}${suffix}`)
    }

    const json = (await res.json()) as GeminiGenerateResponse
    const text = extractResponseText(json)
    if (!text) {
      const blockReason = json.promptFeedback?.blockReason
      throw new Error(
        blockReason
          ? `Gemini blocked the request: ${blockReason}`
          : 'Gemini returned no text content',
      )
    }
    const parsed = parseGeminiTranscript(text)

    const transcript: Transcript = {
      text: parsed.text,
      language: parsed.language ?? input.language,
      durationSec: parsed.durationSec ?? parsed.segments.at(-1)?.end ?? 0,
      segments: parsed.segments.map((s) => ({
        text: s.text.trim(),
        start: s.start,
        end: s.end,
      })),
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

function buildTranscriptionPrompt(language: string | undefined): string {
  const langHint = language
    ? `The audio is in ${language}. Transcribe in that language.`
    : 'Detect the spoken language and transcribe in it; set the `language` field to the ISO 639-1 code.'
  return [
    'Transcribe the attached audio precisely. Preserve sentence boundaries.',
    langHint,
    'Return JSON matching the provided schema: an overall `text` plus per-segment timestamps.',
    'Segment boundaries should fall on natural pauses (sentence ends, breath breaks). Aim for 2-8 seconds per segment.',
    'Do NOT add commentary, summaries, or speaker labels — only the words spoken, with timestamps in seconds.',
  ].join(' ')
}

function extractResponseText(response: GeminiGenerateResponse): string | undefined {
  const parts = response.candidates?.[0]?.content?.parts
  if (!parts || parts.length === 0) return undefined
  const combined = parts
    .map((p) => p.text ?? '')
    .filter((t) => t.length > 0)
    .join('')
  return combined.length > 0 ? combined : undefined
}

function parseGeminiTranscript(rawJson: string): GeminiTranscriptResponse {
  try {
    const parsed = JSON.parse(rawJson) as GeminiTranscriptResponse
    if (typeof parsed.text !== 'string' || !Array.isArray(parsed.segments)) {
      throw new Error('missing required fields')
    }
    return parsed
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Gemini response was not valid transcript JSON: ${msg}`)
  }
}
