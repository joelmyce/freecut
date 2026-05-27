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
import { useTimelineCommandStore } from '../timeline-command-store'
import { useTimelineSettingsStore } from '../timeline-settings-store'
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
