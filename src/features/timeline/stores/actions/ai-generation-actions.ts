/**
 * Timeline actions for AI-generation placeholders.
 *
 * Unlike other timeline actions, the placeholder INSERT is intentionally
 * kept out of the undo stack — a generation run that ultimately swaps in
 * a real clip should look to the user like a single user action, where
 * one Ctrl+Z removes the final clip and a second is a no-op. To achieve
 * that we:
 *   1. Capture a "pre-generation" snapshot at insert time.
 *   2. Mutate the items store directly (bypassing `execute()`).
 *   3. On a successful swap, push the pre-generation snapshot to the
 *      command store via `addUndoEntry`, so undoing the swap rewinds
 *      *past* the placeholder to the state before generation started.
 *   4. On cancel/failure, mutate directly with no undo entry — the user
 *      hasn't "done" anything they should be able to undo.
 */

import type { ShapeItem, TimelineItem } from '@/types/timeline'
import type { TimelineSnapshot } from '../commands/types'
import { captureSnapshot } from '../commands/snapshot'
import { useItemsStore } from '../items-store'
import { useKeyframesStore } from '../keyframes-store'
import { useTimelineCommandStore } from '../timeline-command-store'
import { useTimelineSettingsStore } from '../timeline-settings-store'
import { useTransitionsStore } from '../transitions-store'
import { getLogger } from './shared'

/** Pre-generation snapshot keyed by placeholder id. Cleared on swap/remove. */
const pendingSnapshots = new Map<string, TimelineSnapshot>()

export interface InsertGenerationPlaceholderParams {
  trackId: string
  from: number
  durationInFrames: number
  prompt: string
  providerId?: string
  modelId?: string
}

/**
 * Insert a placeholder ShapeItem covering the requested time range.
 * Returns the new item id; the caller passes it back to
 * {@link swapPlaceholderWithMedia} / {@link removeGenerationPlaceholder} /
 * {@link markGenerationPlaceholderError}.
 *
 * Mutates the items store directly — does NOT add an undo entry. The
 * eventual swap (or removal) is what shows up in the undo stack.
 */
export function insertGenerationPlaceholder(params: InsertGenerationPlaceholderParams): string {
  const id = crypto.randomUUID()
  const placeholder: ShapeItem = {
    id,
    trackId: params.trackId,
    from: params.from,
    durationInFrames: params.durationInFrames,
    label: `Generating: ${truncate(params.prompt)}`,
    type: 'shape',
    shapeType: 'rectangle',
    fillColor: '#0F172A',
    strokeColor: '#3B82F6',
    strokeWidth: 2,
    cornerRadius: 8,
    aiPlaceholder: {
      prompt: params.prompt,
      status: 'generating',
      providerId: params.providerId,
      modelId: params.modelId,
    },
  }

  const beforeSnapshot = captureSnapshot()
  pendingSnapshots.set(id, beforeSnapshot)

  useItemsStore.getState()._addItem(placeholder)
  useTimelineSettingsStore.getState().markDirty()

  getLogger().debug(`[ai-gen] inserted placeholder ${id} for prompt "${params.prompt}"`)
  return id
}

export interface ReplaceClipWithPlaceholderParams {
  /** Existing timeline item id whose range becomes the placeholder window. */
  clipId: string
  /** Prompt shown on the placeholder. */
  prompt: string
  providerId?: string
  modelId?: string
}

export interface ReplaceClipWithPlaceholderResult {
  placeholderId: string
  trackId: string
  from: number
  durationInFrames: number
}

/**
 * Replace an existing timeline clip with a generation placeholder occupying
 * the same track/time window. The original clip is removed and a placeholder
 * inserted in its place. The pre-mutation snapshot (which still contains the
 * original clip + its transitions/keyframes) is stashed under the placeholder
 * id, so a later {@link swapPlaceholderWithMedia} call lets a single Ctrl+Z
 * restore the original clip — matching M3's "one Ctrl+Z rewinds past the
 * generation" semantics.
 *
 * Cleanup of the original clip's transitions and keyframes happens inline so
 * the live store stays consistent during the wait; the snapshot still has
 * them, so undo restores everything.
 *
 * Mutates stores directly — does NOT add an undo entry. The eventual swap
 * (or removal) is what shows up in the undo stack.
 */
export function replaceClipWithPlaceholder(
  params: ReplaceClipWithPlaceholderParams,
): ReplaceClipWithPlaceholderResult {
  const items = useItemsStore.getState().items
  const original = items.find((i) => i.id === params.clipId)
  if (!original) {
    throw new Error(`replaceClipWithPlaceholder: clip ${params.clipId} not found`)
  }

  const beforeSnapshot = captureSnapshot()

  const placeholderId = crypto.randomUUID()
  const placeholder: ShapeItem = {
    id: placeholderId,
    trackId: original.trackId,
    from: original.from,
    durationInFrames: original.durationInFrames,
    label: `Regenerating: ${truncate(params.prompt)}`,
    type: 'shape',
    shapeType: 'rectangle',
    fillColor: '#0F172A',
    strokeColor: '#3B82F6',
    strokeWidth: 2,
    cornerRadius: 8,
    aiPlaceholder: {
      prompt: params.prompt,
      status: 'generating',
      providerId: params.providerId,
      modelId: params.modelId,
    },
  }

  pendingSnapshots.set(placeholderId, beforeSnapshot)

  const itemsStore = useItemsStore.getState()
  itemsStore._removeItems([original.id])
  itemsStore._addItem(placeholder)
  // Strip the original clip's transitions/keyframes so the placeholder doesn't
  // try to inherit them. They survive in beforeSnapshot, so undo restores them.
  useTransitionsStore.getState()._removeTransitionsForItems([original.id])
  useKeyframesStore.getState()._removeKeyframesForItems([original.id])
  useTimelineSettingsStore.getState().markDirty()

  getLogger().debug(
    `[ai-gen] replaced clip ${original.id} with placeholder ${placeholderId} for regen`,
  )

  return {
    placeholderId,
    trackId: placeholder.trackId,
    from: placeholder.from,
    durationInFrames: placeholder.durationInFrames,
  }
}

/**
 * Atomically replace a placeholder with a real timeline item. Pushes a
 * single undo entry whose "before" state is the pre-generation snapshot,
 * so Ctrl+Z rewinds past the placeholder altogether.
 *
 * Returns `true` if the swap happened; `false` if the placeholder was
 * already gone (e.g. user cancelled before the swap fired).
 */
export function swapPlaceholderWithMedia(
  placeholderId: string,
  replacement: TimelineItem,
): boolean {
  const beforeSnapshot = pendingSnapshots.get(placeholderId)
  if (!beforeSnapshot) {
    getLogger().warn(`[ai-gen] swap requested for unknown placeholder ${placeholderId}`)
    return false
  }
  const items = useItemsStore.getState()
  const exists = items.items.some((i) => i.id === placeholderId)
  if (!exists) {
    pendingSnapshots.delete(placeholderId)
    getLogger().warn(`[ai-gen] placeholder ${placeholderId} not found in store at swap time`)
    return false
  }

  items._removeItems([placeholderId])
  items._addItem(replacement)
  useTimelineSettingsStore.getState().markDirty()

  useTimelineCommandStore.getState().addUndoEntry(
    {
      type: 'AI_GENERATE',
      payload: { newItemId: replacement.id, replacedPlaceholderId: placeholderId },
    },
    beforeSnapshot,
  )

  pendingSnapshots.delete(placeholderId)
  getLogger().debug(`[ai-gen] swapped placeholder ${placeholderId} for item ${replacement.id}`)
  return true
}

/**
 * Remove a placeholder without leaving any undo entry. For cancel and
 * silent-failure paths.
 */
export function removeGenerationPlaceholder(placeholderId: string): void {
  const items = useItemsStore.getState()
  items._removeItems([placeholderId])
  useTimelineSettingsStore.getState().markDirty()
  pendingSnapshots.delete(placeholderId)
  getLogger().debug(`[ai-gen] removed placeholder ${placeholderId}`)
}

/**
 * Transition a placeholder to its error visual. Keeps the placeholder on
 * the timeline so the user can see what failed and (later) retry; does
 * NOT add an undo entry. The user can dismiss the failed placeholder via
 * the chat retry/dismiss UI.
 */
export function markGenerationPlaceholderError(placeholderId: string, errorMessage: string): void {
  const item = useItemsStore.getState().items.find((i) => i.id === placeholderId)
  if (!item || item.type !== 'shape' || !item.aiPlaceholder) return

  useItemsStore.getState()._updateItem(placeholderId, {
    label: `Failed: ${truncate(item.aiPlaceholder.prompt)}`,
    strokeColor: '#EF4444',
    aiPlaceholder: {
      ...item.aiPlaceholder,
      status: 'error',
      errorMessage,
    },
  } as Partial<ShapeItem>)
  useTimelineSettingsStore.getState().markDirty()

  getLogger().debug(`[ai-gen] marked placeholder ${placeholderId} as error: ${errorMessage}`)
}

/** Test helper. Not exported from `actions/index.ts`. */
export function __clearPendingSnapshots(): void {
  pendingSnapshots.clear()
}

function truncate(text: string, max = 60): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}
