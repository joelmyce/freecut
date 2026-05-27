/**
 * Browser-side handler for the M4.6 `analyze_clip` tool.
 *
 * Reads the source media bytes for a timeline item (or media id), base64-
 * encodes them, and returns a payload Gemini can consume. The server-side
 * provider chooses between inline `inlineData` (≤18MB raw) and the Gemini
 * File API upload + `fileData` reference path for larger clips — this
 * handler doesn't care which is used, it just delivers the bytes through
 * the bridge.
 *
 * `startSeconds` / `endSeconds` are passed through to the analysis tool
 * which weaves them into the Gemini prompt as a focus directive — the
 * model sees the whole clip but is told which window matters.
 */

import { createLogger } from '@/shared/logging/logger'
import { useItemsStore } from '../deps/timeline-contract'
import { mediaLibraryService } from '../deps/media-library-contract'
import type { BrowserActionHandler } from './types'

const log = createLogger('agent-handler-read-clip-video-bytes')

/**
 * Practical raw-byte ceiling for sending a clip through the WS bridge.
 * The agent-server's WebSocket maxPayload is 256MB and base64 inflates by
 * ~33%, so 180MB raw becomes ~240MB base64 with room for the protocol
 * envelope. Files larger than this should be downsampled/trimmed before
 * analysis — but we don't expect to hit it in normal workflows since
 * Kling clips are 5-20MB and user-recorded snippets typically <200MB.
 *
 * Files larger than ~18MB raw take the Gemini File API upload path on
 * the server side; smaller clips use the inline `inlineData` part for
 * speed.
 */
const MAX_BRIDGE_BYTES = 180 * 1024 * 1024

interface ReadClipVideoBytesArgs {
  /** Either an item id (item:XYZ) or a raw media id. */
  clipId: string
  /** Reserved — currently unused by the byte read. Forwarded by the caller for documentation. */
  startSeconds?: number
  endSeconds?: number
}

interface ClipVideoPayload {
  bytes: string
  filename: string
  mimeType: string
  durationSec: number
}

export const readClipVideoBytesHandler: BrowserActionHandler = async (rawArgs) => {
  const args = rawArgs as ReadClipVideoBytesArgs
  if (!args.clipId) throw new Error('read-clip-video-bytes requires clipId')

  // Agents sometimes pass the bracket-tag form ("item:XYZ" or "media:XYZ")
  // straight through despite the system-prompt examples — strip defensively
  // before resolving. Filesystem names reject ":" so this is also a hard
  // safety: an unstripped id will explode at the workspace-fs read.
  const canonicalId = stripIdPrefix(args.clipId)

  const mediaId = resolveMediaId(canonicalId)
  if (!mediaId) {
    throw new Error(
      `read-clip-video-bytes: ${args.clipId} is neither a known timeline item with media nor a known media id`,
    )
  }

  const media = await mediaLibraryService.getMedia(mediaId)
  if (!media) throw new Error(`unknown media: ${mediaId}`)

  const blob = await mediaLibraryService.getMediaFile(mediaId)
  if (!blob) throw new Error(`could not load media file: ${media.fileName}`)

  if (blob.size > MAX_BRIDGE_BYTES) {
    const mb = (blob.size / 1024 / 1024).toFixed(1)
    throw new Error(
      `Clip ${media.fileName} is ${mb}MB which exceeds the agent bridge's 180MB cap. ` +
        'Trim to a shorter range or generate a smaller version before analyzing.',
    )
  }

  const buffer = await blob.arrayBuffer()
  const bytes = arrayBufferToBase64(buffer)
  const durationSec =
    typeof media.duration === 'number' && Number.isFinite(media.duration) ? media.duration : 0

  log.debug(
    `read ${media.fileName} (${blob.size} bytes raw, ${bytes.length} base64) for analyze_clip`,
  )

  const payload: ClipVideoPayload = {
    bytes,
    filename: media.fileName,
    mimeType: blob.type || media.mimeType,
    durationSec,
  }
  return payload
}

/**
 * Strip the bracket-tag prefix the agent sometimes glues onto an id.
 * The system prompt teaches "[Clip: foo (item:XYZ)]" → call with XYZ, but
 * agents periodically pass "item:XYZ" or "media:XYZ" verbatim. Filesystem
 * names reject `:` so leaving it unstripped causes a cryptic
 * `getDirectoryHandle ... Name is not allowed` later — strip up front.
 */
function stripIdPrefix(id: string): string {
  const colonIndex = id.indexOf(':')
  if (colonIndex === -1) return id
  const prefix = id.slice(0, colonIndex)
  if (prefix === 'item' || prefix === 'media') return id.slice(colonIndex + 1)
  return id
}

function resolveMediaId(idOrItem: string): string | null {
  const item = useItemsStore.getState().items.find((i) => i.id === idOrItem)
  if (item) {
    if (item.type === 'video' || item.type === 'audio' || item.type === 'image') {
      return item.mediaId ?? null
    }
    return null
  }
  // Caller passed a media id directly — accept as-is. The downstream
  // mediaLibraryService.getMedia call will validate it.
  return idOrItem
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)))
  }
  return btoa(binary)
}
