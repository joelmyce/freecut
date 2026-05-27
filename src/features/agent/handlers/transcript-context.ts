/**
 * Browser-side handler for `read-transcript-context-for-range` (M4.3 §6.5.1).
 *
 * Given a timeline-time window, find video/audio clips on the timeline that
 * overlap the window, look up each clip's saved transcript (if any), and
 * return the concatenated segment text for the overlapping portion of each
 * clip's source range. Used by `generate_broll` to ground the prompt in
 * spoken context when the user requests b-roll over a transcribed segment.
 *
 * Best-effort: returns `{ text: null }` when nothing relevant is saved, so
 * the agent server can fall back to the plain prompt without failing.
 */

import { createLogger } from '@/shared/logging/logger'
import { useItemsStore, useTimelineSettingsStore } from '../deps/timeline-contract'
import { getTranscript } from '../deps/storage-contract'
import type { BrowserActionHandler } from './types'

const log = createLogger('agent-handler-transcript-context')

interface ReadTranscriptContextArgs {
  startSeconds: number
  endSeconds: number
}

interface ReadTranscriptContextResult {
  /** Concatenated transcript text covering the window, null when no transcript overlaps. */
  text: string | null
  /** Media ids whose transcripts contributed. Empty when text is null. */
  sourceMediaIds: string[]
  /** Echoed back so the agent server can quote the window in the prompt block. */
  startSeconds: number
  endSeconds: number
}

export const readTranscriptContextForRangeHandler: BrowserActionHandler = async (rawArgs) => {
  const args = rawArgs as ReadTranscriptContextArgs
  if (typeof args.startSeconds !== 'number' || typeof args.endSeconds !== 'number') {
    throw new Error('read-transcript-context-for-range requires startSeconds + endSeconds')
  }
  if (args.endSeconds <= args.startSeconds) {
    throw new Error('endSeconds must be greater than startSeconds')
  }

  const fps = useTimelineSettingsStore.getState().fps
  if (!Number.isFinite(fps) || fps <= 0) {
    return emptyResult(args.startSeconds, args.endSeconds)
  }

  const startFrame = args.startSeconds * fps
  const endFrame = args.endSeconds * fps

  const items = useItemsStore
    .getState()
    .items.filter((item) => item.type === 'video' || item.type === 'audio')

  const overlapping = items.filter((item) => {
    const itemEnd = item.from + item.durationInFrames
    return itemEnd > startFrame && item.from < endFrame
  })
  if (overlapping.length === 0) return emptyResult(args.startSeconds, args.endSeconds)

  const collected: string[] = []
  const usedMediaIds: string[] = []
  const seen = new Set<string>()

  for (const item of overlapping) {
    if (!('mediaId' in item) || !item.mediaId) continue
    if (seen.has(item.mediaId)) continue
    seen.add(item.mediaId)

    try {
      const transcript = await getTranscript(item.mediaId)
      if (!transcript || transcript.segments.length === 0) continue

      // Translate the request window into this clip's source-time window.
      const sourceFps = item.sourceFps && item.sourceFps > 0 ? item.sourceFps : fps
      const clipSourceStartSec = (item.sourceStart ?? 0) / sourceFps
      const clipFromSec = item.from / fps
      // Frame on the timeline → seconds offset within this clip.
      const requestStartInClipSec = Math.max(0, args.startSeconds - clipFromSec)
      const requestEndInClipSec = Math.max(0, args.endSeconds - clipFromSec)
      const segStart = clipSourceStartSec + requestStartInClipSec
      const segEnd = clipSourceStartSec + requestEndInClipSec

      const overlappingSegs = transcript.segments.filter(
        (s) => s.end > segStart && s.start < segEnd,
      )
      if (overlappingSegs.length === 0) continue

      const text = overlappingSegs
        .map((s) => s.text.trim())
        .filter((t) => t.length > 0)
        .join(' ')
      if (!text) continue

      collected.push(text)
      usedMediaIds.push(item.mediaId)
    } catch (err) {
      log.warn(`failed to read transcript for ${item.mediaId}`, err)
    }
  }

  if (collected.length === 0) return emptyResult(args.startSeconds, args.endSeconds)

  return {
    text: collected.join(' '),
    sourceMediaIds: usedMediaIds,
    startSeconds: args.startSeconds,
    endSeconds: args.endSeconds,
  } satisfies ReadTranscriptContextResult
}

function emptyResult(startSeconds: number, endSeconds: number): ReadTranscriptContextResult {
  return { text: null, sourceMediaIds: [], startSeconds, endSeconds }
}
