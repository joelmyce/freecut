import { addSubtitlesHandler } from './add-subtitles'
import {
  insertGenerationPlaceholderHandler,
  markGenerationPlaceholderErrorHandler,
  removeGenerationPlaceholderHandler,
  swapGenerationPlaceholderHandler,
} from './ai-generation'
import { cutSilenceHandler } from './cut-silence'
import { readClipVideoBytesHandler } from './read-clip-video-bytes'
import { readImageClipForAnimationHandler } from './read-image-clip-for-animation'
import { BrowserActionRegistry } from './registry'
import { readTranscribableAudioHandler } from './read-transcribable-audio'
import { readClipForRegenHandler, replaceClipWithPlaceholderHandler } from './regenerate-clip'
import { saveTranscriptHandler } from './save-transcript'
import { transcribeLocalHandler } from './transcribe-local'
import { readTranscriptContextForRangeHandler } from './transcript-context'

export { BrowserActionRegistry } from './registry'
export type { BrowserActionHandler } from './types'

export function createDefaultBrowserActionRegistry(): BrowserActionRegistry {
  const registry = new BrowserActionRegistry()
  registry.register('transcribe-local', transcribeLocalHandler)
  registry.register('read-transcribable-audio', readTranscribableAudioHandler)
  registry.register('save-transcript', saveTranscriptHandler)
  registry.register('add-subtitles', addSubtitlesHandler)
  registry.register('insert-generation-placeholder', insertGenerationPlaceholderHandler)
  registry.register('swap-generation-placeholder-with-url', swapGenerationPlaceholderHandler)
  registry.register('remove-generation-placeholder', removeGenerationPlaceholderHandler)
  registry.register('mark-generation-placeholder-error', markGenerationPlaceholderErrorHandler)
  registry.register('read-clip-for-regen', readClipForRegenHandler)
  registry.register('replace-clip-with-placeholder', replaceClipWithPlaceholderHandler)
  registry.register('read-transcript-context-for-range', readTranscriptContextForRangeHandler)
  registry.register('cut-silence', cutSilenceHandler)
  registry.register('read-clip-video-bytes', readClipVideoBytesHandler)
  registry.register('read-image-clip-for-animation', readImageClipForAnimationHandler)
  return registry
}
