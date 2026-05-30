/**
 * Browser-side handler for `read-asset-transcript` (M6).
 *
 * Read-only. Resolves an asset id (an `item:XYZ` timeline clip or a bare
 * `media:XYZ` / media id) to its saved transcript and returns the segments
 * the server's transcript-reasoning provider needs (find_moment now;
 * detect_chapters / suggest_trims next).
 *
 * When the asset resolves to a PLACED timeline item, the handler also returns
 * a `placement` block (timeline-from + the clip's source-time window) so the
 * server can map a found source-time moment back onto the project timeline.
 * For a bare media id (not placed, or placed multiple times) placement is null
 * and timestamps stay in source-native time.
 *
 * Mirrors `read-clip-for-regen` (read-only sibling of a mutating handler) per
 * the M4.1 read/write split — nothing here mutates the timeline.
 */

import { createLogger } from '@/shared/logging/logger'
import { useItemsStore, useTimelineSettingsStore } from '../deps/timeline-contract'
import { getTranscript } from '../deps/storage-contract'
import type { BrowserActionHandler } from './types'

const log = createLogger('agent-handler-read-asset-transcript')

interface ReadAssetTranscriptArgs {
  assetId: string
}

interface ReasoningWord {
  start: number
  end: number
}

interface ReasoningSegment {
  text: string
  start: number
  end: number
  words?: ReasoningWord[]
}

interface ReadAssetTranscriptResult {
  /** Media id the transcript belongs to (resolved from the item when needed). */
  mediaId: string
  /** Null when no transcript is saved for this asset. */
  transcript: {
    segments: ReasoningSegment[]
    language?: string
    durationSec: number
  } | null
  /**
   * Source→timeline mapping, present only when assetId resolved to a placed
   * timeline item. All values in seconds. `fromSec` is the clip's timeline
   * start; `sourceStartSec`/`sourceEndSec` bracket the clip's source window.
   */
  placement: {
    fromSec: number
    sourceStartSec: number
    sourceEndSec: number
  } | null
}

export const readAssetTranscriptHandler: BrowserActionHandler = async (rawArgs) => {
  const args = rawArgs as ReadAssetTranscriptArgs
  if (!args.assetId) throw new Error('read-asset-transcript requires assetId')

  const canonicalId = stripIdPrefix(args.assetId)
  const { mediaId, placement } = resolveAsset(canonicalId)
  if (!mediaId) {
    throw new Error(
      `read-asset-transcript: ${args.assetId} is neither a known timeline clip with media nor a media id`,
    )
  }

  let transcript: ReadAssetTranscriptResult['transcript'] = null
  try {
    const saved = await getTranscript(mediaId)
    if (saved && saved.segments.length > 0) {
      const segments: ReasoningSegment[] = saved.segments.map((s) => ({
        text: s.text,
        start: s.start,
        end: s.end,
        words: s.words?.map((w) => ({ start: w.start, end: w.end })),
      }))
      const durationSec = segments.reduce((max, s) => Math.max(max, s.end), 0)
      transcript = { segments, language: saved.language, durationSec }
    }
  } catch (err) {
    log.warn(`failed to read transcript for ${mediaId}`, err)
  }

  return { mediaId, transcript, placement } satisfies ReadAssetTranscriptResult
}

/**
 * Strip the bracket-tag prefix the agent sometimes passes verbatim
 * ("item:XYZ" / "media:XYZ" → "XYZ"). Same defensive strip as
 * `read-clip-video-bytes` — workspace-fs names reject ":".
 */
function stripIdPrefix(id: string): string {
  const colonIndex = id.indexOf(':')
  if (colonIndex === -1) return id
  const prefix = id.slice(0, colonIndex)
  if (prefix === 'item' || prefix === 'media') return id.slice(colonIndex + 1)
  return id
}

function resolveAsset(idOrItem: string): {
  mediaId: string | null
  placement: ReadAssetTranscriptResult['placement']
} {
  const item = useItemsStore.getState().items.find((i) => i.id === idOrItem)
  if (item) {
    // Only speech-bearing media has a transcript worth reasoning over.
    if (item.type !== 'video' && item.type !== 'audio') {
      return { mediaId: null, placement: null }
    }
    const mediaId = item.mediaId ?? null
    if (!mediaId) return { mediaId: null, placement: null }

    const projectFps = useTimelineSettingsStore.getState().fps
    const fps = Number.isFinite(projectFps) && projectFps > 0 ? projectFps : 30
    const sourceFps = item.sourceFps && item.sourceFps > 0 ? item.sourceFps : fps
    const fromSec = item.from / fps
    const sourceStartSec = (item.sourceStart ?? 0) / sourceFps
    // `durationInFrames` is in PROJECT fps; at 1x playback the clip's source
    // span equals its timeline span, so derive the source end from it when an
    // explicit sourceEnd isn't stored.
    const sourceEndSec =
      item.sourceEnd !== undefined && item.sourceEnd > 0
        ? item.sourceEnd / sourceFps
        : sourceStartSec + item.durationInFrames / fps

    return { mediaId, placement: { fromSec, sourceStartSec, sourceEndSec } }
  }
  // Caller passed a media id directly — accept as-is; getTranscript validates it.
  return { mediaId: idOrItem, placement: null }
}
