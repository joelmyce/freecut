import { describe, expect, it } from 'vitest'
import { pickAnalysisProvider } from './router.ts'
import type { VideoAnalysisProvider, VideoAnalysisResult } from './types.ts'

function mockProvider(available: boolean): VideoAnalysisProvider {
  return {
    id: 'gemini-flash-video',
    isAvailable: () => available,
    analyze: async (): Promise<VideoAnalysisResult> => ({
      visualDescription: '',
      mood: '',
      lighting: '',
      colorPalette: [],
      cameraMovement: '',
      subject: '',
      audioSummary: '',
      pace: '',
      suggestedBrollPrompts: [],
    }),
  }
}

describe('pickAnalysisProvider', () => {
  it('returns gemini when "gemini" is requested and available', () => {
    const result = pickAnalysisProvider([mockProvider(true)], 'gemini', { clipId: 'item:abc' })
    expect(result.provider.id).toBe('gemini-flash-video')
    expect(result.reason).toMatch(/explicit/)
  })

  it('throws when "gemini" is requested but unavailable', () => {
    expect(() =>
      pickAnalysisProvider([mockProvider(false)], 'gemini', { clipId: 'item:abc' }),
    ).toThrow(/GEMINI_API_KEY/)
  })

  it('auto defaults to gemini when available', () => {
    const result = pickAnalysisProvider([mockProvider(true)], 'auto', { clipId: 'item:abc' })
    expect(result.provider.id).toBe('gemini-flash-video')
    expect(result.reason).toMatch(/auto: defaulting to gemini/)
  })

  it('auto throws when no provider is available', () => {
    expect(() =>
      pickAnalysisProvider([mockProvider(false)], 'auto', { clipId: 'item:abc' }),
    ).toThrow(/No video analysis provider is available/)
  })

  it('auto throws when the provider list is empty', () => {
    expect(() => pickAnalysisProvider([], 'auto', { clipId: 'item:abc' })).toThrow(
      /No video analysis provider is available/,
    )
  })
})
