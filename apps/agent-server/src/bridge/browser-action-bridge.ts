import { randomUUID } from 'node:crypto'
import type { BrowserActionBridge, ConfirmationDecision } from '../providers/types.ts'
import type {
  ConfirmationCard,
  ConfirmationDecisionKind,
  ServerToBrowserMessage,
} from './protocol.ts'

/**
 * Default timeout for a single browser-delegated action. Provider-level work
 * (e.g. local whisper inference on a 10-minute clip) can run for several
 * minutes, so this is generous. Override per-construction if needed.
 */
export const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Default timeout for a concept-card confirmation (M5.2). A human is in the
 * loop so this is much longer than a browser action — but bounded so a stuck
 * card doesn't pin a turn forever. On timeout the awaiting tool's promise
 * rejects; tools treat that as "no" and make no mutation.
 */
export const DEFAULT_CONFIRMATION_TIMEOUT_MS = 30 * 60 * 1000

export interface BridgeSocketSender {
  send(message: ServerToBrowserMessage): void
  isOpen(): boolean
}

interface PendingEntry {
  cleanup(): void
  resolve(result: unknown): void
  reject(reason: Error): void
}

interface PendingConfirmation {
  cleanup(): void
  resolve(decision: ConfirmationDecision): void
  reject(reason: Error): void
}

/**
 * Per-client correlator that turns the fire-and-forget
 * `invoke-browser-action` / `browser-action-result` protocol into request/
 * response Promises. Providers depend on the `BrowserActionBridge` interface,
 * so the rest of the server doesn't know there's a WebSocket underneath.
 */
export class SocketBrowserActionBridge implements BrowserActionBridge {
  private readonly pending = new Map<string, PendingEntry>()
  private readonly pendingConfirmations = new Map<string, PendingConfirmation>()

  constructor(
    private readonly sender: BridgeSocketSender,
    private readonly timeoutMs: number = DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
    private readonly confirmationTimeoutMs: number = DEFAULT_CONFIRMATION_TIMEOUT_MS,
  ) {}

  async invokeBrowserAction<T = unknown>(
    action: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<T> {
    if (signal.aborted) {
      throw new DOMException(`aborted before sending: ${action}`, 'AbortError')
    }
    if (!this.sender.isOpen()) {
      throw new Error(`bridge socket is closed; cannot send ${action}`)
    }

    const requestId = randomUUID()

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        entry.reject(new Error(`browser action timed out after ${this.timeoutMs}ms: ${action}`))
      }, this.timeoutMs)

      const abortListener = (): void => {
        // Best-effort: tell the browser to stop the in-flight work. The
        // browser may not finish before we drop the pending entry — that's
        // fine, late results land in `handleResult` and no-op.
        if (this.sender.isOpen()) {
          this.sender.send({ type: 'cancel-browser-action', requestId })
        }
        entry.reject(new DOMException(`browser action aborted: ${action}`, 'AbortError'))
      }

      const entry: PendingEntry = {
        cleanup: () => {
          clearTimeout(timeout)
          signal.removeEventListener('abort', abortListener)
          this.pending.delete(requestId)
        },
        resolve: (result) => {
          entry.cleanup()
          resolve(result as T)
        },
        reject: (reason) => {
          entry.cleanup()
          reject(reason)
        },
      }

      this.pending.set(requestId, entry)
      signal.addEventListener('abort', abortListener, { once: true })

      this.sender.send({
        type: 'invoke-browser-action',
        requestId,
        action,
        args,
      })
    })
  }

  /**
   * Resolve (or reject) a pending action when its `browser-action-result`
   * arrives. Silently no-ops for unknown requestIds — the action may have
   * already aborted, timed out, or belonged to a previous turn.
   */
  handleResult(requestId: string, result?: unknown, error?: string): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    if (error !== undefined) {
      entry.reject(new Error(error))
    } else {
      entry.resolve(result)
    }
  }

  /**
   * M5.2: ask the user to approve/reject/edit an expensive render. Mirrors
   * `invokeBrowserAction` but uses the dedicated `pending-confirmation` /
   * `confirmation-response` message pair and a longer timeout. Unlike a
   * browser action, an abort does NOT send a cancel message — there is no
   * cancel-confirmation wire message; the browser expires the dangling card
   * when the turn ends.
   */
  async requestConfirmation(
    card: ConfirmationCard,
    signal: AbortSignal,
  ): Promise<ConfirmationDecision> {
    if (signal.aborted) {
      throw new DOMException('aborted before requesting confirmation', 'AbortError')
    }
    if (!this.sender.isOpen()) {
      throw new Error('bridge socket is closed; cannot request confirmation')
    }

    const confirmationId = randomUUID()

    return await new Promise<ConfirmationDecision>((resolve, reject) => {
      const timeout = setTimeout(() => {
        entry.reject(new Error(`confirmation timed out after ${this.confirmationTimeoutMs}ms`))
      }, this.confirmationTimeoutMs)

      const abortListener = (): void => {
        entry.reject(new DOMException('confirmation aborted', 'AbortError'))
      }

      const entry: PendingConfirmation = {
        cleanup: () => {
          clearTimeout(timeout)
          signal.removeEventListener('abort', abortListener)
          this.pendingConfirmations.delete(confirmationId)
        },
        resolve: (decision) => {
          entry.cleanup()
          resolve(decision)
        },
        reject: (reason) => {
          entry.cleanup()
          reject(reason)
        },
      }

      this.pendingConfirmations.set(confirmationId, entry)
      signal.addEventListener('abort', abortListener, { once: true })

      this.sender.send({ type: 'pending-confirmation', confirmationId, ...card })
    })
  }

  /**
   * Resolve a pending confirmation when its `confirmation-response` arrives.
   * Silently no-ops for unknown ids — the confirmation may have already
   * aborted, timed out, or belonged to a previous turn.
   */
  handleConfirmationResponse(
    confirmationId: string,
    decision: ConfirmationDecisionKind,
    edits?: Record<string, unknown>,
  ): void {
    const entry = this.pendingConfirmations.get(confirmationId)
    if (!entry) return
    entry.resolve({ decision, edits })
  }

  /**
   * Reject every in-flight action AND confirmation — used when the underlying
   * socket closes.
   */
  rejectAll(reason: Error): void {
    for (const entry of [...this.pending.values()]) {
      entry.reject(reason)
    }
    for (const entry of [...this.pendingConfirmations.values()]) {
      entry.reject(reason)
    }
  }
}
