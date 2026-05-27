/**
 * Helpers shared between the pill picker and the chat input. Lives in its
 * own module so the picker can stay "components-only" for React Fast Refresh.
 */

export type ReferencePill =
  | {
      kind: 'clip'
      itemId: string
      label: string
      trackName: string
      /** Clip's start position on the timeline, in seconds. */
      fromSeconds: number
    }
  | { kind: 'range'; startSeconds: number; endSeconds: number }

/**
 * Compile pills into a bracket-tagged context line prepended to the user's
 * prompt. Stable shape so the system prompt can teach the agent how to parse:
 *   [Clip: foo.mp4 on V1 at 0:00 (item:XYZ)]
 *   [Time Range: 0:12–0:18]
 */
export function compilePillContext(pills: ReadonlyArray<ReferencePill>): string {
  if (pills.length === 0) return ''
  const lines: string[] = []
  for (const pill of pills) {
    if (pill.kind === 'clip') {
      lines.push(
        `[Clip: ${pill.label} on ${pill.trackName} at ${formatSec(pill.fromSeconds)} (item:${pill.itemId})]`,
      )
    } else {
      lines.push(`[Time Range: ${formatRange(pill.startSeconds, pill.endSeconds)}]`)
    }
  }
  return lines.join('\n')
}

export function formatRange(startSec: number, endSec: number): string {
  return `${formatSec(startSec)}–${formatSec(endSec)}`
}

export function formatSec(sec: number): string {
  const safe = Number.isFinite(sec) && sec >= 0 ? sec : 0
  const minutes = Math.floor(safe / 60)
  const seconds = Math.floor(safe % 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}
