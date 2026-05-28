import React, { useMemo } from 'react'

import { useSequenceContext } from '@/runtime/composition-runtime/deps/player'
import { buildKaraokeSpans, DEFAULT_KARAOKE_HIGHLIGHT } from '@/shared/utils/karaoke-spans'
import { parseSubtitleCueText } from '@/shared/utils/subtitle-cue-format'
import type { SubtitleSegmentItem, TextItem } from '@/types/timeline'

import { useVideoConfig } from '../hooks/use-player-compat'
import { TextContent } from './text-content'

/**
 * Renders the active cue of a {@link SubtitleSegmentItem} per frame.
 *
 * A subtitle segment owns its full cue list — instead of stamping out N
 * TextItems, we resolve the cue active at the current sequence frame and
 * reuse {@link TextContent} so all of TextItem's styling (font loading,
 * text shadow, stroke, alignment) Just Works.
 *
 * In `style: 'karaoke'` mode (M5.1), the active cue's text splits into
 * per-word spans driven by Whisper word timestamps; the word covering
 * the current frame gets the `karaokeHighlightColor` override. Falls
 * back to standard cue rendering when the active cue has no `words[]`
 * (e.g. SRT imports without word timing).
 */
export const SubtitleSegmentContent: React.FC<{
  item: SubtitleSegmentItem & { _sequenceFrameOffset?: number }
}> = ({ item }) => {
  const sequenceContext = useSequenceContext()
  const { fps } = useVideoConfig()
  const relativeFrame = (sequenceContext?.localFrame ?? 0) - (item._sequenceFrameOffset ?? 0)
  const secondsIntoSegment = relativeFrame / fps

  const activeCue = useMemo(
    () => findActiveCue(item.cues, secondsIntoSegment),
    [item.cues, secondsIntoSegment],
  )

  // Parse inline markup (<i>, <b>, <u>, <font color>) into formatted spans
  // and pull off any ASS `{\anN}` positioning override so the cue can land
  // top-of-screen (used for sign translations / on-screen labels).
  const parsed = useMemo(
    () => (activeCue ? parseSubtitleCueText(activeCue.text) : null),
    [activeCue],
  )

  // Karaoke spans, when applicable. Built from the cue's word timestamps;
  // null when not in karaoke mode or when the cue has no words to anchor
  // a highlight to. When present, these REPLACE the inline-markup spans —
  // mixing the two is out of scope for v1 (karaoke transcripts don't
  // typically carry SRT-style markup anyway).
  const karaokeSpans = useMemo(
    () =>
      item.style === 'karaoke' && activeCue
        ? buildKaraokeSpans(
            activeCue,
            secondsIntoSegment,
            item.karaokeHighlightColor ?? DEFAULT_KARAOKE_HIGHLIGHT,
            // Pass the segment's font size so the active word's pop scales
            // proportionally — without baseFontSize the helper skips the
            // per-span fontSize override and the highlight is color-only.
            { baseFontSize: item.fontSize },
          )
        : null,
    [activeCue, item.fontSize, item.karaokeHighlightColor, item.style, secondsIntoSegment],
  )

  // Synthesize an ephemeral TextItem that carries the active cue's text and
  // the segment's typography. Keyframe/gizmo lookups by id will miss (the
  // segment isn't a TextItem) — that's fine for now; segment-level keyframes
  // are a planned follow-up.
  const syntheticTextItem = useMemo<TextItem & { _sequenceFrameOffset?: number }>(
    () => ({
      id: item.id,
      type: 'text',
      trackId: item.trackId,
      from: item.from,
      durationInFrames: item.durationInFrames,
      label: item.label,
      mediaId: item.mediaId,
      transform: item.transform,
      text: karaokeSpans ? karaokeSpans.plainText : (parsed?.plainText ?? ''),
      // textSpans drives styled per-run rendering — italic / bold / colored
      // fragments inside one cue. TextContent prefers spans over `text`
      // when both are present.
      textSpans: karaokeSpans ? karaokeSpans.spans : parsed?.spans,
      // Subtitles render their spans INLINE (a sentence flowing on one
      // line) — without this the renderer falls back to the legacy
      // stacked-spans layout meant for title cards and every span lands
      // on its own line.
      inlineSpans: true,
      fontSize: item.fontSize,
      fontFamily: item.fontFamily,
      fontWeight: item.fontWeight,
      fontStyle: item.fontStyle,
      underline: item.underline,
      color: item.color,
      backgroundColor: item.backgroundColor,
      backgroundRadius: item.backgroundRadius,
      textAlign: parsed?.alignment?.textAlign ?? item.textAlign,
      verticalAlign: parsed?.alignment?.verticalAlign ?? item.verticalAlign,
      lineHeight: item.lineHeight,
      letterSpacing: item.letterSpacing,
      textPadding: item.textPadding,
      textShadow: item.textShadow,
      stroke: item.stroke,
      _sequenceFrameOffset: item._sequenceFrameOffset,
    }),
    [item, karaokeSpans, parsed],
  )

  if (!activeCue) return null
  // Karaoke mode skips the parsed.isEmpty guard because spans drive the
  // render — an empty parsed result is fine as long as we have words.
  if (!karaokeSpans && (!parsed || parsed.isEmpty)) return null
  return <TextContent item={syntheticTextItem} />
}

/**
 * Binary search for the cue whose `[startSeconds, endSeconds)` window
 * contains `seconds`. Cues are pre-sorted by startSeconds at insertion
 * time, so we can cut the per-frame cost from O(n) to O(log n) — meaningful
 * on a 65-min episode with 600+ cues.
 */
function findActiveCue<T extends { startSeconds: number; endSeconds: number }>(
  cues: readonly T[],
  seconds: number,
): T | null {
  if (cues.length === 0) return null
  let lo = 0
  let hi = cues.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const cue = cues[mid]!
    if (seconds < cue.startSeconds) {
      hi = mid - 1
    } else if (seconds >= cue.endSeconds) {
      lo = mid + 1
    } else {
      return cue
    }
  }
  return null
}
