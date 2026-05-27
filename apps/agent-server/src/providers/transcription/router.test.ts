import { describe, expect, it } from 'vitest'
import { LONG_CLIP_THRESHOLD_SEC, pickTranscriptionProvider } from './router.ts'
import type { Transcript, TranscriptionProvider, TranscriptionProviderId } from './types.ts'

function mockProvider(id: TranscriptionProviderId, available: boolean): TranscriptionProvider {
  return {
    id,
    isAvailable: () => available,
    transcribe: async (): Promise<Transcript> => ({
      text: '',
      segments: [],
      durationSec: 0,
    }),
  }
}

const localOnly: ReadonlyArray<TranscriptionProvider> = [
  mockProvider('local-whisper', true),
  mockProvider('openai-whisper', false),
]
const both: ReadonlyArray<TranscriptionProvider> = [
  mockProvider('local-whisper', true),
  mockProvider('openai-whisper', true),
]
const openaiOnly: ReadonlyArray<TranscriptionProvider> = [
  mockProvider('local-whisper', false),
  mockProvider('openai-whisper', true),
]
const none: ReadonlyArray<TranscriptionProvider> = [
  mockProvider('local-whisper', false),
  mockProvider('openai-whisper', false),
]

describe('pickTranscriptionProvider — explicit strategy', () => {
  it('returns local when "local" is requested and available', () => {
    const result = pickTranscriptionProvider(both, 'local', { assetId: 'm1' })
    expect(result.provider.id).toBe('local-whisper')
  })

  it('throws when "local" is requested but unavailable', () => {
    expect(() => pickTranscriptionProvider(openaiOnly, 'local', { assetId: 'm1' })).toThrow(
      /not available/i,
    )
  })

  it('returns openai when "openai" is requested and available', () => {
    const result = pickTranscriptionProvider(both, 'openai', { assetId: 'm1' })
    expect(result.provider.id).toBe('openai-whisper')
  })

  it('throws with OPENAI_API_KEY hint when "openai" is requested but unavailable', () => {
    expect(() => pickTranscriptionProvider(localOnly, 'openai', { assetId: 'm1' })).toThrow(
      /OPENAI_API_KEY/,
    )
  })
})

describe('pickTranscriptionProvider — gemini (opt-in)', () => {
  const withGemini: ReadonlyArray<TranscriptionProvider> = [
    mockProvider('local-whisper', true),
    mockProvider('openai-whisper', true),
    mockProvider('gemini-flash', true),
  ]
  const withoutGemini: ReadonlyArray<TranscriptionProvider> = [
    mockProvider('local-whisper', true),
    mockProvider('openai-whisper', true),
    mockProvider('gemini-flash', false),
  ]

  it('returns gemini when "gemini" is requested and available', () => {
    const result = pickTranscriptionProvider(withGemini, 'gemini', { assetId: 'm1' })
    expect(result.provider.id).toBe('gemini-flash')
    expect(result.reason).toMatch(/explicit/i)
  })

  it('throws when "gemini" is requested but unavailable (missing GEMINI_API_KEY)', () => {
    expect(() => pickTranscriptionProvider(withoutGemini, 'gemini', { assetId: 'm1' })).toThrow(
      /GEMINI_API_KEY/,
    )
  })

  it('NEVER picks gemini under auto, even when it is the only available provider for a long clip', () => {
    const geminiOnly: ReadonlyArray<TranscriptionProvider> = [
      mockProvider('local-whisper', false),
      mockProvider('openai-whisper', false),
      mockProvider('gemini-flash', true),
    ]
    expect(() =>
      pickTranscriptionProvider(geminiOnly, 'auto', {
        assetId: 'm1',
        durationSec: LONG_CLIP_THRESHOLD_SEC + 1,
      }),
    ).toThrow(/no transcription provider/i)
  })

  it('auto prefers local/openai even when gemini is available', () => {
    const result = pickTranscriptionProvider(withGemini, 'auto', {
      assetId: 'm1',
      durationSec: 60,
    })
    expect(result.provider.id).toBe('local-whisper')
  })
})

describe('pickTranscriptionProvider — auto strategy', () => {
  it('picks local for short clips when both providers are available', () => {
    const result = pickTranscriptionProvider(both, 'auto', {
      assetId: 'm1',
      durationSec: 60,
    })
    expect(result.provider.id).toBe('local-whisper')
  })

  it('picks openai for long clips when both providers are available', () => {
    const result = pickTranscriptionProvider(both, 'auto', {
      assetId: 'm1',
      durationSec: LONG_CLIP_THRESHOLD_SEC + 1,
    })
    expect(result.provider.id).toBe('openai-whisper')
  })

  it('falls back to local when the clip is long but openai is unavailable', () => {
    const result = pickTranscriptionProvider(localOnly, 'auto', {
      assetId: 'm1',
      durationSec: LONG_CLIP_THRESHOLD_SEC + 1,
    })
    expect(result.provider.id).toBe('local-whisper')
    expect(result.reason).toMatch(/falling back to local/i)
  })

  it('uses openai when local is unavailable', () => {
    const result = pickTranscriptionProvider(openaiOnly, 'auto', {
      assetId: 'm1',
      durationSec: 60,
    })
    expect(result.provider.id).toBe('openai-whisper')
  })

  it('throws when no provider is available', () => {
    expect(() => pickTranscriptionProvider(none, 'auto', { assetId: 'm1' })).toThrow(
      /no transcription provider/i,
    )
  })

  it('treats unknown duration as short and prefers local', () => {
    const result = pickTranscriptionProvider(both, 'auto', { assetId: 'm1' })
    expect(result.provider.id).toBe('local-whisper')
  })
})
