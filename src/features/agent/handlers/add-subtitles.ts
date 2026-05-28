import { getTranscript } from '../deps/storage-contract'
import { mediaTranscriptionService } from '../deps/media-library-contract'
import type { BrowserActionHandler } from './types'

interface AddSubtitlesArgs {
  mediaId: string
  replaceExisting?: boolean
  clipIds?: ReadonlyArray<string>
  /**
   * Caption playback style. Omit (or pass `'karaoke'`) for per-word highlight;
   * pass `'standard'` for classic per-segment captions. See M5.1 in
   * docs/PHASE-1-PLAN.md §6.11.
   */
  style?: 'standard' | 'karaoke'
  /** CSS color for the active word in karaoke mode. Defaults to gold (#FFD700). */
  karaokeHighlightColor?: string
  /**
   * Max words on screen at once in karaoke mode. Whisper segments are chunked
   * into N-word cues so the viewer never sees the whole sentence at once.
   * Defaults to 3 (Submagic-ish viral feel). 1 = one-word-stamp, 5 = closer
   * to traditional captions.
   */
  wordsPerCue?: number
}

interface AddSubtitlesResult {
  insertedItemCount: number
  removedItemCount: number
  /**
   * True when the saved transcript carries per-word timestamps, so the
   * karaoke highlight will animate word-by-word. False means the renderer
   * silently falls back to standard cue display even if `style: 'karaoke'`.
   */
  hasWordTimestamps: boolean
}

/**
 * Drops a media's saved transcript onto the timeline as a new (or existing)
 * caption track via the existing mediaTranscriptionService — caption-track
 * auto-creation, cue alignment, source mapping, and undo all handled by the
 * service. If no transcript exists yet, throws "No transcript found ..." so
 * the agent knows to call transcribe first and retry.
 *
 * Karaoke is the DEFAULT style (M5.1) — every transcript caption insert
 * lights up words as they're spoken. Callers wanting classic per-segment
 * captions pass `style: 'standard'`.
 */
export const addSubtitlesHandler: BrowserActionHandler = async (rawArgs) => {
  const args = rawArgs as AddSubtitlesArgs
  if (!args.mediaId) throw new Error('add-subtitles requires mediaId')

  // Peek the transcript so we can tell the agent whether the karaoke
  // highlight will actually animate. Cheap — already read from disk
  // immediately afterward by insertTranscriptAsCaptions.
  const transcript = await getTranscript(args.mediaId)
  const hasWordTimestamps =
    transcript?.segments.some((segment) => (segment.words?.length ?? 0) > 0) ?? false

  const result = await mediaTranscriptionService.insertTranscriptAsCaptions(args.mediaId, {
    clipIds: args.clipIds,
    replaceExisting: args.replaceExisting,
    style: args.style,
    karaokeHighlightColor: args.karaokeHighlightColor,
    wordsPerCue: args.wordsPerCue,
  })

  const payload: AddSubtitlesResult = {
    insertedItemCount: result.insertedItemCount,
    removedItemCount: result.removedItemCount,
    hasWordTimestamps,
  }
  return payload
}
