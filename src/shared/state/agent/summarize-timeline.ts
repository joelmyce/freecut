import type {
  CompositionItem,
  ShapeItem,
  SubtitleSegmentItem,
  TextItem,
  TimelineItem,
  TimelineTrack,
} from '@/types/timeline'

/**
 * Snapshot of editor state used to produce a textual timeline summary for the
 * agent. The snapshot is passed in by the caller — this module deliberately
 * doesn't reach into stores so it stays in `src/shared/` (no feature imports)
 * and is trivial to unit-test.
 *
 * The store-reading wrapper lives in `src/features/agent/` and is responsible
 * for assembling the snapshot before each `user-message` is sent to the
 * agent-server.
 */
export interface TimelineAgentSnapshot {
  fps: number
  resolution: { width: number; height: number } | null
  composition: { activeId: string | null; activeLabel: string | null }
  tracks: ReadonlyArray<TimelineTrack>
  items: ReadonlyArray<TimelineItem>
  selection: { itemIds: ReadonlyArray<string> }
  playback: { currentFrame: number }
  markers: { inPoint: number | null; outPoint: number | null }
  mediaById: Readonly<Record<string, { fileName: string } | undefined>>
  pendingGenerations: number
}

const MAX_ITEMS_PER_TRACK_LINE = 20
const MAX_LABEL_LEN = 40

export function summarizeTimelineForAgent(snapshot: TimelineAgentSnapshot): string {
  const lines: string[] = []
  lines.push(renderHeader(snapshot))

  const itemsByTrack = groupItemsByTrack(snapshot.items)
  const orderedTracks = [...snapshot.tracks]
    .filter((t) => !t.isGroup)
    .sort((a, b) => a.order - b.order)

  for (const track of orderedTracks) {
    const trackItems = itemsByTrack.get(track.id) ?? []
    lines.push(renderTrackLine(track, trackItems, snapshot))
  }

  const selectionLine = renderSelectionLine(snapshot)
  if (selectionLine !== null) lines.push(selectionLine)

  lines.push(renderPlayheadLine(snapshot))
  lines.push(`Pending generations: ${snapshot.pendingGenerations}`)

  return lines.join('\n')
}

function renderHeader(snapshot: TimelineAgentSnapshot): string {
  const totalFrames = computeTimelineExtent(snapshot.items)
  const totalLabel = formatFrames(totalFrames, snapshot.fps)
  const resolutionLabel = snapshot.resolution
    ? `${snapshot.resolution.width}x${snapshot.resolution.height}`
    : 'unknown size'
  const compositionTag = snapshot.composition.activeId
    ? ` (in composition "${snapshot.composition.activeLabel ?? snapshot.composition.activeId}")`
    : ''
  return `Timeline${compositionTag} — ${snapshot.fps} fps, ${resolutionLabel}, ${totalLabel} total`
}

function renderTrackLine(
  track: TimelineTrack,
  trackItems: ReadonlyArray<TimelineItem>,
  snapshot: TimelineAgentSnapshot,
): string {
  const prefix = `  ${track.name}`
  if (trackItems.length === 0) {
    return `${prefix}  (empty)`
  }
  const flagSuffix = trackFlags(track)
  const shown = trackItems.slice(0, MAX_ITEMS_PER_TRACK_LINE)
  const cells = shown.map((item) => renderItemCell(item, snapshot, flagSuffix))
  const overflow = trackItems.length - shown.length
  const more = overflow > 0 ? ` [+${overflow} more]` : ''
  return `${prefix}  ${cells.join(' ')}${more}`
}

function trackFlags(track: TimelineTrack): string {
  const flags: string[] = []
  if (track.muted) flags.push('muted')
  if (!track.visible) flags.push('hidden')
  if (track.locked) flags.push('locked')
  return flags.length > 0 ? `, ${flags.join(', ')}` : ''
}

function renderItemCell(
  item: TimelineItem,
  snapshot: TimelineAgentSnapshot,
  flagSuffix: string,
): string {
  const start = formatFrames(item.from, snapshot.fps)
  const end = formatFrames(item.from + item.durationInFrames, snapshot.fps)
  const body = renderItemBody(item, snapshot)
  return `[${start}-${end} ${body} (${item.id}${flagSuffix})]`
}

function renderItemBody(item: TimelineItem, snapshot: TimelineAgentSnapshot): string {
  switch (item.type) {
    case 'video':
    case 'audio':
    case 'image': {
      const fileName = item.mediaId
        ? (snapshot.mediaById[item.mediaId]?.fileName ?? item.label)
        : item.label
      return truncate(fileName, MAX_LABEL_LEN)
    }
    case 'text':
      return `"${truncate((item as TextItem).label, MAX_LABEL_LEN)}"`
    case 'shape':
      return `shape:${truncate((item as ShapeItem).label, MAX_LABEL_LEN)}`
    case 'adjustment':
      return 'adjustment'
    case 'composition':
      return `comp:"${truncate((item as CompositionItem).label, MAX_LABEL_LEN)}"`
    case 'subtitle': {
      const cueCount = (item as SubtitleSegmentItem).cues?.length ?? 0
      return `${cueCount} segments`
    }
    default: {
      // Exhaustive — TS will complain if a new TimelineItem variant lands.
      const _exhaustive: never = item
      return String(_exhaustive)
    }
  }
}

function renderSelectionLine(snapshot: TimelineAgentSnapshot): string | null {
  if (snapshot.selection.itemIds.length === 0) return null
  const firstId = snapshot.selection.itemIds[0]
  if (!firstId) return null
  const first = snapshot.items.find((i) => i.id === firstId)
  if (!first) return null
  const display = renderItemBody(first, snapshot)
  const more =
    snapshot.selection.itemIds.length > 1 ? ` (+${snapshot.selection.itemIds.length - 1} more)` : ''
  return `Selected: ${first.id} ${display}${more}`
}

function renderPlayheadLine(snapshot: TimelineAgentSnapshot): string {
  const parts: string[] = [
    `Playhead: ${formatFrames(snapshot.playback.currentFrame, snapshot.fps)}`,
  ]
  const { inPoint, outPoint } = snapshot.markers
  if (inPoint !== null || outPoint !== null) {
    parts.push(
      `In: ${inPoint !== null ? formatFrames(inPoint, snapshot.fps) : '(none)'}`,
      `Out: ${outPoint !== null ? formatFrames(outPoint, snapshot.fps) : '(none)'}`,
    )
  }
  return parts.join('  ')
}

function groupItemsByTrack(items: ReadonlyArray<TimelineItem>): Map<string, TimelineItem[]> {
  const byTrack = new Map<string, TimelineItem[]>()
  for (const item of items) {
    const arr = byTrack.get(item.trackId) ?? []
    arr.push(item)
    byTrack.set(item.trackId, arr)
  }
  for (const arr of byTrack.values()) arr.sort((a, b) => a.from - b.from)
  return byTrack
}

function computeTimelineExtent(items: ReadonlyArray<TimelineItem>): number {
  let max = 0
  for (const item of items) {
    const end = item.from + item.durationInFrames
    if (end > max) max = end
  }
  return max
}

function formatFrames(frame: number, fps: number): string {
  if (!Number.isFinite(fps) || fps <= 0) return '?:??'
  const totalSeconds = Math.max(0, Math.floor(frame / fps))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`
  return `${pad(minutes)}:${pad(seconds)}`
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}
