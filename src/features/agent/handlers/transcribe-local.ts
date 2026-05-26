import { mediaTranscriptionService } from '../deps/media-library-contract'
import type { BrowserActionHandler } from './types'

interface TranscribeLocalArgs {
  mediaId: string
  language?: string
  model?: string
}

interface TranscribeResult {
  text: string
  language?: string
  durationSec: number
  segments: ReadonlyArray<{ text: string; start: number; end: number }>
}

/**
 * Handles `transcribe-local`: delegates to the existing
 * `mediaTranscriptionService.transcribeMedia()` (browser-side whisper via
 * transformers.js + WebGPU), then shapes the result into the simple
 * Transcript contract the server-side provider expects. The browser-side
 * service already persists the transcript via `saveTranscript()`, so the
 * server does not need to re-save.
 */
export const transcribeLocalHandler: BrowserActionHandler = async (rawArgs, signal) => {
  const args = rawArgs as TranscribeLocalArgs
  if (!args.mediaId) throw new Error('transcribe-local requires mediaId')

  const onAbort = () => {
    mediaTranscriptionService.cancelTranscription(args.mediaId, 'aborted by agent')
  }
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    const transcript = await mediaTranscriptionService.transcribeMedia(args.mediaId, {
      language: args.language,
      // model + quantization are best left at the service's defaults; the
      // SDK-strict `MediaTranscriptModel` enum doesn't match arbitrary
      // agent-supplied model strings. Forward language only.
    })
    const durationSec = transcript.segments.length > 0 ? (transcript.segments.at(-1)?.end ?? 0) : 0
    const result: TranscribeResult = {
      text: transcript.text,
      language: transcript.language,
      durationSec,
      segments: transcript.segments.map((s) => ({
        text: s.text.trim(),
        start: s.start,
        end: s.end,
      })),
    }
    return result
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
