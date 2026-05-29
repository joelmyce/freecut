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

import type { ConfirmationCard, ConfirmationDecisionKind } from '../bridge/protocol.ts'

export interface ConfirmationDecision {
  decision: ConfirmationDecisionKind
  /** Field overrides supplied when the user chose "edit". Keys match the
   *  `editableFields[].key` the tool declared on the card. */
  edits?: Record<string, unknown>
}

export interface BrowserActionBridge {
  invokeBrowserAction<T = unknown>(action: string, args: unknown, signal: AbortSignal): Promise<T>
  /**
   * M5.2 concept-card approval: ask the user to approve/reject/edit an
   * expensive, side-effecting render BEFORE it runs. Resolves with the
   * decision; rejects on timeout / abort / socket close (treat a rejection as
   * "no" — make no timeline mutation).
   *
   * OPTIONAL so lightweight test mocks and any non-socket bridge can omit it;
   * a tool that finds it absent simply proceeds without a gate. The real
   * `SocketBrowserActionBridge` always provides it.
   */
  requestConfirmation?(card: ConfirmationCard, signal: AbortSignal): Promise<ConfirmationDecision>
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
