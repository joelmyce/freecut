import type { TranscriptionInput, TranscriptionProvider, TranscriptionStrategy } from './types.ts'

// 30 minutes — picked as a starting heuristic in PHASE-1-PLAN.md §2.2.
// Below this, local-whisper is preferred (free, no API call); above this,
// route to cloud where available because long-running local transcription
// blocks the browser tab.
export const LONG_CLIP_THRESHOLD_SEC = 30 * 60

export interface PickTranscriptionProviderResult {
  provider: TranscriptionProvider
  reason: string
}

export function pickTranscriptionProvider(
  providers: ReadonlyArray<TranscriptionProvider>,
  strategy: TranscriptionStrategy,
  input: TranscriptionInput,
): PickTranscriptionProviderResult {
  const findAvailable = (id: TranscriptionProvider['id']) =>
    providers.find((p) => p.id === id && p.isAvailable())

  if (strategy === 'local') {
    const local = findAvailable('local-whisper')
    if (!local) throw new Error('Local Whisper provider is not available')
    return { provider: local, reason: 'explicit strategy: local' }
  }

  if (strategy === 'openai') {
    const openai = findAvailable('openai-whisper')
    if (!openai) {
      throw new Error('OpenAI Whisper provider is not available (missing OPENAI_API_KEY)')
    }
    return { provider: openai, reason: 'explicit strategy: openai' }
  }

  const isLong = (input.durationSec ?? 0) >= LONG_CLIP_THRESHOLD_SEC
  if (isLong) {
    const openai = findAvailable('openai-whisper')
    if (openai) {
      return {
        provider: openai,
        reason: `auto: clip >= ${LONG_CLIP_THRESHOLD_SEC}s, routing to openai`,
      }
    }
  }

  const local = findAvailable('local-whisper')
  if (local) {
    return {
      provider: local,
      reason: isLong
        ? `auto: clip >= ${LONG_CLIP_THRESHOLD_SEC}s but openai unavailable, falling back to local`
        : 'auto: short clip, preferring local',
    }
  }

  const openai = findAvailable('openai-whisper')
  if (openai) {
    return { provider: openai, reason: 'auto: local unavailable, using openai' }
  }

  throw new Error('No transcription provider is available')
}
