import { describe, expect, it } from 'vitest'
import { padTrimsInward, snapTrimsToWordBoundaries, type WordSpan } from './trim-word-snap.ts'
import type { TrimSuggestion } from '../providers/analysis/index.ts'

const trim = (startSec: number, endSec: number, reason = 'r'): TrimSuggestion => ({
  startSec,
  endSec,
  reason,
})

describe('snapTrimsToWordBoundaries', () => {
  it('passes trims through unchanged when there are no words', () => {
    const input = [trim(5, 9, 'rambling')]
    expect(snapTrimsToWordBoundaries(input, [])).toEqual([trim(5, 9, 'rambling')])
  })

  it('snaps a start that falls inside a word to the nearer edge', () => {
    const words: WordSpan[] = [{ start: 4.8, end: 5.4 }]
    // start 5.0 is inside; 5-4.8=0.2 < 5.4-5=0.4 → snap to 4.8. end 9 is free.
    expect(snapTrimsToWordBoundaries([trim(5, 9)], words)).toEqual([trim(4.8, 9)])
  })

  it('snaps an end that falls inside a word to the nearer edge', () => {
    const words: WordSpan[] = [{ start: 8.6, end: 9.2 }]
    // end 9.0 is inside; 9-8.6=0.4 > 9.2-9=0.2 → snap to 9.2. start 5 is free.
    expect(snapTrimsToWordBoundaries([trim(5, 9)], words)).toEqual([trim(5, 9.2)])
  })

  it('leaves a boundary already in an inter-word gap untouched', () => {
    const words: WordSpan[] = [
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ]
    expect(snapTrimsToWordBoundaries([trim(2.5, 2.8)], words)).toEqual([trim(2.5, 2.8)])
  })

  it('breaks an exact-midpoint tie toward the word start', () => {
    const words: WordSpan[] = [{ start: 4, end: 6 }]
    // start 5 is the midpoint: 5-4 <= 6-5 → snap to 4.
    expect(snapTrimsToWordBoundaries([trim(5, 9)], words)[0]?.startSec).toBe(4)
  })

  it('drops a trim that collapses to zero width after snapping', () => {
    const words: WordSpan[] = [{ start: 4.9, end: 5.1 }]
    // both 5.05 and 5.06 are nearer the end (5.1) → both snap to 5.1 → collapsed.
    expect(snapTrimsToWordBoundaries([trim(5.05, 5.06)], words)).toEqual([])
  })

  it('preserves the reason and handles multiple trims', () => {
    const words: WordSpan[] = [
      { start: 4.8, end: 5.4 },
      { start: 29.6, end: 30.4 },
    ]
    const result = snapTrimsToWordBoundaries(
      [trim(5, 9, 'rambling'), trim(30, 35, 'long pause')],
      words,
    )
    expect(result).toEqual([trim(4.8, 9, 'rambling'), trim(29.6, 35, 'long pause')])
  })
})

describe('padTrimsInward', () => {
  it('pulls both edges inward by the margin and preserves the reason', () => {
    expect(padTrimsInward([trim(5, 9, 'rambling')], 0.12)).toEqual([trim(5.12, 8.88, 'rambling')])
  })

  it('drops a trim too short to survive the inward padding', () => {
    // 0.2s span, 0.12 margin each side → 10.12 > 10.08 → collapsed.
    expect(padTrimsInward([trim(10, 10.2)], 0.12)).toEqual([])
  })

  it('passes trims through unchanged when the margin is zero', () => {
    expect(padTrimsInward([trim(5, 9, 'x')], 0)).toEqual([trim(5, 9, 'x')])
  })

  it('rounds to millisecond precision', () => {
    const [out] = padTrimsInward([trim(5, 9)], 0.125)
    expect(out?.startSec).toBe(5.125)
    expect(out?.endSec).toBe(8.875)
  })
})
