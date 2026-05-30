import type { ProviderContext } from '../types.ts'

export type TranscriptionProviderId = 'local-whisper' | 'openai-whisper' | 'gemini-flash'

export type TranscriptionStrategy = 'auto' | 'local' | 'openai' | 'gemini'

export interface TranscriptionInput {
  assetId: string
  durationSec?: number
  language?: string
  model?: string
}

export interface TranscriptWord {
  text: string
  start: number
  end: number
}

export interface TranscriptSegment {
  text: string
  start: number
  end: number
  /** Per-word timestamps when the provider returns them (used for cut snapping + karaoke). */
  words?: TranscriptWord[]
}

export interface Transcript {
  text: string
  segments: TranscriptSegment[]
  language?: string
  durationSec: number
}

export interface TranscriptionProvider {
  readonly id: TranscriptionProviderId
  isAvailable(): boolean
  transcribe(input: TranscriptionInput, ctx: ProviderContext): Promise<Transcript>
}
