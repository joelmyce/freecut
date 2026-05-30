import type { TranscriptionInput, TranscriptionProvider, TranscriptionStrategy } from './types.ts'

export interface PickTranscriptionProviderResult {
  provider: TranscriptionProvider
  reason: string
}

export function pickTranscriptionProvider(
  providers: ReadonlyArray<TranscriptionProvider>,
  strategy: TranscriptionStrategy,
  // Kept for API symmetry with the analysis routers; routing no longer depends
  // on clip duration now that cloud providers are explicit-only.
  _input: TranscriptionInput,
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

  if (strategy === 'gemini') {
    const gemini = findAvailable('gemini-flash')
    if (!gemini) {
      throw new Error(
        'Gemini transcription provider is not available (missing GEMINI_API_KEY in .env)',
      )
    }
    return { provider: gemini, reason: 'explicit strategy: gemini' }
  }

  // PHASE-1-PLAN.md §6.5.4 + 2026-05-30 user decision: NEITHER Gemini nor OpenAI
  // is auto-selected — both are explicit-only. Local whisper-small won on real
  // (Spanish) content, and silently routing to a cloud Whisper surprised the
  // user, so `auto` is always local-first. OpenAI stays a last-resort fallback
  // ONLY when local is genuinely unavailable (e.g. WebCodecs/WebGPU missing) —
  // never chosen by clip length.
  const local = findAvailable('local-whisper')
  if (local) {
    return {
      provider: local,
      reason: 'auto: preferring local (cloud providers are explicit-only)',
    }
  }

  const openai = findAvailable('openai-whisper')
  if (openai) {
    return { provider: openai, reason: 'auto: local unavailable, falling back to openai' }
  }

  throw new Error('No transcription provider is available')
}
