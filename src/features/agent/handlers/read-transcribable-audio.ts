import { createLogger } from '@/shared/logging/logger'
import { extractTranscribableAudioMp3, mediaLibraryService } from '../deps/media-library-contract'
import type { BrowserActionHandler } from './types'

const log = createLogger('agent-handler-read-transcribable-audio')

// OpenAI's /v1/audio/transcriptions hard-caps uploads at 25 MB.
const OPENAI_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024

interface ReadTranscribableAudioArgs {
  mediaId: string
}

interface AudioPayload {
  bytes: string
  filename: string
  mimeType: string
}

/**
 * Returns transcription-ready audio (base64) for cloud Whisper providers.
 *
 * We do NOT ship the raw media container: a video file is mostly video bytes,
 * and OpenAI rejects anything over 25 MB, so shipping the whole file 413s on
 * clips longer than a few minutes. Instead we extract the audio track and
 * re-encode it to a 16 kHz mono MP3 (Whisper's native rate) — a 30-min clip
 * lands at ~7 MB, well under the cap, and the upload is faster. Honors the
 * action's abort signal so a cancelled transcription stops the extraction.
 */
export const readTranscribableAudioHandler: BrowserActionHandler = async (rawArgs, signal) => {
  const args = rawArgs as ReadTranscribableAudioArgs
  if (!args.mediaId) throw new Error('read-transcribable-audio requires mediaId')

  const media = await mediaLibraryService.getMedia(args.mediaId)
  if (!media) throw new Error(`unknown media: ${args.mediaId}`)

  const blob = await mediaLibraryService.getMediaFile(args.mediaId)
  if (!blob) throw new Error(`could not load media file: ${media.fileName}`)

  const audio = await extractTranscribableAudioMp3(blob, signal)

  if (audio.bytes.byteLength > OPENAI_UPLOAD_LIMIT_BYTES) {
    const mb = (audio.bytes.byteLength / 1024 / 1024).toFixed(1)
    throw new Error(
      `extracted audio is ${mb}MB, over the cloud transcription 25MB limit — this clip is extremely long. Use provider:"local" or split the clip first.`,
    )
  }

  log.debug(
    `shipping ${(audio.bytes.byteLength / 1024).toFixed(0)}KB mono mp3 for ${media.fileName}`,
  )

  const payload: AudioPayload = {
    bytes: arrayBufferToBase64(audio.bytes),
    filename: toMp3Filename(media.fileName),
    mimeType: audio.mimeType,
  }
  return payload
}

/** Swap any extension (or add one) so the cloud API sniffs the format as MP3. */
function toMp3Filename(name: string): string {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  return `${base}.mp3`
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
