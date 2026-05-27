/**
 * Shared helper for §6.5.1 transcript-grounded prompts.
 *
 * Generation tools prepend this block to the model prompt when a transcript
 * covers the relevant time range, so the rendered visual matches the spoken
 * context. Best-effort — callers skip silently when no transcript exists.
 *
 * Cribbed verbatim from PHASE-1-PLAN.md §6.5.1 for fidelity. The "IMPORTANT"
 * line is what nudges models to actually use terms from the segment rather
 * than treating it as background noise.
 */
export interface TranscriptContextInput {
  text: string
  sourceStartSec: number
  sourceEndSec: number
}

export function buildTranscriptContextBlock(context: TranscriptContextInput): string {
  const start = formatSec(context.sourceStartSec)
  const end = formatSec(context.sourceEndSec)
  return [
    'VIDEO CONTEXT (from the transcript):',
    `"${context.text.trim()}"`,
    `This segment is from ${start}s to ${end}s.`,
    'IMPORTANT: Use specific terms, concepts, and themes from this context.',
  ].join('\n')
}

function formatSec(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0.0'
  return sec.toFixed(1)
}
