/**
 * Format a number of seconds as a human-readable timecode — `m:ss`, or
 * `h:mm:ss` once it crosses an hour. Shared by the M6 decision tools
 * (find_moment, detect_chapters) so the agent quotes consistent timecodes.
 */
export function formatTimecode(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds))
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const seconds = safe % 60
  const ss = String(seconds).padStart(2, '0')
  if (hours > 0) {
    const mm = String(minutes).padStart(2, '0')
    return `${hours}:${mm}:${ss}`
  }
  return `${minutes}:${ss}`
}
