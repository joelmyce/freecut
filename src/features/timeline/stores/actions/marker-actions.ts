/**
 * Marker Actions - Project marker and in/out point operations.
 */

import type { ProjectMarker } from '@/types/timeline'
import { useItemsStore } from '../items-store'
import { useMarkersStore } from '../markers-store'
import { useTimelineSettingsStore } from '../timeline-settings-store'
import { execute } from './shared'
import { getEffectiveTimelineMaxFrame, sanitizeInOutPoints } from '../../utils/in-out-points'

function getEffectiveMaxFrame(): number {
  const items = useItemsStore.getState().items
  const fps = useTimelineSettingsStore.getState().fps
  return getEffectiveTimelineMaxFrame(items, fps)
}

export function addMarker(frame: number, color?: string, label?: string): void {
  execute(
    'ADD_MARKER',
    () => {
      useMarkersStore.getState().addMarker(frame, color, label)
      useTimelineSettingsStore.getState().markDirty()
    },
    { frame, color, label },
  )
}

export function updateMarker(id: string, updates: Partial<Omit<ProjectMarker, 'id'>>): void {
  execute(
    'UPDATE_MARKER',
    () => {
      useMarkersStore.getState().updateMarker(id, updates)
      useTimelineSettingsStore.getState().markDirty()
    },
    { id, updates },
  )
}

export function removeMarker(id: string): void {
  execute(
    'REMOVE_MARKER',
    () => {
      useMarkersStore.getState().removeMarker(id)
      useTimelineSettingsStore.getState().markDirty()
    },
    { id },
  )
}

export function clearAllMarkers(): void {
  execute('CLEAR_MARKERS', () => {
    useMarkersStore.getState().clearAllMarkers()
    useTimelineSettingsStore.getState().markDirty()
  })
}

export interface ChapterMarkerInput {
  frame: number
  label: string
  color?: string
}

/**
 * Add a batch of markers in a SINGLE undo entry — used by the agent's
 * detect_chapters tool. Calling addMarker() N times would push N separate undo
 * entries; wrapping the whole batch in one execute() makes the chapter pass
 * atomic, so a single Ctrl+Z clears all the chapter markers at once.
 */
export function addChapterMarkers(markers: ChapterMarkerInput[]): void {
  if (markers.length === 0) return
  execute(
    'ADD_CHAPTER_MARKERS',
    () => {
      for (const marker of markers) {
        useMarkersStore.getState().addMarker(marker.frame, marker.color, marker.label)
      }
      useTimelineSettingsStore.getState().markDirty()
    },
    { count: markers.length },
  )
}

// =============================================================================
// IN/OUT POINT ACTIONS
// =============================================================================

export function setInPoint(frame: number): void {
  execute(
    'SET_IN_POINT',
    () => {
      const outPoint = useMarkersStore.getState().outPoint
      const maxFrame = getEffectiveMaxFrame()

      // Validate: inPoint must be >= 0 and <= maxFrame
      const validatedFrame = Math.max(0, Math.min(frame, maxFrame))

      // If there is no out-point yet, default it to timeline end.
      if (outPoint === null) {
        useMarkersStore.getState().setOutPoint(maxFrame)
      }

      // If inPoint is placed after outPoint, reset outPoint to the end
      if (outPoint !== null && validatedFrame >= outPoint) {
        useMarkersStore.getState().setOutPoint(maxFrame)
      }

      useMarkersStore.getState().setInPoint(validatedFrame)
      useTimelineSettingsStore.getState().markDirty()
    },
    { frame },
  )
}

export function setOutPoint(frame: number): void {
  execute(
    'SET_OUT_POINT',
    () => {
      const inPoint = useMarkersStore.getState().inPoint
      const maxFrame = getEffectiveMaxFrame()

      // Validate: outPoint must be >= 1 and <= maxFrame
      const validatedFrame = Math.max(1, Math.min(frame, maxFrame))

      // If there is no in-point yet, default it to timeline start.
      if (inPoint === null) {
        useMarkersStore.getState().setInPoint(0)
      }

      // If outPoint is placed before inPoint, reset inPoint to the beginning
      if (inPoint !== null && validatedFrame <= inPoint) {
        useMarkersStore.getState().setInPoint(0)
      }

      useMarkersStore.getState().setOutPoint(validatedFrame)
      useTimelineSettingsStore.getState().markDirty()
    },
    { frame },
  )
}

export function clearInOutPoints(): void {
  execute('CLEAR_IN_OUT_POINTS', () => {
    useMarkersStore.getState().clearInOutPoints()
    useTimelineSettingsStore.getState().markDirty()
  })
}

/**
 * Atomic, non-undoable in/out point write used by continuous UI interactions
 * (range drag, post-edit sanitization sync). Sanitizes against the current
 * timeline max frame and does NOT mark the project dirty — callers that own
 * the interaction lifecycle (e.g. mouseup) handle markDirty themselves.
 */
export function setInOutPointsWithoutHistory(
  inPoint: number | null,
  outPoint: number | null,
): void {
  const sanitized = sanitizeInOutPoints({
    inPoint,
    outPoint,
    maxFrame: getEffectiveMaxFrame(),
  })
  useMarkersStore.getState().setInOutPoints(sanitized.inPoint, sanitized.outPoint)
}
