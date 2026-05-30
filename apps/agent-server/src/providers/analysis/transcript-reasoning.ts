import type { ProviderContext } from '../types.ts'

/**
 * Transcript-reasoning capability (M6). Structured reasoning over a clip's
 * TRANSCRIPT (text + timestamps) rather than its video bytes — the input for
 * the "agent makes editorial decisions" tools: find_moment now, detect_chapters
 * and suggest_trims next.
 *
 * Distinct from the video-analysis capability (`gemini.ts` in this dir): that
 * one ships video bytes to Gemini for *aesthetic* analysis (mood/lighting);
 * this one ships only text for *structural* reasoning. No video bytes ⇒ no
 * File-API upload path ⇒ ~1-2s, fractions of a cent. Reuses the same Gemini
 * generateContent + structured-output machinery.
 *
 * Routing mirrors video analysis (see AI-EDITOR-VISION.md §4): there is no
 * local alternative, so `auto` resolves to Gemini — we do NOT hard-bar it the
 * way transcription does.
 */

/* =============================== Types =============================== */

export type TranscriptReasoningProviderId = 'gemini-flash-transcript'

export type TranscriptReasoningStrategy = 'auto' | 'gemini'

/** One word with source-native start/end, used to snap trim cuts to word edges. */
export interface ReasoningWord {
  start: number
  end: number
}

/** One transcript line, timestamps in source-native seconds. */
export interface ReasoningTranscriptSegment {
  text: string
  start: number
  end: number
  /** Per-word timestamps when the transcript has them (Whisper word-level). */
  words?: ReasoningWord[]
}

/** The transcript payload the browser hands the server for reasoning. */
export interface ReasoningTranscript {
  segments: ReasoningTranscriptSegment[]
  language?: string
  /** Source-native duration in seconds (best-effort — usually the last segment end). */
  durationSec: number
}

export interface FindMomentInput {
  /** Natural-language description of the moment to locate. */
  query: string
  transcript: ReasoningTranscript
}

/** One located moment. Timestamp is in the transcript's source-native time. */
export interface FoundMoment {
  /** Source-native seconds where the moment begins. */
  sourceTimestampSec: number
  /** Verbatim transcript snippet that matched. */
  quote: string
  /** One-line rationale for why this answers the query. */
  reason: string
  /** Model confidence, clamped to 0..1. */
  confidence: number
}

export interface FindMomentResult {
  found: boolean
  /** Best match, or null when nothing in the transcript answers the query. */
  best: FoundMoment | null
  /** Up to 3 weaker candidates, best-first. */
  alternatives: FoundMoment[]
}

/** How finely to segment when detecting chapters. */
export type ChapterGranularity = 'coarse' | 'fine'

export interface DetectChaptersInput {
  transcript: ReasoningTranscript
  /** Defaults to 'coarse' (fewer, broader chapters). */
  granularity?: ChapterGranularity
}

/** One detected chapter. `startSec` is in the transcript's source-native time. */
export interface ChapterSegment {
  startSec: number
  title: string
}

export interface DetectChaptersResult {
  /** Chapters ordered by `startSec` ascending; empty when the transcript is empty. */
  chapters: ChapterSegment[]
}

export interface SuggestTrimsInput {
  transcript: ReasoningTranscript
  /** Optional steer, e.g. "tighten to ~2 minutes" or "cut the rambling intro". */
  goal?: string
  /** Soft cap on how many trims to propose. Defaults to 5. */
  maxTrims?: number
}

/** One proposed cut. Both bounds are in the transcript's source-native time. */
export interface TrimSuggestion {
  startSec: number
  endSec: number
  /** Short rationale — "long pause", "rambling tangent", "repeated point", "false start". */
  reason: string
}

export interface SuggestTrimsResult {
  /** Proposed cuts ordered by `startSec`; empty when nothing is worth trimming. */
  trims: TrimSuggestion[]
}

export interface TranscriptReasoningProvider {
  readonly id: TranscriptReasoningProviderId
  isAvailable(): boolean
  findMoment(input: FindMomentInput, ctx: ProviderContext): Promise<FindMomentResult>
  detectChapters(input: DetectChaptersInput, ctx: ProviderContext): Promise<DetectChaptersResult>
  suggestTrims(input: SuggestTrimsInput, ctx: ProviderContext): Promise<SuggestTrimsResult>
}

/* =============================== Router =============================== */

export interface PickTranscriptReasoningProviderResult {
  provider: TranscriptReasoningProvider
  reason: string
}

/**
 * Pick a transcript-reasoning provider. Same shape as `pickAnalysisProvider`:
 * no hard-bar (there's no local alternative), so `auto` resolves to whichever
 * provider is available (currently just Gemini).
 */
export function pickTranscriptReasoningProvider(
  providers: ReadonlyArray<TranscriptReasoningProvider>,
  strategy: TranscriptReasoningStrategy,
): PickTranscriptReasoningProviderResult {
  const gemini = providers.find((p) => p.id === 'gemini-flash-transcript' && p.isAvailable())

  if (strategy === 'gemini') {
    if (!gemini) {
      throw new Error(
        'Gemini transcript-reasoning provider is not available (missing GEMINI_API_KEY in .env)',
      )
    }
    return { provider: gemini, reason: 'explicit strategy: gemini' }
  }

  // strategy === 'auto'
  if (gemini) {
    return { provider: gemini, reason: 'auto: defaulting to gemini-flash-transcript' }
  }
  throw new Error(
    'No transcript-reasoning provider is available. Set GEMINI_API_KEY in .env to enable Gemini.',
  )
}

/* ========================== Gemini provider ========================== */

const GEMINI_GENERATE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'

const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash'

/**
 * Structured-output schema for find_moment. `moments` is best-first; an empty
 * array means nothing in the transcript answered the query. We compute `found`
 * from the array rather than trusting a separate boolean.
 */
const FIND_MOMENT_SCHEMA = {
  type: 'object',
  properties: {
    moments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sourceTimestampSec: { type: 'number' },
          quote: { type: 'string' },
          reason: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['sourceTimestampSec', 'quote', 'reason', 'confidence'],
      },
    },
  },
  required: ['moments'],
} as const

/**
 * Structured-output schema for detect_chapters. Ordered chapters, each a topic
 * boundary with a source-native start time and a short title.
 */
const CHAPTERS_SCHEMA = {
  type: 'object',
  properties: {
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          startSec: { type: 'number' },
          title: { type: 'string' },
        },
        required: ['startSec', 'title'],
      },
    },
  },
  required: ['chapters'],
} as const

/**
 * Structured-output schema for suggest_trims. Each entry is a removable span
 * with a rationale; an empty array means nothing is worth cutting.
 */
const SUGGEST_TRIMS_SCHEMA = {
  type: 'object',
  properties: {
    trims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          startSec: { type: 'number' },
          endSec: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['startSec', 'endSec', 'reason'],
      },
    },
  },
  required: ['trims'],
} as const

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> }
    finishReason?: string
  }>
  promptFeedback?: { blockReason?: string }
}

export interface GeminiTranscriptReasoningProviderOptions {
  apiKey: string | undefined
  model?: string
  fetchImpl?: typeof fetch
  /** Override the generate URL template — used by tests with a mock server. */
  generateUrlTemplate?: string
}

export class GeminiTranscriptReasoningProvider implements TranscriptReasoningProvider {
  readonly id = 'gemini-flash-transcript' as const
  private readonly apiKey: string | undefined
  private readonly model: string
  private readonly fetchImpl: typeof fetch
  private readonly generateUrlTemplate: string

  constructor(options: GeminiTranscriptReasoningProviderOptions) {
    const trimmed = options.apiKey?.trim()
    this.apiKey = trimmed && trimmed.length > 0 ? trimmed : undefined
    this.model = options.model ?? DEFAULT_GEMINI_MODEL
    this.fetchImpl = options.fetchImpl ?? fetch
    this.generateUrlTemplate = options.generateUrlTemplate ?? GEMINI_GENERATE_URL
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey)
  }

  async findMoment(input: FindMomentInput, ctx: ProviderContext): Promise<FindMomentResult> {
    // Empty transcript → no work to do, no API call to waste.
    if (input.transcript.segments.length === 0) {
      return { found: false, best: null, alternatives: [] }
    }
    ctx.onProgress?.({ stage: 'reasoning' })
    const parsed = await this.generateStructuredJson(
      buildFindMomentPrompt(input.query, input.transcript),
      FIND_MOMENT_SCHEMA,
      'find_moment',
      ctx.signal,
    )
    return parseFindMomentResult(parsed)
  }

  async detectChapters(
    input: DetectChaptersInput,
    ctx: ProviderContext,
  ): Promise<DetectChaptersResult> {
    if (input.transcript.segments.length === 0) {
      return { chapters: [] }
    }
    ctx.onProgress?.({ stage: 'reasoning' })
    const parsed = await this.generateStructuredJson(
      buildDetectChaptersPrompt(input.transcript, input.granularity ?? 'coarse'),
      CHAPTERS_SCHEMA,
      'detect_chapters',
      ctx.signal,
    )
    return parseChaptersResult(parsed)
  }

  async suggestTrims(input: SuggestTrimsInput, ctx: ProviderContext): Promise<SuggestTrimsResult> {
    if (input.transcript.segments.length === 0) {
      return { trims: [] }
    }
    ctx.onProgress?.({ stage: 'reasoning' })
    const maxTrims = input.maxTrims && input.maxTrims > 0 ? Math.floor(input.maxTrims) : 5
    const parsed = await this.generateStructuredJson(
      buildSuggestTrimsPrompt(input.transcript, maxTrims, input.goal),
      SUGGEST_TRIMS_SCHEMA,
      'suggest_trims',
      ctx.signal,
    )
    return parseTrimsResult(parsed, maxTrims)
  }

  /**
   * Shared Gemini structured-JSON call. Builds the request, validates the
   * response, and returns the parsed object — each public method supplies its
   * own prompt + schema and does its own field coercion. `taskLabel` flows into
   * every error message (e.g. "Gemini find_moment failed: 500").
   */
  private async generateStructuredJson(
    prompt: string,
    schema: unknown,
    taskLabel: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!this.apiKey) {
      throw new Error('Gemini transcript-reasoning provider requires GEMINI_API_KEY')
    }
    const url = this.generateUrlTemplate.replace('{model}', this.model)

    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schema,
          // Structural reasoning is low-creativity — keep it near-deterministic.
          temperature: 0.1,
        },
      }),
      signal,
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const suffix = detail ? ` — ${detail.slice(0, 500)}` : ''
      throw new Error(`Gemini ${taskLabel} failed: ${res.status} ${res.statusText}${suffix}`)
    }

    const json = (await res.json()) as GeminiGenerateResponse
    const text = extractResponseText(json)
    if (!text) {
      const blockReason = json.promptFeedback?.blockReason
      throw new Error(
        blockReason
          ? `Gemini blocked the ${taskLabel} request: ${blockReason}`
          : `Gemini returned no text content for the ${taskLabel} request`,
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Gemini ${taskLabel} response was not valid JSON: ${msg}`)
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`Gemini ${taskLabel} response was not a JSON object`)
    }
    return parsed as Record<string, unknown>
  }
}

function buildFindMomentPrompt(query: string, transcript: ReasoningTranscript): string {
  const langLine = transcript.language ? ` (language: ${transcript.language})` : ''
  const lines = transcript.segments
    .map((s) => `[${s.start.toFixed(1)}s] ${s.text.trim()}`)
    .filter((l) => l.length > 0)
    .join('\n')

  return [
    `You are helping a video editor locate a specific moment inside a clip${langLine}. Below is the clip's transcript; every line is prefixed with its start time in seconds.`,
    `QUERY: "${query}"`,
    'TRANSCRIPT:',
    lines,
    'Find the single BEST moment that answers the query, plus up to 3 weaker alternatives (best first). For each moment return: `sourceTimestampSec` (the start time in seconds of the line where it occurs — copy the exact prefixed number), a short verbatim `quote` from the transcript, a one-line `reason`, and a `confidence` from 0 to 1. Put the best match first in `moments`. If NOTHING in the transcript answers the query, return an empty `moments` array. Return strict JSON matching the schema — no commentary outside the JSON.',
  ].join('\n\n')
}

function buildDetectChaptersPrompt(
  transcript: ReasoningTranscript,
  granularity: ChapterGranularity,
): string {
  const langLine = transcript.language ? ` (language: ${transcript.language})` : ''
  const lines = transcript.segments
    .map((s) => `[${s.start.toFixed(1)}s] ${s.text.trim()}`)
    .filter((l) => l.length > 0)
    .join('\n')

  const granularityLine =
    granularity === 'fine'
      ? 'Segment granularly — capture finer topic shifts (roughly one chapter per 1-2 minutes of content).'
      : 'Use broad chapters — group by major topic (roughly one chapter per 2-5 minutes of content).'

  return [
    `You are a video editor's assistant segmenting a clip into chapters by topic${langLine}. Below is the transcript; every line is prefixed with its start time in seconds.`,
    'TRANSCRIPT:',
    lines,
    granularityLine,
    'Return ordered chapters. For each chapter return `startSec` (the start time in seconds of the transcript line where the new topic begins — copy the exact prefixed number) and a short `title` (3 to 7 words, Title Case, no trailing punctuation). The first chapter should start at or near 0. Never invent a timestamp that is not present in the transcript. Return strict JSON matching the schema — no commentary outside the JSON.',
  ].join('\n\n')
}

function buildSuggestTrimsPrompt(
  transcript: ReasoningTranscript,
  maxTrims: number,
  goal: string | undefined,
): string {
  const langLine = transcript.language ? ` (language: ${transcript.language})` : ''
  const lines = transcript.segments
    .map((s) => `[${s.start.toFixed(1)}s-${s.end.toFixed(1)}s] ${s.text.trim()}`)
    .filter((l) => l.length > 0)
    .join('\n')

  const goalLine = goal
    ? `The editor's goal: "${goal}". Prioritize cuts that serve it.`
    : 'The editor wants to tighten the clip without losing substance.'

  return [
    `You are a video editor's assistant proposing tightening cuts for a clip${langLine}. Below is the transcript; every line is prefixed with its start and end time in seconds.`,
    goalLine,
    'TRANSCRIPT:',
    lines,
    `Propose up to ${maxTrims} spans that could be REMOVED to tighten the clip: long pauses / dead air, filler and rambling, repeated points, off-topic tangents, false starts and restarts. Be CONSERVATIVE — under-cutting is far better than cutting good content, because the editor can always ask for more. Strongly prefer several SHORT cuts over one big one: only propose a span longer than ~30 seconds when it is unambiguously dead air, silence, or non-speech (for example a long musical interlude with no talking) — when in any doubt about a long span, leave it for the editor. NEVER cut in the middle of a sentence or an important point. Put each span's \`startSec\` and \`endSec\` at a natural PAUSE — a gap between transcript lines — so the cut sounds clean rather than abrupt; copy the times from the transcript line bounds. Return a short \`reason\` for each (e.g. "long pause", "rambling tangent", "repeated point", "false start"). startSec must be less than endSec. If nothing is clearly worth cutting, return an empty \`trims\` array. Return strict JSON matching the schema — no commentary outside the JSON.`,
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

function parseFindMomentResult(p: Record<string, unknown>): FindMomentResult {
  const rawMoments = Array.isArray(p.moments) ? p.moments : []
  const moments = rawMoments.map((m) => coerceMoment(m)).filter((m): m is FoundMoment => m !== null)

  const best = moments[0] ?? null
  return {
    found: best !== null,
    best,
    alternatives: moments.slice(1, 4),
  }
}

function parseChaptersResult(p: Record<string, unknown>): DetectChaptersResult {
  const rawChapters = Array.isArray(p.chapters) ? p.chapters : []
  const chapters = rawChapters
    .map((c) => coerceChapter(c))
    .filter((c): c is ChapterSegment => c !== null)
    .sort((a, b) => a.startSec - b.startSec)
  return { chapters }
}

function coerceChapter(raw: unknown): ChapterSegment | null {
  if (typeof raw !== 'object' || raw === null) return null
  const c = raw as Record<string, unknown>
  const startSec = c.startSec
  const title = c.title
  if (typeof startSec !== 'number' || !Number.isFinite(startSec)) return null
  if (typeof title !== 'string' || title.trim().length === 0) return null
  return { startSec: Math.max(0, startSec), title: title.trim() }
}

function parseTrimsResult(p: Record<string, unknown>, maxTrims: number): SuggestTrimsResult {
  const rawTrims = Array.isArray(p.trims) ? p.trims : []
  const trims = rawTrims
    .map((t) => coerceTrim(t))
    .filter((t): t is TrimSuggestion => t !== null)
    .sort((a, b) => a.startSec - b.startSec)
    .slice(0, maxTrims)
  return { trims }
}

function coerceTrim(raw: unknown): TrimSuggestion | null {
  if (typeof raw !== 'object' || raw === null) return null
  const t = raw as Record<string, unknown>
  const startSec = t.startSec
  const endSec = t.endSec
  if (typeof startSec !== 'number' || !Number.isFinite(startSec)) return null
  if (typeof endSec !== 'number' || !Number.isFinite(endSec)) return null
  const start = Math.max(0, startSec)
  const end = Math.max(0, endSec)
  if (end <= start) return null
  return {
    startSec: start,
    endSec: end,
    reason: typeof t.reason === 'string' ? t.reason.trim() : '',
  }
}

function coerceMoment(raw: unknown): FoundMoment | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  const ts = m.sourceTimestampSec
  const quote = m.quote
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null
  if (typeof quote !== 'string' || quote.trim().length === 0) return null
  return {
    sourceTimestampSec: Math.max(0, ts),
    quote: quote.trim(),
    reason: typeof m.reason === 'string' ? m.reason : '',
    confidence:
      typeof m.confidence === 'number' && Number.isFinite(m.confidence)
        ? Math.min(1, Math.max(0, m.confidence))
        : 0,
  }
}
