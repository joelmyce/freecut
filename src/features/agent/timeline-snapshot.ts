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

  const mediaById: Record<string, { fileName: string } | undefined> = {}
  for (const [id, meta] of Object.entries(media.mediaById)) {
    if (meta) mediaById[id] = { fileName: meta.fileName }
  }

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
  }
}
