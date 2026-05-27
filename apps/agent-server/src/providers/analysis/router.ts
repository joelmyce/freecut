import type { AnalysisStrategy, VideoAnalysisInput, VideoAnalysisProvider } from './types.ts'

export interface PickAnalysisProviderResult {
  provider: VideoAnalysisProvider
  reason: string
}

/**
 * Pick a video-analysis provider.
 *
 * Unlike the transcription router, there's no hard-bar for any provider —
 * video analysis has no local alternative, so `auto` resolves to whichever
 * analysis provider is available (currently just Gemini). When more
 * providers land here later (e.g. a hypothetical local LFM analyser),
 * keep `auto` deterministic: pick a single best default rather than
 * randomising.
 */
export function pickAnalysisProvider(
  providers: ReadonlyArray<VideoAnalysisProvider>,
  strategy: AnalysisStrategy,
  _input: VideoAnalysisInput,
): PickAnalysisProviderResult {
  const findAvailable = (id: VideoAnalysisProvider['id']) =>
    providers.find((p) => p.id === id && p.isAvailable())

  if (strategy === 'gemini') {
    const gemini = findAvailable('gemini-flash-video')
    if (!gemini) {
      throw new Error(
        'Gemini video analysis provider is not available (missing GEMINI_API_KEY in .env)',
      )
    }
    return { provider: gemini, reason: 'explicit strategy: gemini' }
  }

  // strategy === 'auto'
  const gemini = findAvailable('gemini-flash-video')
  if (gemini) {
    return { provider: gemini, reason: 'auto: defaulting to gemini-flash-video' }
  }

  throw new Error(
    'No video analysis provider is available. Set GEMINI_API_KEY in .env to enable Gemini.',
  )
}
