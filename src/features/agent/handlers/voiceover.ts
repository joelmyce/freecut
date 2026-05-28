/**
 * Browser-side handlers for `generate_voiceover` (M5 — see
 * docs/PHASE-1-PLAN.md §6.4).
 *
 * Two handlers cover the flow:
 *   - `synthesize-voiceover-local` — runs the browser's existing
 *     `kokoroTtsService` (WebGPU + Kokoro v1.0 ONNX), returns the WAV
 *     bytes as base64. Server's `KokoroBrowserProxyTtsProvider` delegates
 *     here.
 *   - `insert-voiceover` — takes the synthesized bytes (from either
 *     provider path: Kokoro via the proxy, or ElevenLabs directly from
 *     the server), imports them into the workspace media library, marks
 *     the media `aiGenerated`, writes a `generation.json` envelope, and
 *     drops a single `AudioItem` on a compatible audio track.
 *
 * Unlike M3's video / M4.7's image flow, voiceover doesn't use the
 * placeholder→swap pattern — duration isn't known until after synthesis,
 * and synthesis is fast enough (~1-5s) that a placeholder window would
 * be wrong (estimated) or pointless (post-hoc). The insert lands as a
 * single `ADD_ITEM` undo entry via the timeline facade's `addItem` — one
 * Ctrl+Z removes the clip.
 */

import { createLogger } from '@/shared/logging/logger'
import { usePlaybackStore } from '@/shared/state/playback'
import type { AudioItem, TimelineTrack } from '@/types/timeline'
import {
  addItem,
  buildMediaTimelineItem,
  findCompatibleTrackForItemType,
  useItemsStore,
  useTimelineSettingsStore,
} from '../deps/timeline-contract'
import { mediaLibraryService, useMediaLibraryStore } from '../deps/media-library-contract'
import { useProjectStore } from '../deps/projects-contract'
import { updateMedia, writeAiOutput } from '../deps/storage-contract'
import {
  KOKORO_TTS_BEST_MODEL,
  KOKORO_TTS_VOICE_OPTIONS,
  kokoroTtsService,
  type KokoroTtsModel,
  type KokoroTtsVoice,
} from '../deps/editor-contract'
import type { BrowserActionHandler } from './types'

const log = createLogger('agent-handler-voiceover')

/* -------------------- synthesize via local kokoro -------------------- */

interface SynthesizeLocalArgs {
  text: string
  voiceId: string
  speed?: number
  model?: string
}

interface SynthesizeLocalResult {
  audioBytesBase64: string
  mimeType: string
  durationSec: number
  modelUsed: string
}

export const synthesizeVoiceoverLocalHandler: BrowserActionHandler = async (rawArgs) => {
  const args = rawArgs as SynthesizeLocalArgs
  const text = args.text?.trim()
  if (!text) throw new Error('synthesize-voiceover-local requires non-empty text')

  if (!kokoroTtsService.isSupported()) {
    throw new Error(
      'Kokoro TTS is unavailable in this browser — WebGPU is required. Try a recent Chrome or Edge build.',
    )
  }

  const voice = resolveKokoroVoice(args.voiceId)
  const model = resolveKokoroModel(args.model)
  const speed = clampSpeed(args.speed ?? 1.0)

  log.debug(`synthesizing locally with kokoro ${model} / voice=${voice} / speed=${speed}`)
  const { blob, duration } = await kokoroTtsService.generateSpeechFile({
    text,
    voice,
    speed,
    model,
  })
  const audioBytesBase64 = await blobToBase64(blob)

  const result: SynthesizeLocalResult = {
    audioBytesBase64,
    mimeType: blob.type || 'audio/wav',
    durationSec: duration,
    modelUsed: model,
  }
  return result
}

/* -------------------- insert voiceover at the requested position -------------------- */

interface InsertVoiceoverArgs {
  audioBytesBase64: string
  mimeType: string
  /** Duration in seconds — Kokoro reports it; ElevenLabs leaves 0 and the media import recomputes. */
  durationSec: number
  text: string
  voiceId: string
  providerId: string
  modelUsed: string
  /** Position on the project timeline in seconds. Omit to use the current playhead. */
  insertAtSeconds?: number
  trackId?: string
}

interface InsertVoiceoverResult {
  clipId: string
  mediaId: string
  trackId: string
  from: number
  durationInFrames: number
  durationSec: number
}

export const insertVoiceoverHandler: BrowserActionHandler = async (rawArgs) => {
  const args = rawArgs as InsertVoiceoverArgs
  if (!args.audioBytesBase64) {
    throw new Error('insert-voiceover requires audioBytesBase64')
  }

  const project = useProjectStore.getState().currentProject
  if (!project) throw new Error('No project loaded')

  // 1) Decode base64 → File. Filename is informational only — media library
  //    re-derives storage paths internally.
  const file = decodeBase64ToFile(args.audioBytesBase64, args.mimeType, args.text, args.providerId)
  log.debug(`importing voiceover file ${file.name} (${file.size} bytes)`)

  // 2) Import into the workspace media library so it appears in the panel
  //    with the same metadata pipeline as a user-imported audio clip.
  const media = await mediaLibraryService.importGeneratedAudio(file, project.id, {
    tags: ['ai-generated', 'voiceover', `tts-provider:${args.providerId}`],
  })
  await useMediaLibraryStore.getState().loadMediaItems()

  // 3) Resolve target track. If the caller passed an explicit id, use it;
  //    otherwise prefer an existing compatible audio track, else create a
  //    fresh "Voiceover" track below all existing tracks.
  const trackId = args.trackId ?? resolveTargetAudioTrack()

  // 4) Build the AudioItem. Position defaults to the current playhead when
  //    no explicit insertAtSeconds was supplied.
  const projectFps = useTimelineSettingsStore.getState().fps
  const playheadFrame = usePlaybackStore.getState().currentFrame
  const from =
    typeof args.insertAtSeconds === 'number'
      ? Math.max(0, Math.round(args.insertAtSeconds * projectFps))
      : playheadFrame

  // Use the imported media's actual duration (mediaProcessorService decoded
  // the bytes after import — this is the authoritative value for both
  // Kokoro and ElevenLabs paths).
  const durationSec = media.duration > 0 ? media.duration : Math.max(0.1, args.durationSec)
  const durationInFrames = Math.max(1, Math.round(durationSec * projectFps))

  const blobUrl = await mediaLibraryService.getMediaBlobUrl(media.id)
  if (!blobUrl) {
    throw new Error('Failed to resolve blob URL for imported voiceover media')
  }

  const project_ = project // capture for canvas width/height (audio doesn't need them but builder asks)
  const audioItem = buildMediaTimelineItem({
    media: { duration: durationSec, fps: media.fps, width: 0, height: 0 },
    mediaId: media.id,
    mediaType: 'audio',
    label: `Voiceover: ${truncate(args.text)}`,
    projectFps,
    blobUrl,
    canvasWidth: project_.metadata?.width ?? 1920,
    canvasHeight: project_.metadata?.height ?? 1080,
    placement: { trackId, from, durationInFrames },
    originId: crypto.randomUUID(),
  }) as AudioItem

  // 5) Insert via the timeline facade — wraps in execute(), creates one
  //    ADD_ITEM undo entry. Ctrl+Z removes the inserted clip.
  addItem(audioItem)

  // Confirm the addItem call actually placed the item (the facade can
  // skip when placement returns nothing). Re-read from the items store
  // because addItem may have shifted the item to avoid overlap.
  const placedItem = useItemsStore.getState().items.find((item) => item.id === audioItem.id) as
    | AudioItem
    | undefined
  if (!placedItem) {
    throw new Error('Voiceover insert was rejected by timeline placement (no compatible space)')
  }

  // 6) Persist AI-generation metadata. Same in-memory-first + disk-best-effort
  //    pattern as the M3 swap-handler.
  const aiGenerated = {
    provider: args.providerId,
    model: args.modelUsed,
    prompt: args.text,
    generatedAt: Date.now(),
  }
  useMediaLibraryStore.getState().markMediaAiGenerated(media.id, aiGenerated)
  try {
    await updateMedia(media.id, { aiGenerated })
  } catch (err) {
    log.warn('failed to persist aiGenerated metadata', err)
  }

  try {
    await writeAiOutput({
      mediaId: media.id,
      kind: 'generation',
      service: args.providerId,
      model: args.modelUsed,
      params: { voiceId: args.voiceId },
      data: {
        outputKind: 'audio',
        prompt: args.text,
        durationSec,
      },
    })
  } catch (err) {
    log.warn('failed to write voiceover generation.json', err)
  }

  const result: InsertVoiceoverResult = {
    clipId: placedItem.id,
    mediaId: media.id,
    trackId: placedItem.trackId,
    from: placedItem.from,
    durationInFrames: placedItem.durationInFrames,
    durationSec,
  }
  return result
}

/* -------------------- helpers -------------------- */

function resolveKokoroVoice(voiceId: string | undefined): KokoroTtsVoice {
  const fallback: KokoroTtsVoice = 'af_heart'
  if (!voiceId) return fallback
  const match = KOKORO_TTS_VOICE_OPTIONS.find((option) => option.value === voiceId)
  if (!match) {
    log.warn(`kokoro voice "${voiceId}" not in voice list — falling back to af_heart`)
    return fallback
  }
  return match.value
}

function resolveKokoroModel(modelId: string | undefined): KokoroTtsModel {
  return modelId === 'fp32' ? 'fp32' : KOKORO_TTS_BEST_MODEL
}

function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) return 1.0
  return Math.min(2.0, Math.max(0.5, value))
}

function decodeBase64ToFile(
  base64: string,
  mimeType: string,
  text: string,
  providerId: string,
): File {
  // atob is the standard browser path; the kokoro proxy already
  // round-trips through Buffer.from(...).toString('base64') in node.
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const extension = extensionForMimeType(mimeType)
  const slug = sanitizeSlug(text) || 'voiceover'
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const fileName = `ai-voiceover-${providerId}-${slug}-${timestamp}.${extension}`
  return new File([bytes], fileName, { type: mimeType || 'audio/wav', lastModified: Date.now() })
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType.startsWith('audio/wav')) return 'wav'
  if (mimeType.startsWith('audio/mpeg') || mimeType.startsWith('audio/mp3')) return 'mp3'
  if (mimeType.startsWith('audio/ogg') || mimeType.startsWith('audio/opus')) return 'ogg'
  return 'wav'
}

function sanitizeSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

function truncate(text: string, max = 60): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

/**
 * Find an existing audio track or create a fresh "Voiceover" one below
 * all existing tracks. Mirrors `resolveTargetVideoTrack` in
 * ai-generation.ts in shape — direct `setTracks` mutation, no undo entry,
 * because the track is part of the generation flow, not a user action.
 *
 * Layout choice: audio tracks go BELOW video tracks (highest order = bottom
 * of the timeline UI). New voiceover track lands at `maxOrder + 1` so it
 * doesn't displace any existing track.
 */
function resolveTargetAudioTrack(): string {
  const itemsStore = useItemsStore.getState()
  const tracks = itemsStore.tracks
  const compatible = findCompatibleTrackForItemType({
    tracks,
    items: itemsStore.items,
    itemType: 'audio',
    preferredTrackId: null,
  })
  if (compatible) return compatible.id

  const maxOrder = tracks.reduce((m, t) => Math.max(m, t.order ?? 0), 0)
  const newTrack: TimelineTrack = {
    id: crypto.randomUUID(),
    name: 'Voiceover',
    kind: 'audio',
    height: 60,
    locked: false,
    visible: true,
    muted: false,
    solo: false,
    items: [],
    order: maxOrder + 1,
  }
  itemsStore.setTracks([...tracks, newTrack])
  return newTrack.id
}

async function blobToBase64(blob: Blob): Promise<string> {
  // FileReader.readAsDataURL gives us `data:audio/wav;base64,<payload>`
  // — strip the prefix and return the payload. Roughly 1.5MB/second
  // worst case for Kokoro WAV at 24kHz, well under the WS frame limit.
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
  const comma = dataUrl.indexOf(',')
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
}
