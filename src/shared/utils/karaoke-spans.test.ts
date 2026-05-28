import { describe, expect, it } from 'vitest'
import { buildKaraokeSpans, DEFAULT_KARAOKE_HIGHLIGHT } from './karaoke-spans'
import type { SubtitleSegmentCue } from '@/types/timeline'

const HIGHLIGHT = '#FFD700'

function cueWithWords(
  words: Array<{ text: string; start: number; end: number }>,
): SubtitleSegmentCue {
  return {
    id: 'test-cue',
    startSeconds: words[0]?.start ?? 0,
    endSeconds: words[words.length - 1]?.end ?? 0,
    text: words.map((w) => w.text).join(' '),
    words,
  }
}

describe('buildKaraokeSpans', () => {
  it('returns null when the cue has no words[]', () => {
    const cue: SubtitleSegmentCue = {
      id: 'no-words',
      startSeconds: 0,
      endSeconds: 1,
      text: 'hello world',
    }
    expect(buildKaraokeSpans(cue, 0.5, HIGHLIGHT)).toBeNull()
  })

  it('returns null when words[] is empty', () => {
    const cue = cueWithWords([])
    cue.words = []
    expect(buildKaraokeSpans(cue, 0.5, HIGHLIGHT)).toBeNull()
  })

  it('highlights the active word at a time inside its window', () => {
    const cue = cueWithWords([
      { text: 'hello', start: 0, end: 0.3 },
      { text: 'world', start: 0.4, end: 0.6 },
      { text: 'today', start: 0.7, end: 1.0 },
    ])

    const result = buildKaraokeSpans(cue, 0.5, HIGHLIGHT)
    expect(result).not.toBeNull()
    expect(result!.plainText).toBe('hello world today')
    expect(result!.spans).toHaveLength(3)
    // 'hello' — not active
    expect(result!.spans[0]).toEqual({ text: 'hello ' })
    // 'world' — ACTIVE: gets the highlight color
    expect(result!.spans[1]).toEqual({ text: 'world ', color: HIGHLIGHT })
    // 'today' — not active
    expect(result!.spans[2]).toEqual({ text: 'today' })
  })

  it('honors a custom highlight color override', () => {
    const cue = cueWithWords([{ text: 'one', start: 0, end: 0.5 }])
    const result = buildKaraokeSpans(cue, 0.25, '#FF00FF')
    expect(result!.spans[0]).toEqual({ text: 'one', color: '#FF00FF' })
  })

  it('holds the highlight on a previously-spoken word during between-word pauses', () => {
    const cue = cueWithWords([
      { text: 'one', start: 0, end: 0.3 },
      // Pause from 0.3 to 0.7 — karaoke convention is to keep the last
      // word lit until the next one starts.
      { text: 'two', start: 0.7, end: 1.0 },
    ])

    const result = buildKaraokeSpans(cue, 0.5, HIGHLIGHT)
    expect(result!.spans[0]).toEqual({ text: 'one ', color: HIGHLIGHT })
    expect(result!.spans[1]).toEqual({ text: 'two' })
  })

  it('leaves no word highlighted before the first word starts', () => {
    const cue = cueWithWords([
      { text: 'late', start: 0.5, end: 0.8 },
      { text: 'start', start: 0.9, end: 1.2 },
    ])

    const result = buildKaraokeSpans(cue, 0.2, HIGHLIGHT)
    expect(result!.spans.every((s) => s.color === undefined)).toBe(true)
  })

  it('holds the last word highlighted after the cue ends', () => {
    const cue = cueWithWords([
      { text: 'first', start: 0, end: 0.4 },
      { text: 'last', start: 0.5, end: 0.9 },
    ])

    const result = buildKaraokeSpans(cue, 2.0, HIGHLIGHT)
    expect(result!.spans[0]).toEqual({ text: 'first ' })
    expect(result!.spans[1]).toEqual({ text: 'last', color: HIGHLIGHT })
  })

  it('puts whitespace on every word except the last so concatenated text reads naturally', () => {
    const cue = cueWithWords([
      { text: 'a', start: 0, end: 0.1 },
      { text: 'b', start: 0.1, end: 0.2 },
      { text: 'c', start: 0.2, end: 0.3 },
    ])

    const result = buildKaraokeSpans(cue, 0.05, HIGHLIGHT)
    expect(result!.spans.map((s) => s.text)).toEqual(['a ', 'b ', 'c'])
    expect(result!.plainText).toBe('a b c')
  })

  it('exports a sensible DEFAULT_KARAOKE_HIGHLIGHT constant', () => {
    expect(DEFAULT_KARAOKE_HIGHLIGHT).toBe('#FFD700')
  })
})
