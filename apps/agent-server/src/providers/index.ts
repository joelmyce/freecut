export type {
  BrowserActionBridge,
  ConfirmationDecision,
  ProviderContext,
  ProviderProgressEvent,
} from './types.ts'
export * as analysis from './analysis/index.ts'
export * as gif from './gif/index.ts'
export * as image from './image/index.ts'
export * as transcription from './transcription/index.ts'
export * as tts from './tts/index.ts'
export * as video from './video/index.ts'
import type { VideoAnalysisProvider } from './analysis/types.ts'
import type { TranscriptReasoningProvider } from './analysis/transcript-reasoning.ts'
import type { GifSearchProvider } from './gif/types.ts'
import type { ImageGenerationProvider } from './image/types.ts'
import type { TranscriptionProvider } from './transcription/types.ts'
import type { TtsProvider } from './tts/types.ts'
import type { VideoGenerationProvider } from './video/types.ts'

/**
 * Bundle of every provider the server has constructed at startup. Tools take
 * this and pick the right capability + concrete provider via the per-capability
 * router (e.g. `pickTranscriptionProvider`). Constructed once in `index.ts`
 * from env vars; passed through to `runAgentTurn` per turn.
 */
export interface ProvidersBundle {
  transcription: ReadonlyArray<TranscriptionProvider>
  videoGeneration: ReadonlyArray<VideoGenerationProvider>
  analysis: ReadonlyArray<VideoAnalysisProvider>
  imageGeneration: ReadonlyArray<ImageGenerationProvider>
  gifSearch: ReadonlyArray<GifSearchProvider>
  tts: ReadonlyArray<TtsProvider>
  /**
   * Transcript-reasoning providers (M6 — find_moment, later detect_chapters /
   * suggest_trims). OPTIONAL so the ~47 existing `ProvidersBundle` test
   * literals stay untouched — same zero-churn trick M5.2 used for the bridge's
   * optional `requestConfirmation`. Always set for real in `index.ts`; tools
   * read it as `?? []` and the router throws if the list is empty.
   */
  transcriptReasoning?: ReadonlyArray<TranscriptReasoningProvider>
}
