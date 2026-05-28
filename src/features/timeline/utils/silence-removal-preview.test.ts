import { describe, expect, it } from 'vitest'
import { SILENCE_WORD_PADDING_SEC, refineSilenceRangesUsingWords } from './silence-removal-preview'

describe('refineSilenceRangesUsingWords', () => {
  const minSilence = 0.5

  it('returns ranges unchanged when there are no words', () => {
    const ranges = [{ start: 1, end: 2 }]
    expect(refineSilenceRangesUsingWords(ranges, [], minSilence)).toEqual(ranges)
  })

  it('returns empty when there are no ranges', () => {
    expect(refineSilenceRangesUsingWords([], [{ start: 0, end: 1 }], minSilence)).toEqual([])
  })

  it('drops a silence range that sits entirely inside a single word', () => {
    // "siguiente" spans 1.0s-2.0s. RMS mis-detects a 600ms "silence" inside
    // the word (vowel-to-consonant transition has low energy). We must drop
    // it — cutting here would chop "sigu" from "iente".
    const words = [{ start: 1.0, end: 2.0 }]
    const ranges = [{ start: 1.2, end: 1.8 }]
    expect(refineSilenceRangesUsingWords(ranges, words, minSilence)).toEqual([])
  })

  it('trims a silence range whose start overlaps a word (keeps post-word tail)', () => {
    // Word ends at 1.0s; RMS edge starts at 0.8s, eating 200ms of the word.
    // Refined start should land at word.end + padding so the consonant tail
    // is preserved.
    const words = [{ start: 0.0, end: 1.0 }]
    const ranges = [{ start: 0.8, end: 2.0 }]
    const result = refineSilenceRangesUsingWords(ranges, words, minSilence, 0)
    expect(result).toEqual([{ start: 1.0, end: 2.0 }])
  })

  it('trims a silence range whose end overlaps a word (keeps pre-word head)', () => {
    // Next word starts at 2.0s; RMS edge ends at 2.2s, eating 200ms of
    // the upcoming word. Refined end should land at word.start - padding.
    const words = [{ start: 2.0, end: 3.0 }]
    const ranges = [{ start: 0.5, end: 2.2 }]
    const result = refineSilenceRangesUsingWords(ranges, words, minSilence, 0)
    expect(result).toEqual([{ start: 0.5, end: 2.0 }])
  })

  it('splits a silence range when a word sits inside it', () => {
    // Silence range covers a region that contains a complete word.
    // The range must split into the pre-word gap + the post-word gap.
    const words = [{ start: 1.5, end: 2.0 }]
    const ranges = [{ start: 1.0, end: 3.0 }]
    const result = refineSilenceRangesUsingWords(ranges, words, minSilence, 0)
    expect(result).toEqual([
      { start: 1.0, end: 1.5 },
      { start: 2.0, end: 3.0 },
    ])
  })

  it('drops the pre-word sub-span when it is shorter than minSilenceSec', () => {
    // Word at 1.4s leaves only 0.4s before it; below the 0.5s threshold so
    // dropped. Post-word sub-span (1.0s) survives.
    const words = [{ start: 1.4, end: 2.0 }]
    const ranges = [{ start: 1.0, end: 3.0 }]
    const result = refineSilenceRangesUsingWords(ranges, words, minSilence, 0)
    expect(result).toEqual([{ start: 2.0, end: 3.0 }])
  })

  it('preserves a silence range that has no overlapping words', () => {
    // True silence between two utterances.
    const words = [
      { start: 0.0, end: 1.0 },
      { start: 3.0, end: 4.0 },
    ]
    const ranges = [{ start: 1.2, end: 2.8 }]
    const result = refineSilenceRangesUsingWords(ranges, words, minSilence)
    expect(result).toEqual([{ start: 1.2, end: 2.8 }])
  })

  it('applies word-padding so cuts do not graze the consonant tail', () => {
    const words = [{ start: 0.0, end: 1.0 }]
    const ranges = [{ start: 0.5, end: 2.0 }]
    // 50ms default pad → silence cannot start before 1.05s.
    const result = refineSilenceRangesUsingWords(ranges, words, minSilence)
    expect(result[0]?.start).toBeCloseTo(1.05, 5)
    expect(result[0]?.end).toBe(2.0)
  })

  it('handles multiple words intersecting a single silence range', () => {
    // Three words sprinkled inside a long fake-silence span. Result is the
    // sub-gaps between them, each ≥ minSilence.
    const words = [
      { start: 1.0, end: 1.3 },
      { start: 2.0, end: 2.3 },
      { start: 3.5, end: 3.8 },
    ]
    const ranges = [{ start: 0.0, end: 5.0 }]
    const result = refineSilenceRangesUsingWords(ranges, words, minSilence, 0)
    expect(result).toEqual([
      { start: 0.0, end: 1.0 },
      { start: 1.3, end: 2.0 },
      { start: 2.3, end: 3.5 },
      { start: 3.8, end: 5.0 },
    ])
  })

  it('the 50ms default word-padding matches the documented constant', () => {
    expect(SILENCE_WORD_PADDING_SEC).toBe(0.05)
  })
})
