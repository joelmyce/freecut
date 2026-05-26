import { mediaLibraryService } from '../deps/media-library-contract'
import type { BrowserActionHandler } from './types'

interface ReadTranscribableAudioArgs {
  mediaId: string
}

interface AudioPayload {
  bytes: string
  filename: string
  mimeType: string
}

/**
 * Returns the conformed audio bytes (base64-encoded) for the OpenAI Whisper
 * provider. We send the raw media container as-is — OpenAI's Whisper API
 * auto-detects mp3/mp4/wav/webm/etc, so we skip the custom-codec conform
 * step. If a user hits a codec OpenAI can't read, they can fall back to
 * `provider: "local"`.
 */
export const readTranscribableAudioHandler: BrowserActionHandler = async (rawArgs) => {
  const args = rawArgs as ReadTranscribableAudioArgs
  if (!args.mediaId) throw new Error('read-transcribable-audio requires mediaId')

  const media = await mediaLibraryService.getMedia(args.mediaId)
  if (!media) throw new Error(`unknown media: ${args.mediaId}`)

  const blob = await mediaLibraryService.getMediaFile(args.mediaId)
  if (!blob) throw new Error(`could not load media file: ${media.fileName}`)

  const buffer = await blob.arrayBuffer()
  const bytes = arrayBufferToBase64(buffer)

  const payload: AudioPayload = {
    bytes,
    filename: media.fileName,
    mimeType: blob.type || media.mimeType,
  }
  return payload
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  // Chunked to avoid String.fromCharCode argument-count limits on large clips.
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)))
  }
  return btoa(binary)
}
