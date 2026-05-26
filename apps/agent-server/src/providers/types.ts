/**
 * Shared types for the provider layer.
 *
 * A provider is a thin adapter over a single external capability (Whisper
 * transcription, FAL video gen, ElevenLabs TTS, etc). Some providers run
 * server-side and call remote APIs directly; some delegate to the browser
 * via the bridge (e.g. local Whisper, which already runs in the browser).
 *
 * Provider impls never touch the WebSocket directly — they take a
 * `BrowserActionBridge` from their `ProviderContext` and call
 * `invokeBrowserAction(action, args, signal)`. The real bridge is wired
 * up in `bridge/server.ts` (commit 3 work); tests pass in a mock.
 */

export interface BrowserActionBridge {
  invokeBrowserAction<T = unknown>(action: string, args: unknown, signal: AbortSignal): Promise<T>
}

export interface ProviderProgressEvent {
  stage: string
  fraction?: number
  detail?: string
}

export interface ProviderContext {
  bridge: BrowserActionBridge
  signal: AbortSignal
  onProgress?: (event: ProviderProgressEvent) => void
}
