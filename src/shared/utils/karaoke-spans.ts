import type { SubtitleSegmentCue, TextSpan } from '@/types/timeline'

/** Default gold/yellow used by karaoke videos. Override via item.karaokeHighlightColor. */
export const DEFAULT_KARAOKE_HIGHLIGHT = '#FFD700'

/**
 * Default peak scale factor applied to the active word. 1.18 = +18% — enough
 * for a perceptible "pop" without making one word dwarf its neighbors. Pass
 * `popScaleMax: 1` to disable the pop entirely.
 */
export const DEFAULT_KARAOKE_POP_SCALE = 1.18

/**
 * Time on each side of the word's active window over which the pop ramps in
 * and out. 60ms is "noticeable but not laggy" — fast enough that the highlight
 * still tracks the spoken word, slow enough that scrubbing looks animated
 * rather than steppy.
 */
const POP_RAMP_SEC = 0.06

export interface KaraokeSpanResult {
  spans: TextSpan[]
  plainText: string
}

export interface KaraokeSpanOptions {
  /**
   * Segment's base fontSize in px. When supplied, the active word's span gets
   * a ramped fontSize that peaks at `baseFontSize * popScaleMax` — this is
   * what produces the smooth "pop" effect during playback / scrub. Omit to
   * keep the span fontSize undefined (renderer inherits item-level font size).
   */
  baseFontSize?: number
  /** Peak scale factor for the active word. Defaults to {@link DEFAULT_KARAOKE_POP_SCALE}. */
  popScaleMax?: number
}

/**
 * Build per-word spans for karaoke caption rendering (M5.1). Each word
 * becomes one span; the word whose `[start, end)` window covers
 * `secondsIntoSegment` gets `color: highlightColor` and a ramped fontSize
 * for the smooth pop effect. Whitespace lives on the trailing edge of each
 * non-final span so the concatenated text reads naturally.
 *
 * Word lookup is linear — typical cues carry 5-15 words and binary
 * search saves nothing at that scale.
 *
 * Edge behavior:
 *   - Before the first word's start: no word is highlighted yet.
 *   - During a gap between words: the most recently completed word
 *     stays highlighted (matches how karaoke videos hold across
 *     between-word pauses).
 *   - After the last word's end: the final word stays highlighted
 *     until the cue ends.
 *
 * Returns null when the cue has no `words[]` — caller falls back to
 * standard cue rendering.
 */
export function buildKaraokeSpans(
  cue: SubtitleSegmentCue,
  secondsIntoSegment: number,
  highlightColor: string,
  options?: KaraokeSpanOptions,
): KaraokeSpanResult | null {
  const words = cue.words
  if (!words || words.length === 0) return null

  let activeIndex = -1
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!
    if (secondsIntoSegment >= word.start && secondsIntoSegment < word.end) {
      activeIndex = i
      break
    }
    if (secondsIntoSegment >= word.end) {
      activeIndex = i
    }
  }

  const popScaleMax = options?.popScaleMax ?? DEFAULT_KARAOKE_POP_SCALE
  const baseFontSize = options?.baseFontSize

  const spans: TextSpan[] = []
  const plainParts: string[] = []
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!
    const trailing = i < words.length - 1 ? ' ' : ''
    const text = `${word.text}${trailing}`
    plainParts.push(text)

    if (i !== activeIndex) {
      spans.push({ text })
      continue
    }

    const span: TextSpan = { text, color: highlightColor }
    if (baseFontSize !== undefined && popScaleMax !== 1) {
      const scale = computeActivePopScale(word, secondsIntoSegment, popScaleMax)
      // Only set fontSize when it actually differs — keeps the renderer's
      // per-span path quiet during the "hold" phase between words.
      if (scale !== 1) {
        span.fontSize = Math.round(baseFontSize * scale)
      }
    }
    spans.push(span)
  }
  return { spans, plainText: plainParts.join('') }
}

/**
 * Ramped pop curve for the active word:
 *
 *   scale = 1.0                                  (outside the window + ramps)
 *   scale = 1.0 → popScaleMax  over POP_RAMP_SEC at the start
 *   scale = popScaleMax                          (held during the sustain)
 *   scale = popScaleMax → 1.0  over POP_RAMP_SEC at the end
 *
 * Ramps are linear — easy to reason about, no easing artifacts. For very
 * short words where 2 * POP_RAMP_SEC > word window, the sustain collapses
 * and the curve becomes a symmetric triangle peaking mid-word.
 */
function computeActivePopScale(
  word: { start: number; end: number },
  t: number,
  popScaleMax: number,
): number {
  const window = word.end - word.start
  if (window <= 0) return popScaleMax
  const ramp = Math.min(POP_RAMP_SEC, window / 2)

  if (t < word.start) return 1
  if (t >= word.end) return 1
  const sinceStart = t - word.start
  const untilEnd = word.end - t

  if (sinceStart < ramp) {
    return 1 + (popScaleMax - 1) * (sinceStart / ramp)
  }
  if (untilEnd < ramp) {
    return 1 + (popScaleMax - 1) * (untilEnd / ramp)
  }
  return popScaleMax
}
