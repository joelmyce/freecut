/**
 * Browser-side handlers for `replace_clip_with_regeneration` (M4.1).
 *
 * Two handlers:
 *   - `read-clip-for-regen` — read-only lookup. Returns the clip's range +
 *     the `media/{id}/cache/ai/generation.json` envelope if one exists +
 *     an optional transcript context for the clip's source window (used by
 *     §6.5.1 prompt grounding).
 *   - `replace-clip-with-placeholder` — captures a pre-mutation snapshot,
 *     removes the clip, and inserts a placeholder over the same range.
 *     Returns the placeholder id which the server later passes to the
 *     existing `swap-generation-placeholder-with-url`.
 *
 * The split between read and mutate keeps validation (does the clip exist?
 * does it have a generation record? is there a prompt to use?) on the server
 * before any timeline state changes — fewer half-applied regens when the
 * agent passes bad input.
 */

import { createLogger } from '@/shared/logging/logger'
import { useItemsStore, replaceClipWithPlaceholder } from '../deps/timeline-contract'
import { getTranscript, readAiOutput } from '../deps/storage-contract'
import type { BrowserActionHandler } from './types'

const log = createLogger('agent-handler-regen-clip')

/* -------------------- read-clip-for-regen -------------------- */

interface ReadClipForRegenArgs {
  clipId: string
}

interface ReadClipForRegenResult {
  /** Resolved if the clip is media-backed (video/audio/image). */
  mediaId: string | null
  trackId: string
  from: number
  durationInFrames: number
  itemType: string
  /** Original generation envelope, present iff `media/{id}/cache/ai/generation.json` exists. */
  originalGeneration: {
    provider: string
    model: string
    prompt: string
    cost?: { amount: number; currency: 'USD' }
    durationSec?: number
    params: Record<string, unknown>
  } | null
  /** Concatenated transcript text covering the clip's source window, if a transcript is saved. */
  transcriptContext: {
    text: string
    sourceStartSec: number
    sourceEndSec: number
  } | null
}

export const readClipForRegenHandler: BrowserActionHandler = async (rawArgs) => {
  const args = rawArgs as ReadClipForRegenArgs
  if (!args.clipId) throw new Error('read-clip-for-regen requires clipId')

  const item = useItemsStore.getState().items.find((i) => i.id === args.clipId)
  if (!item) throw new Error(`clip ${args.clipId} not found on timeline`)

  const mediaId =
    item.type === 'video' || item.type === 'audio' || item.type === 'image'
      ? (item.mediaId ?? null)
      : null

  let originalGeneration: ReadClipForRegenResult['originalGeneration'] = null
  if (mediaId) {
    try {
      const env = await readAiOutput(mediaId, 'generation')
      if (env) {
        originalGeneration = {
          provider: env.service,
          model: env.model,
          prompt: env.data.prompt,
          cost: env.data.cost,
          durationSec: env.data.durationSec,
          params: env.params,
        }
      }
    } catch (err) {
      log.warn(`failed to read generation envelope for ${mediaId}`, err)
    }
  }

  const transcriptContext = mediaId ? await readClipTranscriptContext(item, mediaId) : null

  const result: ReadClipForRegenResult = {
    mediaId,
    trackId: item.trackId,
    from: item.from,
    durationInFrames: item.durationInFrames,
    itemType: item.type,
    originalGeneration,
    transcriptContext,
  }
  return result
}

async function readClipTranscriptContext(
  item: { sourceStart?: number; sourceEnd?: number; sourceFps?: number; durationInFrames: number },
  mediaId: string,
): Promise<ReadClipForRegenResult['transcriptContext']> {
  try {
    const transcript = await getTranscript(mediaId)
    if (!transcript || transcript.segments.length === 0) return null

    const sourceFps = item.sourceFps && item.sourceFps > 0 ? item.sourceFps : 30
    const sourceStartSec = (item.sourceStart ?? 0) / sourceFps
    const sourceEndSec =
      item.sourceEnd !== undefined
        ? item.sourceEnd / sourceFps
        : sourceStartSec + item.durationInFrames / sourceFps

    const overlapping = transcript.segments.filter(
      (seg) => seg.end > sourceStartSec && seg.start < sourceEndSec,
    )
    if (overlapping.length === 0) return null

    const text = overlapping
      .map((s) => s.text.trim())
      .filter((t) => t.length > 0)
      .join(' ')
    if (!text) return null

    return { text, sourceStartSec, sourceEndSec }
  } catch (err) {
    log.warn(`failed to read transcript for ${mediaId}`, err)
    return null
  }
}

/* -------------------- replace-clip-with-placeholder -------------------- */

interface ReplaceClipArgs {
  clipId: string
  prompt: string
  providerId?: string
  modelId?: string
}

interface ReplaceClipResult {
  placeholderId: string
  trackId: string
  from: number
  durationInFrames: number
}

export const replaceClipWithPlaceholderHandler: BrowserActionHandler = async (rawArgs) => {
  const args = rawArgs as ReplaceClipArgs
  if (!args.clipId) throw new Error('replace-clip-with-placeholder requires clipId')
  if (!args.prompt) throw new Error('replace-clip-with-placeholder requires a non-empty prompt')

  const result = replaceClipWithPlaceholder({
    clipId: args.clipId,
    prompt: args.prompt,
    providerId: args.providerId,
    modelId: args.modelId,
  })
  const payload: ReplaceClipResult = {
    placeholderId: result.placeholderId,
    trackId: result.trackId,
    from: result.from,
    durationInFrames: result.durationInFrames,
  }
  return payload
}
