/**
 * Browser-side handler for the `cut_silence` tool (M4.2 — first pure-local tool).
 *
 * Existing browser primitives already cover the work:
 *   - `analyzeSilenceForItems()` decodes audio via the shared preview cache
 *     and runs `detectSilentRanges` (RMS + window).
 *   - `removeSilenceFromItems()` splits the clip at every silence boundary,
 *     removes the dead segments, ripples the trailing items, and partitions
 *     subtitle cues — all inside one `execute()` so a single Ctrl+Z undoes
 *     the whole edit.
 *
 * This handler is a thin orchestrator that runs both steps and returns a
 * concise summary the agent can quote back to the user. The "server pulls
 * decoded audio over the bridge" path from PHASE-1-PLAN.md §6.2 is skipped
 * deliberately: the analysis already lives in-browser, going through the
 * bridge round-trip would add latency for zero benefit.
 */

import { createLogger } from '@/shared/logging/logger'
import {
  analyzeSilenceForItems,
  DEFAULT_SILENCE_REMOVAL_SETTINGS,
  removeSilenceFromItems,
  useItemsStore,
} from '../deps/timeline-contract'
import type { BrowserActionHandler } from './types'

const log = createLogger('agent-handler-cut-silence')

interface CutSilenceArgs {
  clipId: string
  thresholdDb?: number
  minSilenceSec?: number
  paddingMs?: number
}

interface CutSilenceResult {
  silenceRangeCount: number
  removedDurationSec: number
  splitCount: number
  removedItemCount: number
  thresholdDb: number
  minSilenceSec: number
}

export const cutSilenceHandler: BrowserActionHandler = async (rawArgs) => {
  const args = rawArgs as CutSilenceArgs
  if (!args.clipId) throw new Error('cut-silence requires clipId')

  const item = useItemsStore.getState().items.find((i) => i.id === args.clipId)
  if (!item) throw new Error(`clip ${args.clipId} not found on timeline`)
  if (item.type !== 'video' && item.type !== 'audio') {
    throw new Error(`cut_silence only works on video or audio clips, got ${item.type}`)
  }
  if (!item.mediaId) throw new Error(`clip ${args.clipId} has no underlying mediaId`)

  const settings = {
    ...DEFAULT_SILENCE_REMOVAL_SETTINGS,
    thresholdDb: args.thresholdDb ?? DEFAULT_SILENCE_REMOVAL_SETTINGS.thresholdDb,
    minSilenceMs:
      typeof args.minSilenceSec === 'number'
        ? Math.round(args.minSilenceSec * 1000)
        : DEFAULT_SILENCE_REMOVAL_SETTINGS.minSilenceMs,
    paddingMs: args.paddingMs ?? DEFAULT_SILENCE_REMOVAL_SETTINGS.paddingMs,
  }

  log.debug(`analyzing silence for clip ${args.clipId}`, settings)
  const rangesByMediaId = await analyzeSilenceForItems([args.clipId], settings)
  const ranges = rangesByMediaId[item.mediaId] ?? []

  if (ranges.length === 0) {
    const result: CutSilenceResult = {
      silenceRangeCount: 0,
      removedDurationSec: 0,
      splitCount: 0,
      removedItemCount: 0,
      thresholdDb: settings.thresholdDb,
      minSilenceSec: settings.minSilenceMs / 1000,
    }
    return result
  }

  const totalSilenceSec = ranges.reduce((sum, r) => sum + Math.max(0, r.end - r.start), 0)
  const removalSummary = removeSilenceFromItems([args.clipId], rangesByMediaId)

  const result: CutSilenceResult = {
    silenceRangeCount: ranges.length,
    removedDurationSec: round1(totalSilenceSec),
    splitCount: removalSummary.splitCount,
    removedItemCount: removalSummary.removedItemCount,
    thresholdDb: settings.thresholdDb,
    minSilenceSec: settings.minSilenceMs / 1000,
  }
  return result
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
