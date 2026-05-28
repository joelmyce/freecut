import { describe, expect, it } from 'vitest'
import { pickTtsProvider } from './router.ts'
import type { TtsProvider } from './types.ts'

function makeProvider(id: TtsProvider['id'], available: boolean): TtsProvider {
  return {
    id,
    isAvailable: () => available,
    synthesize: async () => ({
      audioBytesBase64: '',
      mimeType: 'audio/wav',
      durationSec: 0,
      modelUsed: 'stub',
    }),
  }
}

describe('pickTtsProvider', () => {
  it('auto: prefers kokoro when available', () => {
    const providers = [makeProvider('kokoro', true), makeProvider('elevenlabs', true)]
    const result = pickTtsProvider(providers, 'auto')
    expect(result.provider.id).toBe('kokoro')
    expect(result.reason).toMatch(/auto/)
  })

  it('auto: falls back to elevenlabs when kokoro is unavailable', () => {
    const providers = [makeProvider('kokoro', false), makeProvider('elevenlabs', true)]
    const result = pickTtsProvider(providers, 'auto')
    expect(result.provider.id).toBe('elevenlabs')
    expect(result.reason).toMatch(/kokoro unavailable/)
  })

  it('explicit kokoro: throws when kokoro is unavailable', () => {
    const providers = [makeProvider('kokoro', false), makeProvider('elevenlabs', true)]
    expect(() => pickTtsProvider(providers, 'kokoro')).toThrow(
      /Kokoro TTS provider is not available/,
    )
  })

  it('explicit elevenlabs: throws with ELEVENLABS_API_KEY hint when key is missing', () => {
    const providers = [makeProvider('kokoro', true), makeProvider('elevenlabs', false)]
    expect(() => pickTtsProvider(providers, 'elevenlabs')).toThrow(/ELEVENLABS_API_KEY/)
  })

  it('explicit kokoro: succeeds when kokoro is available even with elevenlabs available', () => {
    const providers = [makeProvider('kokoro', true), makeProvider('elevenlabs', true)]
    const result = pickTtsProvider(providers, 'kokoro')
    expect(result.provider.id).toBe('kokoro')
    expect(result.reason).toMatch(/explicit/)
  })

  it('throws helpful error when no provider is available at all', () => {
    const providers = [makeProvider('kokoro', false), makeProvider('elevenlabs', false)]
    expect(() => pickTtsProvider(providers, 'auto')).toThrow(/No TTS provider is available/)
  })
})
