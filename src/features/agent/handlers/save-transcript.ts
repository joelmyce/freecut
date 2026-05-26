import { saveTranscript } from '@/infrastructure/storage'
import type { MediaTranscript } from '@/types/storage'
import type { BrowserActionHandler } from './types'

interface SaveTranscriptArgs {
  mediaId: string
  providerId: string
  transcript: {
    text: string
    language?: string
    durationSec: number
    segments: ReadonlyArray<{ text: string; start: number; end: number }>
  }
}

/**
 * Persists a transcript that was produced server-side (e.g. by the OpenAI
 * Whisper provider). The legacy MediaTranscript shape requires a model from
 * a strict enum — we mark cloud-sourced transcripts as `whisper-large` since
 * the field is informational metadata for the UI, not an invalidation key.
 * A follow-up should extend `MediaTranscriptModel` to include 'openai-whisper-1'.
 */
export const saveTranscriptHandler: BrowserActionHandler = async (rawArgs) => {
  const args = rawArgs as SaveTranscriptArgs
  if (!args.mediaId) throw new Error('save-transcript requires mediaId')
  if (!args.transcript) throw new Error('save-transcript requires transcript')

  const now = Date.now()
  const record: MediaTranscript = {
    id: args.mediaId,
    mediaId: args.mediaId,
    model: 'whisper-large',
    language: args.transcript.language,
    quantization: 'hybrid',
    text: args.transcript.text,
    segments: args.transcript.segments.map((s) => ({
      text: s.text,
      start: s.start,
      end: s.end,
    })),
    createdAt: now,
    updatedAt: now,
  }
  await saveTranscript(record)
  return { ok: true, providerId: args.providerId }
}
