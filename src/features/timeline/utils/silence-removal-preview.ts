import { getOrDecodeAudio } from '@/features/timeline/deps/composition-runtime'
import { resolveMediaUrl } from '@/features/timeline/deps/media-library-resolver'
import { useItemsStore } from '@/features/timeline/stores/items-store'
import { getTranscript } from '@/infrastructure/storage'
import { createLogger } from '@/shared/logging/logger'
import {
  applyRemovalPreviewOverlays,
  clearRemovalPreviewOverlays,
  isAudioVideoItem,
} from '@/features/timeline/utils/removal-preview-overlays'
import {
  detectSilentRanges,
  type AudioSilenceDetectionOptions,
  type AudioSilenceRange,
} from '@/shared/utils/audio-silence'
import type { MediaTranscript } from '@/types/storage'

const logger = createLogger('SilenceRemovalPreview')

export const SILENCE_REMOVAL_PREVIEW_OVERLAY_ID = 'silence-removal-preview'

export interface SilenceRemovalSettings {
  thresholdDb: number
  minSilenceMs: number
  paddingMs: number
  windowMs: number
}

export const DEFAULT_SILENCE_REMOVAL_SETTINGS: SilenceRemovalSettings = {
  thresholdDb: -45,
  minSilenceMs: 500,
  paddingMs: 100,
  windowMs: 20,
}

export type SilenceRangesByMediaId = Record<string, AudioSilenceRange[]>

export interface SilencePreviewSummary {
  rangeCount: number
  totalSeconds: number
}

/**
 * Safety buffer (seconds) added around every Whisper word span before
 * subtracting it from raw silence ranges. Whisper word timestamps are
 * approximate — quantized to ~20-30ms in practice — and the speech
 * energy of a fricative trails off slightly past `word.end`. A 50ms
 * pad on each side prevents cuts from clipping the consonant tail.
 */
export const SILENCE_WORD_PADDING_SEC = 0.05

/**
 * Refine raw RMS-detected silence ranges using Whisper word timestamps.
 *
 * The RMS detector calls silence whenever audio dips below the threshold
 * for `min_silence_sec`. That fires inside words too — vowel-to-consonant
 * transitions and unvoiced segments produce sub-threshold gaps deep
 * inside a single word (e.g. between "sigu" and "iente" in "siguiente").
 * Pure tolerance-snap (±150ms to the nearest word edge) doesn't help
 * when the RMS edge is 200-400ms inside the word.
 *
 * The fix: treat every Whisper word as an authoritative "speech here"
 * marker and SUBTRACT word spans (padded by {@link SILENCE_WORD_PADDING_SEC})
 * from each silence range. The result is the actual non-speech sub-spans;
 * sub-spans shorter than `minSilenceSec` are dropped so we don't
 * introduce micro-cuts that wouldn't have survived the original
 * detection.
 *
 * Pure function — no I/O.
 */
export function refineSilenceRangesUsingWords(
  rawRanges: ReadonlyArray<AudioSilenceRange>,
  words: ReadonlyArray<{ start: number; end: number }>,
  minSilenceSec: number,
  wordPaddingSec: number = SILENCE_WORD_PADDING_SEC,
): AudioSilenceRange[] {
  if (rawRanges.length === 0 || words.length === 0) return [...rawRanges]

  // Pre-sort + pad words once so we can intersect each silence range
  // against the timeline in O(words) per range (small N — a few hundred).
  const paddedWords = words
    .map((w) => ({ start: w.start - wordPaddingSec, end: w.end + wordPaddingSec }))
    .sort((a, b) => a.start - b.start)

  const out: AudioSilenceRange[] = []
  for (const range of rawRanges) {
    let cursor = range.start
    for (const w of paddedWords) {
      // Word entirely before this range — skip.
      if (w.end <= cursor) continue
      // Word entirely after this range — done with this range.
      if (w.start >= range.end) break
      // Word overlaps the current sub-cursor. Emit the gap before the word
      // (if any) and advance the cursor past the word.
      if (w.start > cursor) {
        const subEnd = Math.min(w.start, range.end)
        if (subEnd - cursor >= minSilenceSec) {
          out.push({ start: cursor, end: subEnd })
        }
      }
      if (w.end > cursor) cursor = w.end
      if (cursor >= range.end) break
    }
    if (cursor < range.end && range.end - cursor >= minSilenceSec) {
      out.push({ start: cursor, end: range.end })
    }
  }
  return out
}

function flattenWords(transcript: MediaTranscript): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  for (const segment of transcript.segments) {
    if (!segment.words) continue
    for (const w of segment.words) {
      out.push({ start: w.start, end: w.end })
    }
  }
  return out
}

export async function analyzeSilenceForItems(
  itemIds: readonly string[],
  settings: SilenceRemovalSettings,
): Promise<SilenceRangesByMediaId> {
  const itemsById = useItemsStore.getState().itemById
  const mediaIds = Array.from(
    new Set(
      itemIds
        .map((id) => itemsById[id])
        .filter(isAudioVideoItem)
        .map((item) => item.mediaId),
    ),
  )
  const silenceRangesByMediaId: SilenceRangesByMediaId = {}

  const results = await Promise.allSettled(
    mediaIds.map(async (mediaId) => {
      const url = await resolveMediaUrl(mediaId)
      if (!url) {
        throw new Error('Could not load media for silence detection')
      }

      const audioBuffer = await getOrDecodeAudio(mediaId, url)
      const rawRanges = detectSilentRanges(
        audioBuffer,
        settings satisfies AudioSilenceDetectionOptions,
      )

      let ranges = rawRanges
      let snapDiagnostic:
        | {
            status: 'refined'
            wordCount: number
            rawRangeCount: number
            refinedRangeCount: number
            droppedRangeCount: number
          }
        | { status: 'no-transcript' }
        | { status: 'no-words' }
        | { status: 'no-ranges' }
        | { status: 'error'; reason: string } = { status: 'no-ranges' }
      if (rawRanges.length > 0) {
        try {
          const transcript = await getTranscript(mediaId)
          if (!transcript) {
            snapDiagnostic = { status: 'no-transcript' }
          } else {
            const words = flattenWords(transcript)
            if (words.length === 0) {
              snapDiagnostic = { status: 'no-words' }
            } else {
              ranges = refineSilenceRangesUsingWords(rawRanges, words, settings.minSilenceMs / 1000)
              snapDiagnostic = {
                status: 'refined',
                wordCount: words.length,
                rawRangeCount: rawRanges.length,
                refinedRangeCount: ranges.length,
                droppedRangeCount: rawRanges.length - ranges.length,
              }
            }
          }
        } catch (error) {
          snapDiagnostic = {
            status: 'error',
            reason: error instanceof Error ? error.message : String(error),
          }
        }
      }

      return { mediaId, ranges, snapDiagnostic }
    }),
  )

  let succeeded = 0
  for (const result of results) {
    if (result.status === 'fulfilled') {
      succeeded += 1
      if (result.value.ranges.length > 0) {
        silenceRangesByMediaId[result.value.mediaId] = result.value.ranges
      }
      // Always log the M4.2-bis refinement decision so we can tell,
      // after the fact, whether word-span subtraction fired or fell back
      // — and why. Uses .warn intentionally because Vite's HMR client
      // only pipes console.warn/console.error to the dev terminal —
      // info would be invisible during live debugging.
      logger.warn('Silence range word-span refinement', {
        mediaId: result.value.mediaId,
        diagnostic: result.value.snapDiagnostic,
      })
    } else {
      logger.warn('Silence detection failed for media', { reason: result.reason })
    }
  }

  if (succeeded === 0 && mediaIds.length > 0) {
    throw new Error('Could not load media for silence detection')
  }

  return silenceRangesByMediaId
}

export function clearSilencePreviewOverlays(itemIds: readonly string[]): void {
  clearRemovalPreviewOverlays(itemIds, SILENCE_REMOVAL_PREVIEW_OVERLAY_ID)
}

export function applySilencePreviewOverlays(
  itemIds: readonly string[],
  rangesByMediaId: SilenceRangesByMediaId,
): SilencePreviewSummary {
  return applyRemovalPreviewOverlays({
    itemIds,
    rangesByMediaId,
    overlayId: SILENCE_REMOVAL_PREVIEW_OVERLAY_ID,
    labelNoun: 'silent',
    tone: 'error',
  })
}
