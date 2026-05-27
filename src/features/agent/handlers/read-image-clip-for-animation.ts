/**
 * Browser-side handler for the M4.7 `animate_image` tool.
 *
 * Resolves a timeline image clip → its source-media-id → the original fal
 * URL stored in `media/{id}/cache/ai/generation.json`. The server tool
 * then passes that URL to a Kling image-to-video model as `start_image_url`.
 *
 * Read-only. Returns enough info for the server to:
 *   - Validate the clip is actually an image (not a video / shape / placeholder)
 *   - Validate the image is AI-generated and we have a fetchable URL
 *   - Reuse the clip's track/from/duration for the placeholder swap
 */

import { createLogger } from '@/shared/logging/logger'
import { useItemsStore } from '../deps/timeline-contract'
import { readAiOutput } from '../deps/storage-contract'
import type { BrowserActionHandler } from './types'

const log = createLogger('agent-handler-read-image-clip-for-animation')

interface Args {
  clipId: string
}

interface Result {
  mediaId: string
  trackId: string
  from: number
  durationInFrames: number
  itemType: 'image'
  /** Original fal-served URL of the still — feeds Kling's `start_image_url`. */
  imageSourceUrl: string
  /** Provider + model + prompt the still was rendered with, for metadata. */
  originalGeneration: {
    provider: string
    model: string
    prompt: string
    params: Record<string, unknown>
  }
}

export const readImageClipForAnimationHandler: BrowserActionHandler = async (rawArgs) => {
  const args = rawArgs as Args
  if (!args.clipId) throw new Error('read-image-clip-for-animation requires clipId')

  // Defensive prefix strip — agents sometimes pass "item:XYZ" verbatim.
  const canonicalClipId = stripIdPrefix(args.clipId)

  const item = useItemsStore.getState().items.find((i) => i.id === canonicalClipId)
  if (!item) throw new Error(`clip ${args.clipId} not found on timeline`)
  if (item.type !== 'image') {
    throw new Error(
      `clip ${args.clipId} is type '${item.type}', not 'image'. animate_image only works on AI-generated still images. Use replace_clip_with_regeneration for video clips.`,
    )
  }
  const mediaId = item.mediaId
  if (!mediaId) {
    throw new Error(`image clip ${args.clipId} has no mediaId`)
  }

  let envelope
  try {
    envelope = await readAiOutput(mediaId, 'generation')
  } catch (err) {
    log.warn(`failed to read generation envelope for ${mediaId}`, err)
    envelope = null
  }
  if (!envelope) {
    throw new Error(
      `image media ${mediaId} has no generation.json — animate_image requires an AI-generated still with a stored source URL.`,
    )
  }
  const imageSourceUrl = envelope.data.sourceUrl
  if (!imageSourceUrl || typeof imageSourceUrl !== 'string') {
    throw new Error(
      `image media ${mediaId} generation.json has no sourceUrl — cannot pass to image-to-video model.`,
    )
  }

  const result: Result = {
    mediaId,
    trackId: item.trackId,
    from: item.from,
    durationInFrames: item.durationInFrames,
    itemType: 'image',
    imageSourceUrl,
    originalGeneration: {
      provider: envelope.service,
      model: envelope.model,
      prompt: envelope.data.prompt,
      params: envelope.params,
    },
  }
  return result
}

function stripIdPrefix(id: string): string {
  const colonIndex = id.indexOf(':')
  if (colonIndex === -1) return id
  const prefix = id.slice(0, colonIndex)
  if (prefix === 'item' || prefix === 'media') return id.slice(colonIndex + 1)
  return id
}
