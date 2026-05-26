import { getAgentBridgeClient } from './bridge/client'
import { createAgentDebugApi, type AgentDebugApi } from './debug'
import { createDefaultBrowserActionRegistry } from './handlers'
import { attachBrowserActionDispatcher } from './handlers/dispatcher'

export {
  createAgentBridgeClient,
  getAgentBridgeClient,
  type AgentBridgeClient,
  type AgentBridgeListener,
} from './bridge/client'
export {
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_BRIDGE_PORT,
  type BrowserToServerMessage,
  type ServerToBrowserMessage,
} from './bridge/protocol'
export {
  BrowserActionRegistry,
  createDefaultBrowserActionRegistry,
  type BrowserActionHandler,
} from './handlers'
export { attachBrowserActionDispatcher } from './handlers/dispatcher'
export { captureTimelineAgentSnapshot } from './timeline-snapshot'
export { createAgentDebugApi, type AgentDebugApi } from './debug'

let initialized = false

/**
 * Wires the agent bridge for dev mode: opens the WebSocket to the
 * agent-server, registers the browser-action handler set (transcribe, etc),
 * and exposes `window.__DEBUG__.agent` for console-driven testing.
 *
 * Safe to call multiple times; subsequent calls no-op. Called from main.tsx
 * inside an `import.meta.env.DEV` guard.
 */
export function initializeAgent(): void {
  if (initialized) return
  initialized = true
  const client = getAgentBridgeClient()
  const registry = createDefaultBrowserActionRegistry()
  attachBrowserActionDispatcher(client, registry)
  attachDebugApi(createAgentDebugApi(client))
}

function attachDebugApi(api: AgentDebugApi): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as { __DEBUG__?: Record<string, unknown> }
  if (!w.__DEBUG__) w.__DEBUG__ = {}
  ;(w.__DEBUG__ as Record<string, unknown>).agent = api
}
