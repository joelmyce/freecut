import type { ProviderContext } from '../types.ts'

export type TranscriptionProviderId = 'local-whisper' | 'openai-whisper'

export type TranscriptionStrategy = 'auto' | 'local' | 'openai'

export interface TranscriptionInput {
  assetId: string
  durationSec?: number
  language?: string
  model?: string
}

export interface TranscriptSegment {
  text: string
  start: number
  end: number
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
