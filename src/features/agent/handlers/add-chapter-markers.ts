/**
 * Browser-side handler for `add-chapter-markers` (M6 — detect_chapters).
 *
 * Mutating. Receives chapters in TIMELINE seconds (the tool already mapped
 * source-native transcript time onto the timeline using the clip's placement)
 * and a title each, converts seconds → project frames, and drops them all as
 * markers in a SINGLE undo entry via `addChapterMarkers`. One Ctrl+Z clears the
 * whole chapter set.
 *
 * Read/write split (M4.1): the read side is `read-asset-transcript`; this
 * handler only mutates.
 */

import { createLogger } from '@/shared/logging/logger'
import { addChapterMarkers, useTimelineSettingsStore } from '../deps/timeline-contract'
import type { BrowserActionHandler } from './types'

const log = createLogger('agent-handler-add-chapter-markers')

/** Distinct violet so chapter markers read differently from hand-placed markers. */
const CHAPTER_MARKER_COLOR = '#8B5CF6'

interface ChapterInput {
  timelineSec: number
  title: string
}

interface AddChapterMarkersArgs {
  chapters: ChapterInput[]
  color?: string
}

interface AddChapterMarkersResult {
  insertedCount: number
  markers: Array<{ frame: number; label: string }>
}

export const addChapterMarkersHandler: BrowserActionHandler = async (rawArgs) => {
  const args = rawArgs as AddChapterMarkersArgs
  if (!Array.isArray(args.chapters) || args.chapters.length === 0) {
    throw new Error('add-chapter-markers requires a non-empty chapters array')
  }

  const fps = useTimelineSettingsStore.getState().fps
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30
  const color = args.color ?? CHAPTER_MARKER_COLOR

  const markers = args.chapters
    .filter(
      (c) =>
        typeof c.timelineSec === 'number' &&
        Number.isFinite(c.timelineSec) &&
        typeof c.title === 'string' &&
        c.title.trim().length > 0,
    )
    .map((c) => ({
      frame: Math.max(0, Math.round(c.timelineSec * safeFps)),
      label: c.title.trim(),
      color,
    }))

  if (markers.length === 0) {
    throw new Error('add-chapter-markers: no valid chapters to insert')
  }

  addChapterMarkers(markers)

  log.debug(`inserted ${markers.length} chapter markers`)
  return {
    insertedCount: markers.length,
    markers: markers.map((m) => ({ frame: m.frame, label: m.label })),
  } satisfies AddChapterMarkersResult
}
