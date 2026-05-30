import { createLogger } from '@/shared/logging/logger'

const log = createLogger('extract-transcribable-audio')

/**
 * Whisper resamples everything to 16 kHz mono internally, so extracting at that
 * rate loses nothing for transcription and shrinks the upload dramatically.
 * 32 kbps mono MP3 is transparent for speech and lands a 30-min clip at ~7 MB —
 * comfortably under OpenAI's 25 MB /v1/audio/transcriptions limit, which the raw
 * video container blows past on anything longer than a few minutes.
 */
const TARGET_SAMPLE_RATE = 16_000
const TARGET_CHANNELS = 1
const TARGET_BITRATE_BPS = 32_000

// The MP3 encoder registers a process-wide codec handler; do it once.
let mp3EncoderRegistered = false

export interface ExtractTranscribableAudioResult {
  /** 16 kHz mono MP3 bytes, ready to upload to a cloud Whisper endpoint. */
  bytes: ArrayBuffer
  mimeType: 'audio/mpeg'
  /** Suggested upload-filename extension (cloud APIs sniff format from it). */
  extension: 'mp3'
}

/**
 * Decode a media file's audio track and re-encode it to a small 16 kHz mono MP3
 * for cloud transcription (OpenAI Whisper). The video track is discarded, so the
 * upload is a few MB regardless of source resolution/length. Uses mediabunny's
 * Conversion pipeline (WebCodecs under the hood) — mirrors the proxy-generation
 * worker. Honors `signal` for cancellation.
 *
 * Throws when the file has no decodable audio track.
 */
export async function extractTranscribableAudioMp3(
  file: Blob,
  signal?: AbortSignal,
): Promise<ExtractTranscribableAudioResult> {
  const [
    { Input, Output, BufferTarget, Conversion, Mp3OutputFormat, BlobSource, ALL_FORMATS },
    { registerMp3Encoder },
  ] = await Promise.all([import('mediabunny'), import('@mediabunny/mp3-encoder')])

  if (!mp3EncoderRegistered) {
    registerMp3Encoder()
    mp3EncoderRegistered = true
  }

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  const target = new BufferTarget()
  const output = new Output({ format: new Mp3OutputFormat(), target })

  // mediabunny remixes + resamples to the target channels/rate automatically.
  const conversion = await Conversion.init({
    input,
    output,
    video: { discard: true },
    audio: {
      codec: 'mp3',
      sampleRate: TARGET_SAMPLE_RATE,
      numberOfChannels: TARGET_CHANNELS,
      bitrate: TARGET_BITRATE_BPS,
    },
  })

  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks.map((d) => d.reason).join('; ')
    input.dispose()
    throw new Error(
      `could not extract audio for transcription: ${reasons || 'the file has no decodable audio track'}`,
    )
  }

  const onAbort = () => {
    void conversion.cancel()
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    await conversion.execute()
  } finally {
    signal?.removeEventListener('abort', onAbort)
    input.dispose()
  }

  if (!target.buffer) {
    throw new Error('audio extraction produced no output buffer')
  }

  log.debug(`extracted ${(target.buffer.byteLength / 1024).toFixed(0)}KB mono mp3`)
  return { bytes: target.buffer, mimeType: 'audio/mpeg', extension: 'mp3' }
}
