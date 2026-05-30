import { describe, expect, it } from 'vitest'
import { computeTrimJunctionFades, type FadeablePiece } from './trim-junction-fades'

const FPS = 30

// Helper: build a piece spanning `seconds` (duration), at order `from`.
const piece = (
  id: string,
  from: number,
  seconds = 10,
  extra: Partial<FadeablePiece> = {},
): FadeablePiece => ({
  id,
  from,
  durationInFrames: Math.round(seconds * FPS),
  ...extra,
})

describe('computeTrimJunctionFades', () => {
  it('fades both edges of a kept piece sitting between two removed pieces', () => {
    const pieces = [piece('A', 0), piece('B', 300), piece('C', 600)]
    const updates = computeTrimJunctionFades(pieces, new Set(['A', 'C']), 0.08, FPS)
    expect(updates).toEqual([{ id: 'B', audioFadeIn: 0.08, audioFadeOut: 0.08 }])
  })

  it('fades only the outgoing edge when the next piece is removed', () => {
    const pieces = [piece('A', 0), piece('B', 300)]
    const updates = computeTrimJunctionFades(pieces, new Set(['B']), 0.08, FPS)
    expect(updates).toEqual([{ id: 'A', audioFadeOut: 0.08 }])
  })

  it('fades only the incoming edge when the previous piece is removed', () => {
    const pieces = [piece('A', 0), piece('B', 300)]
    const updates = computeTrimJunctionFades(pieces, new Set(['A']), 0.08, FPS)
    expect(updates).toEqual([{ id: 'B', audioFadeIn: 0.08 }])
  })

  it('returns nothing when no piece is removed', () => {
    const pieces = [piece('A', 0), piece('B', 300)]
    expect(computeTrimJunctionFades(pieces, new Set(), 0.08, FPS)).toEqual([])
  })

  it('caps the fade at 40% of a short piece duration', () => {
    // 0.1s piece → cap 0.04s, well under the requested 0.08s.
    const pieces = [piece('A', 0), piece('B', 300, 0.1), piece('C', 303)]
    const updates = computeTrimJunctionFades(pieces, new Set(['A', 'C']), 0.08, FPS)
    expect(updates[0]?.audioFadeIn).toBeCloseTo(0.04, 5)
    expect(updates[0]?.audioFadeOut).toBeCloseTo(0.04, 5)
  })

  it('never shortens a fade that is already longer', () => {
    // The kept piece A already has a 0.5s fade-out; the junction fade must not reduce it.
    const pieces = [piece('A', 0, 10, { audioFadeOut: 0.5 }), piece('B', 300)]
    const updates = computeTrimJunctionFades(pieces, new Set(['B']), 0.08, FPS)
    expect(updates).toEqual([{ id: 'A', audioFadeOut: 0.5 }])
  })

  it('ignores ordering of the input (sorts by from)', () => {
    const pieces = [piece('C', 600), piece('A', 0), piece('B', 300)]
    const updates = computeTrimJunctionFades(pieces, new Set(['B']), 0.08, FPS)
    // A's next is B (removed) → fadeOut; C's prev is B (removed) → fadeIn.
    expect(updates).toEqual([
      { id: 'A', audioFadeOut: 0.08 },
      { id: 'C', audioFadeIn: 0.08 },
    ])
  })

  it('returns nothing for a non-positive fade or bad fps', () => {
    const pieces = [piece('A', 0), piece('B', 300)]
    expect(computeTrimJunctionFades(pieces, new Set(['B']), 0, FPS)).toEqual([])
    expect(computeTrimJunctionFades(pieces, new Set(['B']), 0.08, 0)).toEqual([])
  })
})
