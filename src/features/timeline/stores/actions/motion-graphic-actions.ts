/**
 * Motion-graphic actions (M6.4 — agent `add_motion_graphic`).
 *
 * Inserts a native motion graphic — already-materialized text/shape items plus
 * their keyframes — onto the timeline. Each layer gets its OWN dedicated track,
 * stacked at the TOP so the whole graphic renders above existing content. Tracks
 * + items + keyframes are committed in a SINGLE `execute()` so one Ctrl+Z removes
 * the entire graphic.
 *
 * The agent handler (`src/features/agent/handlers/add-motion-graphic.ts`) owns
 * all resolution math (fractions→pixels, seconds→frames) and hands this action
 * concrete items; this action owns track creation, z-ordering, and the atomic
 * commit. Read/write are split across the bridge per the skills-prep convention.
 */

import type { TimelineItem } from '@/types/timeline'
import { useItemsStore } from '../items-store'
import { useKeyframesStore, type KeyframeAddPayload } from '../keyframes-store'
import { useTimelineSettingsStore } from '../timeline-settings-store'
import { createClassicTrack } from '../../utils/classic-tracks'
import { execute } from './shared'

export interface MotionGraphicLayer {
  /**
   * Concrete timeline item for this layer. `trackId` is ignored / overwritten —
   * this action assigns each layer to its freshly-created dedicated track.
   * Layers must arrive ordered BACK → FRONT (index 0 renders behind the rest).
   */
  item: TimelineItem
  /** Keyframe payloads for this item (each payload's `itemId` must equal `item.id`). */
  keyframes: KeyframeAddPayload[]
  /** Display name for the dedicated track this layer lands on. */
  trackName: string
}

export interface InsertMotionGraphicResult {
  itemIds: string[]
  trackIds: string[]
}

/**
 * Insert a native motion graphic as ONE undo entry. Creates one dedicated
 * `video` track per layer at the top of the timeline, ordered so that
 * `layers[0]` is backmost and the final layer is frontmost, assigns each item to
 * its track, and adds the items + keyframes atomically.
 */
export function insertMotionGraphic(layers: MotionGraphicLayer[]): InsertMotionGraphicResult {
  if (layers.length === 0) return { itemIds: [], trackIds: [] }

  return execute(
    'ADD_MOTION_GRAPHIC',
    () => {
      const existingTracks = useItemsStore.getState().tracks
      const minOrder =
        existingTracks.length > 0 ? Math.min(...existingTracks.map((t) => t.order ?? 0)) : 0

      // One dedicated track per layer, all stacked above existing content
      // (order < minOrder). Lower `order` renders in front, so layers[0]
      // (backmost) gets the HIGHEST order among the new tracks and the final
      // layer (frontmost) gets the LOWEST.
      let workingTracks = existingTracks
      const trackIds: string[] = []
      const itemsToAdd: TimelineItem[] = []

      layers.forEach((layer, index) => {
        const track = createClassicTrack({
          tracks: workingTracks,
          kind: 'video',
          order: minOrder - 1 - index,
        })
        track.name = layer.trackName
        workingTracks = [...workingTracks, track]
        trackIds.push(track.id)
        itemsToAdd.push({ ...layer.item, trackId: track.id })
      })

      useItemsStore.getState().setTracks(workingTracks)
      useItemsStore.getState()._addItems(itemsToAdd)

      const keyframePayloads = layers.flatMap((layer) => layer.keyframes)
      if (keyframePayloads.length > 0) {
        useKeyframesStore.getState()._addKeyframes(keyframePayloads)
      }

      useTimelineSettingsStore.getState().markDirty()

      return { itemIds: itemsToAdd.map((item) => item.id), trackIds }
    },
    { layerCount: layers.length },
  )
}
