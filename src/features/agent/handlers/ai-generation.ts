/**
 * Browser-side handlers for AI generation (M3 keystone tool — see
 * docs/PHASE-1-PLAN.md §5).
 *
 * Four handlers cover the lifecycle:
 *   - `insert-generation-placeholder` — drop a shape placeholder at a
 *     time range; returns the placeholder id (and resolved trackId).
 *   - `swap-generation-placeholder-with-url` — download a generated
 *     asset from a URL, import it into the workspace media library,
 *     atomically swap the placeholder for a real VideoItem, and write
 *     `generation.json` AI-output metadata.
 *   - `remove-generation-placeholder` — cancel path; removes the
 *     placeholder with no undo entry.
 *   - `mark-generation-placeholder-error` — failure path; flips the
 *     placeholder's visual state without removing it.
 *
 * The agent server orchestrates these via the bridge; everything that
 * touches the React store, OPFS, or workspace files runs here.
 */

import { createLogger } from '@/shared/logging/logger'
import type { TimelineTrack } from '@/types/timeline'
import {
  insertGenerationPlaceholder,
  swapPlaceholderWithMedia,
  removeGenerationPlaceholder,
  markGenerationPlaceholderError,
  buildMediaTimelineItem,
  useItemsStore,
  useTimelineSettingsStore,
} from '../deps/timeline-contract'
import { mediaLibraryService, useMediaLibraryStore } from '../deps/media-library-contract'
import { useProjectStore } from '../deps/projects-contract'
import { updateMedia, writeAiOutput } from '../deps/storage-contract'
import type { BrowserActionHandler } from './types'

const log = createLogger('agent-handler-ai-generation')

/* -------------------- insert placeholder -------------------- */

interface InsertPlaceholderArgs {
  /** Start of the placeholder, seconds. */
  startSeconds: number
  /** End of the placeholder, seconds (must be > startSeconds). */
  endSeconds: number
  /** Prompt that triggered the generation; shown on the placeholder. */
  prompt: string
  /** Optional explicit target track. Omit to auto-resolve. */
  trackId?: string
  providerId?: string
  modelId?: string
}

interface InsertPlaceholderResult {
  placeholderId: string
  trackId: string
  from: number
  durationInFrames: number
}

export const insertGenerationPlaceholderHandler: BrowserActionHandler = async (rawArgs) => {
  const args = rawArgs as InsertPlaceholderArgs
  if (typeof args.startSeconds !== 'number' || typeof args.endSeconds !== 'number') {
    throw new Error('insert-generation-placeholder requires startSeconds + endSeconds')
  }
  if (args.endSeconds <= args.startSeconds) {
    throw new Error('endSeconds must be greater than startSeconds')
  }
  if (!args.prompt || typeof args.prompt !== 'string') {
    throw new Error('insert-generation-placeholder requires a non-empty prompt')
  }

  const fps = useTimelineSettingsStore.getState().fps
  const from = Math.round(args.startSeconds * fps)
  const durationInFrames = Math.max(1, Math.round((args.endSeconds - args.startSeconds) * fps))

  const trackId = args.trackId ?? resolveTargetVideoTrack()

  const placeholderId = insertGenerationPlaceholder({
    trackId,
    from,
    durationInFrames,
    prompt: args.prompt,
    providerId: args.providerId,
    modelId: args.modelId,
  })

  const result: InsertPlaceholderResult = {
    placeholderId,
    trackId,
    from,
    durationInFrames,
  }
  return result
}

/* -------------------- swap placeholder with downloaded asset -------------------- */

interface SwapPlaceholderArgs {
  placeholderId: string
  /** Remote asset URL (fal flows). Provide this OR `sourceBytesBase64`. */
  sourceUrl?: string
  /**
   * Base64-encoded media bytes produced locally (e.g. a HyperFrames render).
   * When present, the bytes are wrapped in an object URL and imported through
   * the exact same path as `sourceUrl` — no remote fetch.
   */
  sourceBytesBase64?: string
  /** MIME type for `sourceBytesBase64`. Defaults to video/mp4. */
  mediaMimeType?: string
  providerId: string
  modelId: string
  prompt: string
  cost?: { amount: number; currency: 'USD' }
  /** Provider-side inputs that affect the result (aspect, seed, …). Persisted in envelope `params`. */
  providerInputs?: Record<string, unknown>
  /**
   * What kind of media the sourceUrl resolves to. Defaults to 'video' for
   * back-compat with the M3 `generate_broll` flow; image gen (M4.7
   * `generate_image`) passes 'image' so the import path constructs an
   * image timeline item and the persisted envelope's outputKind reflects
   * the actual asset type.
   */
  mediaKind?: 'video' | 'image'
}

interface SwapPlaceholderResult {
  clipId: string
  mediaId: string
  trackId: string
  from: number
  durationInFrames: number
}

export const swapGenerationPlaceholderHandler: BrowserActionHandler = async (rawArgs, signal) => {
  const args = rawArgs as SwapPlaceholderArgs
  if (!args.placeholderId) throw new Error('swap-generation-placeholder requires placeholderId')
  if (!args.sourceUrl && !args.sourceBytesBase64) {
    throw new Error('swap-generation-placeholder requires sourceUrl or sourceBytesBase64')
  }

  const items = useItemsStore.getState().items
  const placeholder = items.find((i) => i.id === args.placeholderId)
  if (!placeholder || placeholder.type !== 'shape' || !placeholder.aiPlaceholder) {
    throw new Error(`placeholder ${args.placeholderId} not found or not an ai placeholder`)
  }
  const placeholderFrom = placeholder.from
  const placeholderDuration = placeholder.durationInFrames
  const placeholderTrackId = placeholder.trackId

  const projectStore = useProjectStore.getState()
  const project = projectStore.currentProject
  if (!project) throw new Error('No project loaded')

  signal.throwIfAborted()

  // Two import sources. A remote URL (fal flows) goes through the URL store
  // action. Local render bytes (HyperFrames) become a File and import via the
  // generated-video path — the URL path rejects non-http(s) schemes by design,
  // so we must not route object URLs through it.
  const libraryStore = useMediaLibraryStore.getState()
  let media: Awaited<ReturnType<typeof mediaLibraryService.importGeneratedVideo>>
  if (args.sourceBytesBase64) {
    log.debug(`swap: importing local render bytes into project ${project.id}`)
    const mimeType = args.mediaMimeType ?? 'video/mp4'
    const file = new File(
      [base64ToBlob(args.sourceBytesBase64, mimeType)],
      `${args.providerId}-${crypto.randomUUID()}.${extensionForMimeType(mimeType)}`,
      { type: mimeType },
    )
    media = await mediaLibraryService.importGeneratedVideo(file, project.id)
    // Register in React state so the clip shows in the Media Library panel
    // (the URL store action does this internally; the bare service does not).
    libraryStore.prependMediaItem(media)
  } else {
    log.debug(`swap: importing ${args.sourceUrl} into project ${project.id}`)
    // Use the store action (not the bare service) so the imported clip lands
    // in the React media-library state — without this, the file is written to
    // OPFS but the user can't see it in the Media Library panel.
    const imported = await libraryStore.importMediaFromUrl(args.sourceUrl!)
    const first = imported[0]
    if (!first) {
      const reason = useMediaLibraryStore.getState().error ?? 'unknown error'
      throw new Error(`media library import failed: ${reason}`)
    }
    media = first
  }
  if ('hasUnsupportedCodec' in media && media.hasUnsupportedCodec) {
    throw new Error('Generated video has an unsupported codec; cannot import')
  }

  signal.throwIfAborted()

  const blobUrl = await mediaLibraryService.getMediaBlobUrl(media.id)
  if (!blobUrl) {
    throw new Error('Failed to resolve blob URL for imported media')
  }

  const fps = useTimelineSettingsStore.getState().fps
  const canvasWidth = project.metadata?.width ?? media.width ?? 1920
  const canvasHeight = project.metadata?.height ?? media.height ?? 1080

  const mediaKind = args.mediaKind ?? 'video'
  // Image-kind media has no intrinsic playback duration — `media.duration`
  // is typically 0 for stills. Use the placeholder window verbatim so the
  // image holds for exactly the requested time range. Video kind clamps
  // to the media's actual duration so we never silently extend past the
  // generated bytes.
  const durationInFrames =
    mediaKind === 'image'
      ? placeholderDuration
      : Math.min(placeholderDuration, Math.max(1, Math.round(media.duration * fps)))

  const replacement = buildMediaTimelineItem({
    media: { duration: media.duration, fps: media.fps, width: media.width, height: media.height },
    mediaId: media.id,
    mediaType: mediaKind,
    label: args.prompt.length > 60 ? `${args.prompt.slice(0, 59)}…` : args.prompt,
    projectFps: fps,
    blobUrl,
    canvasWidth,
    canvasHeight,
    placement: {
      trackId: placeholderTrackId,
      from: placeholderFrom,
      // Preserve the placeholder window — the generated clip's actual
      // duration may differ, but the user's intent was the window length.
      // buildMediaTimelineItem will clamp sourceEnd accordingly for video.
      durationInFrames,
    },
    originId: crypto.randomUUID(),
  })

  const ok = swapPlaceholderWithMedia(args.placeholderId, replacement)
  if (!ok) {
    throw new Error('placeholder was removed before swap could land')
  }

  // Mark the imported media as AI-generated so the library card shows a
  // badge. In-memory update first (so the UI flips immediately), disk
  // persistence second (best-effort — on next reload we re-derive from
  // the persisted metadata).
  const aiGenerated = {
    provider: args.providerId,
    model: args.modelId,
    prompt: args.prompt,
    generatedAt: Date.now(),
  }
  libraryStore.markMediaAiGenerated(media.id, aiGenerated)
  try {
    await updateMedia(media.id, { aiGenerated })
  } catch (err) {
    log.warn('failed to persist aiGenerated metadata', err)
    // Non-fatal: in-memory state still has the flag; reload will lose it.
  }

  // Persist generation metadata for cost dashboards + replace_clip_with_regeneration.
  try {
    await writeAiOutput({
      mediaId: media.id,
      kind: 'generation',
      service: args.providerId,
      model: args.modelId,
      params: args.providerInputs ?? {},
      data: {
        outputKind: mediaKind,
        prompt: args.prompt,
        sourceUrl: args.sourceUrl,
        cost: args.cost,
        durationSec: media.duration,
      },
    })
  } catch (err) {
    log.warn('failed to write generation.json', err)
    // Non-fatal: clip is on the timeline; metadata is best-effort.
  }

  const result: SwapPlaceholderResult = {
    clipId: replacement.id,
    mediaId: media.id,
    trackId: placeholderTrackId,
    from: placeholderFrom,
    durationInFrames: replacement.durationInFrames,
  }
  return result
}

/* -------------------- remove placeholder (cancel path) -------------------- */

interface RemovePlaceholderArgs {
  placeholderId: string
}

export const removeGenerationPlaceholderHandler: BrowserActionHandler = async (rawArgs) => {
  const args = rawArgs as RemovePlaceholderArgs
  if (!args.placeholderId) throw new Error('remove-generation-placeholder requires placeholderId')
  removeGenerationPlaceholder(args.placeholderId)
  return {}
}

/* -------------------- mark placeholder as error -------------------- */

interface MarkErrorArgs {
  placeholderId: string
  errorMessage: string
}

export const markGenerationPlaceholderErrorHandler: BrowserActionHandler = async (rawArgs) => {
  const args = rawArgs as MarkErrorArgs
  if (!args.placeholderId) {
    throw new Error('mark-generation-placeholder-error requires placeholderId')
  }
  markGenerationPlaceholderError(args.placeholderId, args.errorMessage ?? 'unknown error')
  return {}
}

/* -------------------- helpers -------------------- */

/**
 * Always create a fresh video track above existing tracks for the
 * placeholder. Per PHASE-1-PLAN.md §5, generated b-roll should land on
 * its own track so it doesn't overwrite or visually merge with the user's
 * existing edit — users expect generated content to be additive, not
 * dropped on top of their primary footage.
 *
 * Mutates the tracks store directly (no undo entry) — the track is part
 * of the generation flow, not a user action, and the placeholder swap
 * pushes one combined undo entry that snapshots pre-track state.
 */
function resolveTargetVideoTrack(): string {
  const itemsStore = useItemsStore.getState()
  const tracks = itemsStore.tracks
  const minOrder = tracks.reduce((m, t) => Math.min(m, t.order ?? 0), 0)
  const newTrack: TimelineTrack = {
    id: crypto.randomUUID(),
    name: 'AI Generated',
    kind: 'video',
    height: 80,
    locked: false,
    visible: true,
    muted: false,
    solo: false,
    items: [],
    order: minOrder - 1,
  }
  itemsStore.setTracks([...tracks, newTrack])
  return newTrack.id
}

/** Map a media MIME type to a file extension for the imported File's name. */
function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes('webm')) return 'webm'
  if (mimeType.includes('quicktime') || mimeType.includes('mov')) return 'mov'
  return 'mp4'
}

/** Decode base64 media bytes (from a local render) into a Blob for import. */
function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mimeType })
}
