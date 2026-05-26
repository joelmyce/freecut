import { addSubtitlesHandler } from './add-subtitles'
import { BrowserActionRegistry } from './registry'
import { readTranscribableAudioHandler } from './read-transcribable-audio'
import { saveTranscriptHandler } from './save-transcript'
import { transcribeLocalHandler } from './transcribe-local'

export { BrowserActionRegistry } from './registry'
export type { BrowserActionHandler } from './types'

export function createDefaultBrowserActionRegistry(): BrowserActionRegistry {
  const registry = new BrowserActionRegistry()
  registry.register('transcribe-local', transcribeLocalHandler)
  registry.register('read-transcribable-audio', readTranscribableAudioHandler)
  registry.register('save-transcript', saveTranscriptHandler)
  registry.register('add-subtitles', addSubtitlesHandler)
  return registry
}
