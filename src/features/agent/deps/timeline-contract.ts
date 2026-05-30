export { useItemsStore } from '@/features/timeline/stores/items-store'
export type { KeyframeAddPayload } from '@/features/timeline/stores/keyframes-store'
export { useTimelineSettingsStore } from '@/features/timeline/stores/timeline-settings-store'
export {
  insertMotionGraphic,
  type MotionGraphicLayer,
} from '@/features/timeline/stores/actions/motion-graphic-actions'
export { useMarkersStore } from '@/features/timeline/stores/markers-store'
export { useCompositionNavigationStore } from '@/features/timeline/stores/composition-navigation-store'
export {
  insertGenerationPlaceholder,
  swapPlaceholderWithMedia,
  removeGenerationPlaceholder,
  markGenerationPlaceholderError,
  replaceClipWithPlaceholder,
} from '@/features/timeline/stores/actions/ai-generation-actions'
export { addItem } from '@/features/timeline/stores/actions/item-actions'
export {
  addChapterMarkers,
  type ChapterMarkerInput,
} from '@/features/timeline/stores/actions/marker-actions'
export { buildMediaTimelineItem } from '@/features/timeline/utils/media-timeline-item-builder'
export { findCompatibleTrackForItemType } from '@/features/timeline/utils/track-item-compatibility'
export {
  removeSilenceFromItems,
  removeTrimRangesFromItems,
  type RemoveSilenceRange,
  type RemoveSilenceResult,
} from '@/features/timeline/stores/actions/item-edit-actions'
export {
  analyzeSilenceForItems,
  DEFAULT_SILENCE_REMOVAL_SETTINGS,
  type SilenceRemovalSettings,
  type SilenceRangesByMediaId,
} from '@/features/timeline/utils/silence-removal-preview'
