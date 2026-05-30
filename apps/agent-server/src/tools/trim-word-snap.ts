import type { TrimSuggestion } from '../providers/analysis/index.ts'

export interface WordSpan {
  start: number
  end: number
}

/**
 * Snap each trim's start/end to the nearest WORD boundary when it lands inside
 * a word, so a cut never amputates a word mid-syllable ("cuando" → "cua—").
 * This is the M4.2-bis idea (align cuts to Whisper word edges) applied to
 * suggest_trims' proposed spans.
 *
 * - A boundary already sitting in an inter-word gap is left untouched (the cut
 *   is already clean there).
 * - A boundary inside a word moves to that word's nearer edge — minimal
 *   displacement, and the cut lands in a real gap either way.
 * - Trims that collapse (start >= end) after snapping are dropped.
 * - With no word data the trims pass through unchanged — graceful fallback,
 *   same degradation as the silence path when a transcript lacks word timings.
 *
 * All times are source-native seconds (trims and words share that base).
 */
export function snapTrimsToWordBoundaries(
  trims: ReadonlyArray<TrimSuggestion>,
  words: ReadonlyArray<WordSpan>,
): TrimSuggestion[] {
  if (words.length === 0) return trims.map((t) => ({ ...t }))

  const sorted = [...words].sort((a, b) => a.start - b.start)
  const snapped: TrimSuggestion[] = []
  for (const trim of trims) {
    const startSec = snapEdge(trim.startSec, sorted)
    const endSec = snapEdge(trim.endSec, sorted)
    if (endSec > startSec) {
      snapped.push({ ...trim, startSec, endSec })
    }
  }
  return snapped
}

/** Move a timestamp to the nearer edge of the word it falls strictly inside. */
function snapEdge(t: number, words: ReadonlyArray<WordSpan>): number {
  const inside = words.find((w) => t > w.start && t < w.end)
  if (!inside) return t
  return t - inside.start <= inside.end - t ? inside.start : inside.end
}

/**
 * Pull each trim's edges INWARD by `marginSec` so the cut lands safely inside
 * the dead space, clear of the bordering words' audio. This is the robust,
 * transcriber-agnostic guard against word-clipping: even when Whisper's word
 * edge is off by up to ~marginSec (quiet audio / small models), the cut still
 * won't touch real speech. Trims that collapse to <= 0 width after padding are
 * dropped (too short to cut safely). Rounded to ms; source-native seconds.
 */
export function padTrimsInward(
  trims: ReadonlyArray<TrimSuggestion>,
  marginSec: number,
): TrimSuggestion[] {
  if (marginSec <= 0) return trims.map((t) => ({ ...t }))
  const roundMs = (n: number) => Number(n.toFixed(3))
  const out: TrimSuggestion[] = []
  for (const trim of trims) {
    const startSec = roundMs(trim.startSec + marginSec)
    const endSec = roundMs(trim.endSec - marginSec)
    if (endSec > startSec) out.push({ ...trim, startSec, endSec })
  }
  return out
}
