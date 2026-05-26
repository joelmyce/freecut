import { createLogger } from '@/shared/logging/logger'
import {
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_BRIDGE_PORT,
  decodeBridgeMessage,
  encodeBridgeMessage,
  type BrowserToServerMessage,
  type ServerToBrowserMessage,
} from './protocol'

const log = createLogger('agent-bridge')

const INITIAL_RETRY_MS = 500
const MAX_RETRY_MS = 10_000

export type AgentBridgeListener = (message: ServerToBrowserMessage) => void

export interface AgentBridgeClient {
  send(message: BrowserToServerMessage): boolean
  subscribe(listener: AgentBridgeListener): () => void
  close(): void
  isConnected(): boolean
}

export interface CreateAgentBridgeOptions {
  url?: string
  /** Disable auto-reconnect on close — primarily for tests. */
  autoReconnect?: boolean
}

export function createAgentBridgeClient(options: CreateAgentBridgeOptions = {}): AgentBridgeClient {
  const url = options.url ?? `ws://localhost:${DEFAULT_BRIDGE_PORT}`
  const autoReconnect = options.autoReconnect ?? true

  const listeners = new Set<AgentBridgeListener>()
  let socket: WebSocket | null = null
  let retryMs = INITIAL_RETRY_MS
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let closedByCaller = false

  function connect(): void {
    if (closedByCaller) return
    log.debug(`connecting to ${url}`)
    const ws = new WebSocket(url)
    socket = ws

    ws.addEventListener('open', () => {
      log.info('[agent] connected')
      retryMs = INITIAL_RETRY_MS
      ws.send(encodeBridgeMessage({ type: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION }))
    })

    ws.addEventListener('message', (event) => {
      const data = typeof event.data === 'string' ? event.data : null
      if (data === null) return
      let message: ServerToBrowserMessage
      try {
        message = decodeBridgeMessage(data) as ServerToBrowserMessage
      } catch (err) {
        log.warn('failed to parse bridge message', err)
        return
      }
      for (const listener of listeners) {
        try {
          listener(message)
        } catch (err) {
          log.error('listener threw', err)
        }
      }
    })

    ws.addEventListener('close', () => {
      log.debug('[agent] disconnected')
      socket = null
      if (closedByCaller || !autoReconnect) return
      scheduleReconnect()
    })

    ws.addEventListener('error', () => {
      // The 'close' handler will fire next and trigger reconnect. Logging at
      // debug level because the dev-mode auto-connect fires before the server
      // is up and we don't want to spam errors on every page load.
      log.debug('[agent] socket error')
    })
  }

  function scheduleReconnect(): void {
    if (reconnectTimer !== null) return
    const delay = retryMs
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  connect()

  return {
    send(message) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false
      socket.send(encodeBridgeMessage(message))
      return true
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    close() {
      closedByCaller = true
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (socket) {
        socket.close()
        socket = null
      }
      listeners.clear()
    },
    isConnected() {
      return socket?.readyState === WebSocket.OPEN
    },
  }
}

let sharedClient: AgentBridgeClient | null = null

/**
 * Lazily create and return the process-wide bridge client. The first call
 * starts the connection; subsequent calls return the same instance.
 */
export function getAgentBridgeClient(): AgentBridgeClient {
  if (sharedClient === null) {
    sharedClient = createAgentBridgeClient()
  }
  return sharedClient
}
