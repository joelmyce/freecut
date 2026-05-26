import { mediaTranscriptionService } from '../deps/media-library-contract'
import type { BrowserActionHandler } from './types'

interface AddSubtitlesArgs {
  mediaId: string
  replaceExisting?: boolean
  clipIds?: ReadonlyArray<string>
}

interface AddSubtitlesResult {
  insertedItemCount: number
  removedItemCount: number
}

/**
 * Drops a media's saved transcript onto the timeline as a new (or existing)
 * caption track via the existing mediaTranscriptionService — caption-track
 * auto-creation, cue alignment, source mapping, and undo all handled by the
 * service. If no transcript exists yet, throws "No transcript found ..." so
 * the agent knows to call transcribe first and retry.
 */
export const addSubtitlesHandler: BrowserActionHandler = async (rawArgs) => {
  const args = rawArgs as AddSubtitlesArgs
  if (!args.mediaId) throw new Error('add-subtitles requires mediaId')

  const result = await mediaTranscriptionService.insertTranscriptAsCaptions(args.mediaId, {
    clipIds: args.clipIds,
    replaceExisting: args.replaceExisting,
  })

  const payload: AddSubtitlesResult = {
    insertedItemCount: result.insertedItemCount,
    removedItemCount: result.removedItemCount,
  }
  return payload
}
