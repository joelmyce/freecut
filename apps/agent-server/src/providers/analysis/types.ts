import type { ProviderContext } from '../types.ts'

export type AnalysisProviderId = 'gemini-flash-video'

/**
 * Routing strategy for video analysis.
 *
 * Unlike transcription (where Gemini is hard-barred from `auto` because we
 * have local Whisper as the sane default), video analysis has no local
 * alternative that does temporal + audio + visual joint understanding.
 * So Gemini IS the default — `auto` resolves to whichever analysis
 * provider is available (currently just Gemini). Documented explicitly in
 * AI-EDITOR-VISION.md §4 so future-us doesn't relitigate it.
 */
export type AnalysisStrategy = 'auto' | 'gemini'

/** What to emphasize in the analysis output. */
export type AnalysisFocus = 'visual' | 'mood' | 'audio' | 'all'

export interface VideoAnalysisInput {
  /**
   * Item id on the timeline (item:XYZ) OR a media id (the source asset).
   * The browser-side `read-clip-video-bytes` handler resolves either form
   * down to a concrete media blob.
   */
  clipId: string
  /** Focus area for the analysis. Defaults to 'all'. */
  focus?: AnalysisFocus
  /**
   * Optional time window inside the clip to focus the analysis on. When set,
   * the prompt asks Gemini to weight its description toward frames in this
   * range. We do NOT trim the bytes for v1 — Gemini sees the whole clip and
   * is told which window matters.
   */
  startSeconds?: number
  endSeconds?: number
}

export interface VideoAnalysisResult {
  /**
   * Setting, subject, framing — e.g. "warm late-afternoon golden hour, slow
   * handheld push-in, person at window of high-rise overlooking cityscape".
   */
  visualDescription: string
  /** Emotional tone — "contemplative", "energetic", "tense", etc. */
  mood: string
  /** Lighting character — "golden hour", "harsh studio fluorescents", "low-key noir". */
  lighting: string
  /** Dominant colors as a small palette (3-6 entries, hex or named). */
  colorPalette: ReadonlyArray<string>
  /** Camera movement — "handheld push-in", "locked tripod", "drift", "whip pan". */
  cameraMovement: string
  /** Primary focal subject — "person at window", "coffee cup on table". */
  subject: string
  /** Speech + music + ambience summary. */
  audioSummary: string
  /** Editorial pace — "slow contemplative", "energetic", "frantic". */
  pace: string
  /** 3 candidate b-roll prompts ready to feed `generate_broll` directly. */
  suggestedBrollPrompts: ReadonlyArray<string>
}

export interface VideoAnalysisProvider {
  readonly id: AnalysisProviderId
  isAvailable(): boolean
  analyze(input: VideoAnalysisInput, ctx: ProviderContext): Promise<VideoAnalysisResult>
}

/**
 * Payload shape returned by the browser-side `read-clip-video-bytes` handler.
 * Same envelope as `read-transcribable-audio` so both handlers stay
 * parallel: base64 bytes + container metadata.
 */
export interface ClipVideoPayload {
  bytes: string
  filename: string
  mimeType: string
  /** Full clip duration in seconds (source-native). */
  durationSec: number
}
