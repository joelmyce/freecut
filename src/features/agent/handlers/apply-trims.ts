/**
 * Browser-side handler for `apply-trims` (M6 — suggest_trims).
 *
 * Mutating. Removes a set of source-native trim ranges from a single timeline
 * clip via `removeTrimRangesFromItems` — the same split + ripple + subtitle-
 * realign machinery as silence/filler removal, in ONE undo entry (a single
 * Ctrl+Z restores the clip). Runs only AFTER the user approves the trims on the
 * M5.2 confirmation card, so this handler does no approval of its own.
 *
 * Read/write split (M4.1): the read half is `read-asset-transcript` (used by
 * suggest_trims to fetch the transcript); this handler only mutates.
 */

import { createLogger } from '@/shared/logging/logger'
import {
  removeTrimRangesFromItems,
  useItemsStore,
  type RemoveSilenceRange,
} from '../deps/timeline-contract'
import type { BrowserActionHandler } from './types'

const log = createLogger('agent-handler-apply-trims')

interface TrimRange {
  startSec: number
  endSec: number
}

interface ApplyTrimsArgs {
  clipId: string
  trims: TrimRange[]
}

interface ApplyTrimsResult {
  removedItemCount: number
  splitCount: number
  analyzedItemCount: number
}

export const applyTrimsHandler: BrowserActionHandler = async (rawArgs) => {
  const args = rawArgs as ApplyTrimsArgs
  if (!args.clipId) throw new Error('apply-trims requires clipId')
  if (!Array.isArray(args.trims) || args.trims.length === 0) {
    throw new Error('apply-trims requires a non-empty trims array')
  }

  const item = useItemsStore.getState().items.find((i) => i.id === args.clipId)
  if (!item) throw new Error(`apply-trims: clip ${args.clipId} not found on timeline`)
  if (item.type !== 'video' && item.type !== 'audio') {
    throw new Error(
      `apply-trims: clip ${args.clipId} is a ${item.type} clip; only video/audio clips can be trimmed`,
    )
  }
  const mediaId = item.mediaId
  if (!mediaId) throw new Error(`apply-trims: clip ${args.clipId} has no backing media`)

  const ranges: RemoveSilenceRange[] = args.trims
    .filter(
      (t) =>
        typeof t.startSec === 'number' &&
        typeof t.endSec === 'number' &&
        Number.isFinite(t.startSec) &&
        Number.isFinite(t.endSec) &&
        t.endSec > t.startSec,
    )
    .map((t) => ({ start: t.startSec, end: t.endSec }))

  if (ranges.length === 0) throw new Error('apply-trims: no valid trim ranges to apply')

  const result = removeTrimRangesFromItems([args.clipId], { [mediaId]: ranges })
  log.debug(
    `applied ${ranges.length} trims to ${args.clipId}: removed ${result.removedItemCount}, splits ${result.splitCount}`,
  )

  return {
    removedItemCount: result.removedItemCount,
    splitCount: result.splitCount,
    analyzedItemCount: result.analyzedItemCount,
  } satisfies ApplyTrimsResult
}
