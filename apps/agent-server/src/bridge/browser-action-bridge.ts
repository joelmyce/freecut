import { randomUUID } from 'node:crypto'
import type { BrowserActionBridge } from '../providers/types.ts'
import type { ServerToBrowserMessage } from './protocol.ts'

/**
 * Default timeout for a single browser-delegated action. Provider-level work
 * (e.g. local whisper inference on a 10-minute clip) can run for several
 * minutes, so this is generous. Override per-construction if needed.
 */
export const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 10 * 60 * 1000

export interface BridgeSocketSender {
  send(message: ServerToBrowserMessage): void
  isOpen(): boolean
}

interface PendingEntry {
  cleanup(): void
  resolve(result: unknown): void
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

  constructor(
    private readonly sender: BridgeSocketSender,
    private readonly timeoutMs: number = DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
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
   * Reject every in-flight action — used when the underlying socket closes.
   */
  rejectAll(reason: Error): void {
    for (const entry of [...this.pending.values()]) {
      entry.reject(reason)
    }
  }
}
