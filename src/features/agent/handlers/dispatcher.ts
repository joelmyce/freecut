import { createLogger } from '@/shared/logging/logger'
import type { AgentBridgeClient } from '../bridge/client'
import type { BrowserActionRegistry } from './registry'

const log = createLogger('agent-handler-dispatch')

/**
 * Subscribes to the bridge client and routes `invoke-browser-action` messages
 * through the registry. Replies with `browser-action-result` keyed by the
 * same `requestId`. Honors `cancel-browser-action` by aborting the matching
 * in-flight handler.
 */
export function attachBrowserActionDispatcher(
  client: AgentBridgeClient,
  registry: BrowserActionRegistry,
): () => void {
  const inflight = new Map<string, AbortController>()

  const unsubscribe = client.subscribe((message) => {
    if (message.type === 'invoke-browser-action') {
      const { requestId, action, args } = message
      const controller = new AbortController()
      inflight.set(requestId, controller)
      void registry
        .dispatch(action, args, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return
          client.send({ type: 'browser-action-result', requestId, result })
        })
        .catch((err) => {
          if (controller.signal.aborted) return
          const error = err instanceof Error ? err.message : String(err)
          log.warn(`browser action failed: ${action}`, err)
          client.send({ type: 'browser-action-result', requestId, error })
        })
        .finally(() => {
          inflight.delete(requestId)
        })
      return
    }
    if (message.type === 'cancel-browser-action') {
      const controller = inflight.get(message.requestId)
      if (controller) {
        controller.abort()
        log.debug(`cancelled browser action ${message.requestId}`)
      }
      return
    }
  })

  return () => {
    for (const controller of inflight.values()) controller.abort()
    inflight.clear()
    unsubscribe()
  }
}
