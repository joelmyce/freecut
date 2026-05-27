/**
 * Reference / time-range pill picker (PHASE-1-PLAN.md §6.5.2.2).
 *
 * Below the chat input, a tiny popover lets the user attach a `[Clip: foo.mp4
 * on V1 at 0:00]` reference or a `[Time Range: 0:12-0:18]` scope to their
 * message. The pills compile to bracket-tagged context lines that get
 * prepended to the user's prompt by `use-agent-chat`, making "regenerate this
 * clip" deterministic instead of relying on the agent to guess from the
 * timeline summary.
 *
 * Data sources are stores we already read for the timeline summary
 * (selection + markers + items). No new state lives in this module.
 */

import { memo, useState, useCallback } from 'react'
import { Plus, Tag, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { usePlaybackStore } from '@/shared/state/playback/store'
import { useSelectionStore } from '@/shared/state/selection/store'
import { useItemsStore, useMarkersStore, useTimelineSettingsStore } from '../deps/timeline-contract'
import { formatRange, type ReferencePill } from './reference-pill-utils'

export type { ReferencePill } from './reference-pill-utils'

interface ReferencePillPickerProps {
  pills: ReadonlyArray<ReferencePill>
  disabled: boolean
  onAdd(pill: ReferencePill): void
  onRemove(index: number): void
}

export const ReferencePillPicker = memo(function ReferencePillPicker({
  pills,
  disabled,
  onAdd,
  onRemove,
}: ReferencePillPickerProps) {
  const [open, setOpen] = useState(false)

  const handleAddSelectedClip = useCallback(() => {
    const pill = buildSelectedClipPill()
    if (pill) {
      onAdd(pill)
      setOpen(false)
    }
  }, [onAdd])

  const handleAddInOutRange = useCallback(() => {
    const pill = buildInOutRangePill()
    if (pill) {
      onAdd(pill)
      setOpen(false)
    }
  }, [onAdd])

  const handleAddPlayheadRange = useCallback(
    (windowSeconds: number) => {
      const pill = buildPlayheadRangePill(windowSeconds)
      if (pill) {
        onAdd(pill)
        setOpen(false)
      }
    },
    [onAdd],
  )

  return (
    <div className="flex flex-wrap items-center gap-1 px-2 pt-1 pb-1 shrink-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className="inline-flex items-center gap-1 text-[10px] leading-tight px-1.5 py-0.5 rounded border border-dashed border-border bg-background hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Attach a reference (clip or time range) to your message"
            data-testid="agent-pill-picker-trigger"
          >
            <Plus className="h-3 w-3" />
            <span>Attach</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="p-2 w-60 text-xs"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex flex-col gap-1.5">
            <PickerRow
              icon={<Tag className="h-3 w-3" />}
              label="Selected clip"
              hint={describeSelectedClip()}
              onClick={handleAddSelectedClip}
              disabled={!canAddSelectedClip()}
            />
            <PickerRow
              icon={<Tag className="h-3 w-3" />}
              label="In/Out range"
              hint={describeInOutRange()}
              onClick={handleAddInOutRange}
              disabled={!canAddInOutRange()}
            />
            <div className="text-[10px] text-muted-foreground/70 mt-1 mb-0.5 px-1">
              Around playhead
            </div>
            <div className="flex gap-1 px-1">
              {[2, 5, 10].map((sec) => (
                <button
                  key={sec}
                  type="button"
                  className="flex-1 text-[10px] leading-tight px-1.5 py-1 rounded border border-border bg-background hover:bg-muted/60 text-foreground transition-colors"
                  onClick={() => handleAddPlayheadRange(sec)}
                >
                  ±{sec}s
                </button>
              ))}
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {pills.map((pill, index) => (
        <PillBadge key={`${pill.kind}-${index}`} pill={pill} onRemove={() => onRemove(index)} />
      ))}
    </div>
  )
})

interface PickerRowProps {
  icon: React.ReactNode
  label: string
  hint?: string | null
  disabled?: boolean
  onClick(): void
}

function PickerRow({ icon, label, hint, disabled, onClick }: PickerRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1.5 px-1.5 py-1 rounded text-left hover:bg-muted/60 disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {icon}
      <span className="flex-1">{label}</span>
      <span className="text-[10px] text-muted-foreground/70 truncate max-w-[120px]">
        {hint ?? '—'}
      </span>
    </button>
  )
}

function PillBadge({ pill, onRemove }: { pill: ReferencePill; onRemove(): void }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] leading-tight px-1.5 py-0.5 rounded-full bg-primary/15 text-primary border border-primary/30">
      <span className="truncate max-w-[140px]">{describePill(pill)}</span>
      <button
        type="button"
        onClick={onRemove}
        className="hover:text-foreground"
        aria-label="Remove reference"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  )
}

/* -------------------- builders + describers -------------------- */

function buildSelectedClipPill(): ReferencePill | null {
  const selectedIds = useSelectionStore.getState().selectedItemIds
  const firstId = selectedIds[0]
  if (!firstId) return null
  const items = useItemsStore.getState().items
  const tracks = useItemsStore.getState().tracks
  const item = items.find((i) => i.id === firstId)
  if (!item) return null
  const fps = useTimelineSettingsStore.getState().fps
  const track = tracks.find((t) => t.id === item.trackId)
  return {
    kind: 'clip',
    itemId: item.id,
    label: getDisplayLabel(item),
    trackName: track?.name ?? 'Track',
    fromSeconds: Number.isFinite(fps) && fps > 0 ? item.from / fps : 0,
  }
}

function canAddSelectedClip(): boolean {
  return useSelectionStore.getState().selectedItemIds.length > 0
}

function describeSelectedClip(): string | null {
  const pill = buildSelectedClipPill()
  if (!pill || pill.kind !== 'clip') return 'nothing selected'
  return pill.label
}

function buildInOutRangePill(): ReferencePill | null {
  const markers = useMarkersStore.getState()
  if (markers.inPoint === null || markers.outPoint === null) return null
  const fps = useTimelineSettingsStore.getState().fps
  if (!Number.isFinite(fps) || fps <= 0) return null
  const startSeconds = markers.inPoint / fps
  const endSeconds = markers.outPoint / fps
  if (endSeconds <= startSeconds) return null
  return { kind: 'range', startSeconds, endSeconds }
}

function canAddInOutRange(): boolean {
  const markers = useMarkersStore.getState()
  return markers.inPoint !== null && markers.outPoint !== null
}

function describeInOutRange(): string | null {
  const pill = buildInOutRangePill()
  if (!pill || pill.kind !== 'range') return 'no in/out set'
  return formatRange(pill.startSeconds, pill.endSeconds)
}

function buildPlayheadRangePill(windowSeconds: number): ReferencePill | null {
  const fps = useTimelineSettingsStore.getState().fps
  if (!Number.isFinite(fps) || fps <= 0) return null
  const currentSec = usePlaybackStore.getState().currentFrame / fps
  const startSeconds = Math.max(0, currentSec - windowSeconds / 2)
  const endSeconds = currentSec + windowSeconds / 2
  return { kind: 'range', startSeconds, endSeconds }
}

function describePill(pill: ReferencePill): string {
  if (pill.kind === 'clip') {
    return `Clip: ${pill.label} on ${pill.trackName}`
  }
  return `Range: ${formatRange(pill.startSeconds, pill.endSeconds)}`
}

function getDisplayLabel(item: { type: string; label?: string; mediaId?: string }): string {
  if (item.label) return item.label
  return item.mediaId ? `clip ${item.mediaId.slice(0, 8)}` : item.type
}
