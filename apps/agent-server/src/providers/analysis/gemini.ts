import type { ProviderContext } from '../types.ts'
import type {
  AnalysisFocus,
  ClipVideoPayload,
  VideoAnalysisInput,
  VideoAnalysisProvider,
  VideoAnalysisResult,
} from './types.ts'

const GEMINI_GENERATE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'
const GEMINI_FILES_UPLOAD_URL =
  'https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=media'
const GEMINI_FILES_GET_URL = 'https://generativelanguage.googleapis.com/v1beta/{name}'

const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash'

/**
 * Raw-byte threshold for choosing between inline data and the File API
 * upload path. Gemini's `generateContent` endpoint caps the whole request
 * at ~20MB; base64 inflates by ~33% so 18MB raw is the safe inline ceiling.
 * Anything above this gets uploaded via the File API and referenced as a
 * `file_data` part.
 */
const INLINE_BYTES_THRESHOLD = 18 * 1024 * 1024

/**
 * Polling tuning for the File API `state` transition. After upload, files
 * sit in `PROCESSING` for ~10-30s while Gemini extracts frames/audio.
 * generateContent will reject the file_uri with "FILE_NOT_ACTIVE" until
 * the state becomes `ACTIVE`.
 */
const FILE_POLL_INTERVAL_MS = 2_000
const FILE_POLL_MAX_ATTEMPTS = 60

/**
 * Schema we ask Gemini to produce. Keeps the response shape stable across
 * focus modes; the agent can quote any field directly into a `generate_broll`
 * prompt without further parsing.
 */
const ANALYSIS_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    visualDescription: { type: 'string' },
    mood: { type: 'string' },
    lighting: { type: 'string' },
    colorPalette: { type: 'array', items: { type: 'string' } },
    cameraMovement: { type: 'string' },
    subject: { type: 'string' },
    audioSummary: { type: 'string' },
    pace: { type: 'string' },
    suggestedBrollPrompts: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'visualDescription',
    'mood',
    'lighting',
    'colorPalette',
    'cameraMovement',
    'subject',
    'audioSummary',
    'pace',
    'suggestedBrollPrompts',
  ],
} as const

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>
    }
    finishReason?: string
  }>
  promptFeedback?: { blockReason?: string }
}

interface GeminiFile {
  name: string
  uri: string
  mimeType?: string
  state: 'PROCESSING' | 'ACTIVE' | 'FAILED' | string
}

interface GeminiFileUploadResponse {
  file?: GeminiFile
}

export interface GeminiVideoAnalysisProviderOptions {
  apiKey: string | undefined
  model?: string
  fetchImpl?: typeof fetch
  /** Override the generate URL template — used by tests with a mock server. */
  generateUrlTemplate?: string
  /** Override the File API upload URL — used by tests with a mock server. */
  filesUploadUrl?: string
  /** Override the File API get URL template — used by tests with a mock server. */
  filesGetUrlTemplate?: string
  /** Override the file-state poll interval (ms). Tests set this to 0. */
  pollIntervalMs?: number
  /** Override max poll attempts. Tests can lower this to fail fast. */
  pollMaxAttempts?: number
}

/**
 * Gemini 3.5 Flash video-analysis provider (M4.6 — see PHASE-1-PLAN.md §6.7).
 * Multimodal generate API with structured-JSON output — sends the inline
 * video bytes plus a prompt asking for the canonical analysis shape
 * (visual / mood / lighting / palette / camera / subject / audio / pace +
 * 3 candidate b-roll prompts).
 *
 * **Routing:** unlike the Gemini transcription provider this one is NOT
 * opt-in. There is no local alternative for video analysis, so the
 * router defaults to Gemini under `auto`. See AI-EDITOR-VISION.md §4.
 *
 * **Inline cap:** Gemini's generateContent endpoint caps the entire request
 * body at ~20MB. Most Kling-generated b-roll clips and short user-recorded
 * snippets fit; longer clips will need the File API upload path (deferred
 * until a real caller needs it). The browser handler does NOT trim the
 * media for v1 — it just refuses to encode anything beyond the cap, with
 * a clear error message. We rely on the model to focus on a sub-range
 * via the prompt's `focusRange` directive when one is given.
 */
export class GeminiVideoAnalysisProvider implements VideoAnalysisProvider {
  readonly id = 'gemini-flash-video' as const
  private readonly apiKey: string | undefined
  private readonly model: string
  private readonly fetchImpl: typeof fetch
  private readonly generateUrlTemplate: string
  private readonly filesUploadUrl: string
  private readonly filesGetUrlTemplate: string
  private readonly pollIntervalMs: number
  private readonly pollMaxAttempts: number

  constructor(options: GeminiVideoAnalysisProviderOptions) {
    const trimmed = options.apiKey?.trim()
    this.apiKey = trimmed && trimmed.length > 0 ? trimmed : undefined
    this.model = options.model ?? DEFAULT_GEMINI_MODEL
    this.fetchImpl = options.fetchImpl ?? fetch
    this.generateUrlTemplate = options.generateUrlTemplate ?? GEMINI_GENERATE_URL
    this.filesUploadUrl = options.filesUploadUrl ?? GEMINI_FILES_UPLOAD_URL
    this.filesGetUrlTemplate = options.filesGetUrlTemplate ?? GEMINI_FILES_GET_URL
    this.pollIntervalMs = options.pollIntervalMs ?? FILE_POLL_INTERVAL_MS
    this.pollMaxAttempts = options.pollMaxAttempts ?? FILE_POLL_MAX_ATTEMPTS
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey)
  }

  async analyze(input: VideoAnalysisInput, ctx: ProviderContext): Promise<VideoAnalysisResult> {
    if (!this.apiKey) {
      throw new Error('Gemini video analysis provider requires GEMINI_API_KEY')
    }

    ctx.onProgress?.({ stage: 'fetching-clip-bytes' })
    const payload = await ctx.bridge.invokeBrowserAction<ClipVideoPayload>(
      'read-clip-video-bytes',
      {
        clipId: input.clipId,
        startSeconds: input.startSeconds,
        endSeconds: input.endSeconds,
      },
      ctx.signal,
    )

    // Decide the upload path. base64-decoded length is the actual raw size;
    // base64 inflates the wire payload by ~33% but Gemini only counts the
    // decoded bytes against the inline cap.
    const rawByteCount = Math.floor((payload.bytes.length * 3) / 4)
    const useFileApi = rawByteCount > INLINE_BYTES_THRESHOLD

    const focus = input.focus ?? 'all'
    const promptText = buildAnalysisPrompt(focus, input.startSeconds, input.endSeconds)

    const parts: Array<Record<string, unknown>> = []
    if (useFileApi) {
      ctx.onProgress?.({ stage: 'uploading-clip' })
      const uploadedFile = await this.uploadFile(payload, ctx.signal)

      ctx.onProgress?.({ stage: 'waiting-for-processing' })
      const activeFile = await this.waitUntilActive(uploadedFile, ctx.signal)

      parts.push({
        fileData: {
          mimeType: activeFile.mimeType ?? payload.mimeType,
          fileUri: activeFile.uri,
        },
      })
    } else {
      parts.push({
        inlineData: {
          mimeType: payload.mimeType,
          data: payload.bytes,
        },
      })
    }
    parts.push({ text: promptText })

    const url = this.generateUrlTemplate.replace('{model}', this.model)

    ctx.onProgress?.({ stage: 'analyzing' })
    const requestBody = {
      contents: [{ parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: ANALYSIS_RESPONSE_SCHEMA,
        // Description tasks reward a touch of variation in the prompt
        // suggestions but the structured fields should stay grounded.
        // Low-but-not-zero temperature lands a reasonable middle.
        temperature: 0.2,
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
      throw new Error(`Gemini video analysis failed: ${res.status} ${res.statusText}${suffix}`)
    }

    const json = (await res.json()) as GeminiGenerateResponse
    const text = extractResponseText(json)
    if (!text) {
      const blockReason = json.promptFeedback?.blockReason
      throw new Error(
        blockReason
          ? `Gemini blocked the analysis request: ${blockReason}`
          : 'Gemini returned no text content for the analysis request',
      )
    }
    return parseAnalysisResponse(text)
  }

  /**
   * Upload the clip bytes to Gemini's File API. Decodes the base64 payload
   * to raw bytes and POSTs them as the request body — Gemini's "simple"
   * (non-resumable) upload form, which works for files up to ~2GB.
   */
  private async uploadFile(payload: ClipVideoPayload, signal: AbortSignal): Promise<GeminiFile> {
    if (!this.apiKey) {
      throw new Error('Gemini video analysis provider requires GEMINI_API_KEY')
    }
    const raw = Buffer.from(payload.bytes, 'base64')

    const res = await this.fetchImpl(this.filesUploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': payload.mimeType,
        'x-goog-api-key': this.apiKey,
        // Hint a friendly display name; not strictly required.
        'X-Goog-Upload-File-Name': payload.filename,
      },
      body: raw,
      signal,
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const suffix = detail ? ` — ${detail.slice(0, 500)}` : ''
      throw new Error(`Gemini File API upload failed: ${res.status} ${res.statusText}${suffix}`)
    }

    const json = (await res.json()) as GeminiFileUploadResponse
    const file = json.file
    if (!file?.uri || !file?.name) {
      throw new Error('Gemini File API upload returned no file uri / name')
    }
    return file
  }

  /**
   * Poll until the uploaded file's state becomes ACTIVE. Gemini videos
   * sit in PROCESSING for ~10-30s while the model extracts frames and
   * audio. generateContent will error if we reference an inactive file.
   */
  private async waitUntilActive(file: GeminiFile, signal: AbortSignal): Promise<GeminiFile> {
    if (!this.apiKey) {
      throw new Error('Gemini video analysis provider requires GEMINI_API_KEY')
    }
    if (file.state === 'ACTIVE') return file
    if (file.state === 'FAILED') {
      throw new Error(`Gemini File API reported state=FAILED for ${file.name}`)
    }

    const getUrl = this.filesGetUrlTemplate.replace('{name}', file.name)
    for (let attempt = 0; attempt < this.pollMaxAttempts; attempt++) {
      if (signal.aborted) throw new Error('analyze_clip aborted while waiting for file processing')

      if (this.pollIntervalMs > 0) {
        await sleep(this.pollIntervalMs, signal)
      }

      const res = await this.fetchImpl(getUrl, {
        method: 'GET',
        headers: { 'x-goog-api-key': this.apiKey },
        signal,
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        const suffix = detail ? ` — ${detail.slice(0, 500)}` : ''
        throw new Error(`Gemini File API poll failed: ${res.status} ${res.statusText}${suffix}`)
      }
      const polled = (await res.json()) as GeminiFile
      if (polled.state === 'ACTIVE') return polled
      if (polled.state === 'FAILED') {
        throw new Error(`Gemini File API processing failed for ${file.name}`)
      }
      // else still PROCESSING — loop
    }
    throw new Error(
      `Gemini File API did not reach ACTIVE state within ${(this.pollMaxAttempts * this.pollIntervalMs) / 1000}s for ${file.name}`,
    )
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    if (signal.aborted) {
      clearTimeout(timer)
      reject(new Error('aborted'))
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function buildAnalysisPrompt(
  focus: AnalysisFocus,
  startSeconds: number | undefined,
  endSeconds: number | undefined,
): string {
  const focusLine =
    focus === 'all'
      ? 'Analyze the attached video clip across all dimensions: visual composition, mood, lighting, color palette, camera movement, subject, audio, and editorial pace.'
      : focus === 'visual'
        ? 'Analyze the attached video clip with primary emphasis on VISUAL composition — framing, subject, camera movement, lighting, and color palette. Still populate the other fields, but give brief answers there.'
        : focus === 'mood'
          ? 'Analyze the attached video clip with primary emphasis on MOOD and tone — what does the viewer FEEL? Still populate the other fields, but give brief answers there.'
          : 'Analyze the attached video clip with primary emphasis on AUDIO — speech content, music, ambient sounds, sonic atmosphere. Still populate the other fields, but give brief answers there.'

  const rangeLine =
    startSeconds !== undefined && endSeconds !== undefined
      ? `Focus your description on the window between ${startSeconds.toFixed(2)}s and ${endSeconds.toFixed(2)}s of the clip. Other timecodes provide context only.`
      : 'Treat the whole clip as the target.'

  return [
    focusLine,
    rangeLine,
    'Return strict JSON matching the provided schema. No commentary outside the JSON.',
    "For `suggestedBrollPrompts`, propose three short prompts (≤25 words each) that would generate b-roll visually matching THIS clip — same lighting, same mood, same pace — without copying the clip's subject literally. The prompts must be ready to paste into a text-to-video model.",
    'For `colorPalette`, give 3-6 dominant colors as plain English names or hex codes.',
    'Be specific. "golden hour" beats "warm light". "handheld push-in" beats "moving camera". "person at window" beats "human".',
  ].join('\n\n')
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

function parseAnalysisResponse(rawJson: string): VideoAnalysisResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Gemini analysis response was not valid JSON: ${msg}`)
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Gemini analysis response was not a JSON object')
  }
  const p = parsed as Record<string, unknown>

  const requireString = (key: string): string => {
    const value = p[key]
    if (typeof value !== 'string') {
      throw new Error(`Gemini analysis response missing required string field: ${key}`)
    }
    return value
  }
  const requireStringArray = (key: string): string[] => {
    const value = p[key]
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
      throw new Error(`Gemini analysis response missing required string[] field: ${key}`)
    }
    return value as string[]
  }

  return {
    visualDescription: requireString('visualDescription'),
    mood: requireString('mood'),
    lighting: requireString('lighting'),
    colorPalette: requireStringArray('colorPalette'),
    cameraMovement: requireString('cameraMovement'),
    subject: requireString('subject'),
    audioSummary: requireString('audioSummary'),
    pace: requireString('pace'),
    suggestedBrollPrompts: requireStringArray('suggestedBrollPrompts'),
  }
}
