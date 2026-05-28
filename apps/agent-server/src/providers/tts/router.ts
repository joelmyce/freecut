import type { TtsProvider, TtsStrategy } from './types.ts'

export interface PickTtsProviderResult {
  provider: TtsProvider
  reason: string
}

/**
 * Pick a TTS provider for `generate_voiceover` (M5).
 *
 * Default `auto` strategy prefers `kokoro` (local, free, ~1-3s on WebGPU)
 * over `elevenlabs` (cloud, paid). Explicit strategies require the named
 * provider to be available, else throw with a hint about the missing
 * prerequisite.
 *
 * Both providers are first-class for the voiceover capability — unlike
 * the Gemini transcription router there's no opt-in restriction. The user
 * picks ElevenLabs by saying so ("studio quality", "use elevenlabs",
 * naming an ElevenLabs voice id).
 */
export function pickTtsProvider(
  providers: ReadonlyArray<TtsProvider>,
  strategy: TtsStrategy,
): PickTtsProviderResult {
  const findAvailable = (id: TtsProvider['id']) =>
    providers.find((p) => p.id === id && p.isAvailable())

  if (strategy === 'kokoro') {
    const kokoro = findAvailable('kokoro')
    if (!kokoro) throw new Error('Kokoro TTS provider is not available')
    return { provider: kokoro, reason: 'explicit strategy: kokoro' }
  }

  if (strategy === 'elevenlabs') {
    const eleven = findAvailable('elevenlabs')
    if (!eleven) {
      throw new Error('ElevenLabs TTS provider is not available (missing ELEVENLABS_API_KEY)')
    }
    return { provider: eleven, reason: 'explicit strategy: elevenlabs' }
  }

  const kokoro = findAvailable('kokoro')
  if (kokoro) return { provider: kokoro, reason: 'auto: defaulting to local kokoro' }

  const eleven = findAvailable('elevenlabs')
  if (eleven) {
    return { provider: eleven, reason: 'auto: kokoro unavailable, using elevenlabs' }
  }

  throw new Error(
    'No TTS provider is available. Set ELEVENLABS_API_KEY in .env to enable ElevenLabs, or attach a browser to use local Kokoro.',
  )
}
