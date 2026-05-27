import type { TimelineAgentSnapshot } from '@/shared/state/agent'
import { usePlaybackStore } from '@/shared/state/playback/store'
import { useSelectionStore } from '@/shared/state/selection/store'
import { useProjectStore } from './deps/projects-contract'
import { useMediaLibraryStore } from './deps/media-library-contract'
import {
  useCompositionNavigationStore,
  useItemsStore,
  useMarkersStore,
  useTimelineSettingsStore,
} from './deps/timeline-contract'

/**
 * Reads every store the timeline summary needs and returns a normalized
 * snapshot. Called once per outgoing user-message to give the agent the live
 * project state. Pure stores → snapshot mapping; the summarization itself
 * lives in `@/shared/state/agent` and stays decoupled from features.
 */
export function captureTimelineAgentSnapshot(): TimelineAgentSnapshot {
  const project = useProjectStore.getState().currentProject
  const fps = useTimelineSettingsStore.getState().fps
  const items = useItemsStore.getState().items
  const tracks = useItemsStore.getState().tracks
  const playback = usePlaybackStore.getState()
  const markers = useMarkersStore.getState()
  const selection = useSelectionStore.getState()
  const composition = useCompositionNavigationStore.getState()
  const media = useMediaLibraryStore.getState()

  const resolution = project
    ? { width: project.metadata.width, height: project.metadata.height }
    : null

  const activeComposition = composition.activeCompositionId
  const activeLabel =
    activeComposition && composition.breadcrumbs.length > 0
      ? (composition.breadcrumbs.at(-1)?.label ?? null)
      : null

  const mediaById: Record<string, { fileName: string; aiGenerated?: boolean } | undefined> = {}
  for (const [id, meta] of Object.entries(media.mediaById)) {
    if (meta) {
      mediaById[id] = {
        fileName: meta.fileName,
        aiGenerated: meta.aiGenerated ? true : undefined,
      }
    }
  }

  // §6.5.2.3 — UI-state flags. Lets the agent infer "this clip" / "right here"
  // without an extra tool call. Pure derived state from stores we already have.
  const playheadInsideClipId =
    items.find(
      (item) =>
        playback.currentFrame >= item.from &&
        playback.currentFrame < item.from + item.durationInFrames &&
        item.type !== 'shape' &&
        item.type !== 'adjustment',
    )?.id ?? null

  const firstSelectedId = selection.selectedItemIds[0]
  const firstSelected = firstSelectedId
    ? items.find((item) => item.id === firstSelectedId)
    : undefined
  const selectedMediaId =
    firstSelected &&
    (firstSelected.type === 'video' ||
      firstSelected.type === 'audio' ||
      firstSelected.type === 'image')
      ? firstSelected.mediaId
      : undefined
  const selectedClipIsAiGenerated = selectedMediaId
    ? Boolean(media.mediaById[selectedMediaId]?.aiGenerated)
    : false

  return {
    fps,
    resolution,
    composition: {
      activeId: activeComposition ?? null,
      activeLabel,
    },
    tracks,
    items,
    selection: { itemIds: selection.selectedItemIds },
    playback: { currentFrame: playback.currentFrame },
    markers: { inPoint: markers.inPoint, outPoint: markers.outPoint },
    mediaById,
    pendingGenerations: media.transcriptProgress.size,
    uiFlags: {
      playheadInsideClipId,
      selectedClipIsAiGenerated,
    },
  }
}
