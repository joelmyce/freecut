/**
 * Compute short audio fades for the kept clip pieces that border a removed
 * piece after a range removal (e.g. suggest_trims). A hard splice between two
 * non-adjacent moments sounds abrupt; a brief fade-out into the cut + fade-in
 * out of it de-clicks the junction. Audio-only — the video stays a clean
 * jump-cut.
 *
 * Pure + position-independent: takes the post-split pieces of ONE clip plus the
 * set of pieces being removed, and returns the audio-fade updates for the kept
 * pieces adjacent to a removal. The caller applies them via `_updateItem`
 * inside the removal's `execute()` so they share one undo entry.
 */

export interface FadeablePiece {
  id: string
  /** Timeline start frame — used only to order the pieces. */
  from: number
  /** Clip length in project frames — used to cap the fade on short pieces. */
  durationInFrames: number
  audioFadeIn?: number
  audioFadeOut?: number
}

export interface JunctionFadeUpdate {
  id: string
  audioFadeIn?: number
  audioFadeOut?: number
}

/** A fade never eats more than this fraction of a (short) piece's duration. */
const MAX_FADE_FRACTION = 0.4

export function computeTrimJunctionFades(
  pieces: ReadonlyArray<FadeablePiece>,
  idsToRemove: ReadonlySet<string>,
  fadeSec: number,
  fps: number,
): JunctionFadeUpdate[] {
  if (fadeSec <= 0 || !Number.isFinite(fps) || fps <= 0) return []

  const sorted = [...pieces].sort((a, b) => a.from - b.from)
  const updates: JunctionFadeUpdate[] = []

  for (let i = 0; i < sorted.length; i++) {
    const piece = sorted[i]!
    if (idsToRemove.has(piece.id)) continue // removed pieces don't get fades

    const prevRemoved = i > 0 && idsToRemove.has(sorted[i - 1]!.id)
    const nextRemoved = i < sorted.length - 1 && idsToRemove.has(sorted[i + 1]!.id)
    if (!prevRemoved && !nextRemoved) continue

    const clipDurSec = piece.durationInFrames / fps
    const fade = Math.min(fadeSec, clipDurSec * MAX_FADE_FRACTION)
    if (fade <= 0) continue

    const update: JunctionFadeUpdate = { id: piece.id }
    // Don't shorten a fade the user (or an earlier pass) already set.
    if (prevRemoved) update.audioFadeIn = Math.max(piece.audioFadeIn ?? 0, fade)
    if (nextRemoved) update.audioFadeOut = Math.max(piece.audioFadeOut ?? 0, fade)
    updates.push(update)
  }

  return updates
}
