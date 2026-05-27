import { WebSocket, WebSocketServer } from 'ws'
import { runAgentTurn, type AgentEvent } from '../agent.ts'
import type { ProvidersBundle } from '../providers/index.ts'
import { SocketBrowserActionBridge } from './browser-action-bridge.ts'
import {
  BRIDGE_PROTOCOL_VERSION,
  decodeBridgeMessage,
  encodeBridgeMessage,
  type BrowserToServerMessage,
  type ServerToBrowserMessage,
} from './protocol.ts'

export interface BridgeServerOptions {
  port: number
  serverInfo: { name: string; version: string }
  providers: ProvidersBundle
  log?: (message: string, meta?: Record<string, unknown>) => void
}

interface ClientState {
  socket: WebSocket
  activeTurnAborts: Map<string, AbortController>
  bridge: SocketBrowserActionBridge
}

export function startBridgeServer(options: BridgeServerOptions): WebSocketServer {
  const log = options.log ?? ((m) => console.log(m))
  const wss = new WebSocketServer({ port: options.port, host: '127.0.0.1' })
  const clients = new Map<WebSocket, ClientState>()

  wss.on('listening', () => {
    log(`agent server ready on ws://127.0.0.1:${options.port}`)
  })

  wss.on('connection', (socket, request) => {
    const remote = request.socket.remoteAddress ?? 'unknown'
    log(`client connected from ${remote}`)
    const bridge = new SocketBrowserActionBridge({
      send: (msg) => sendToClient(socket, msg),
      isOpen: () => socket.readyState === WebSocket.OPEN,
    })
    const state: ClientState = { socket, activeTurnAborts: new Map(), bridge }
    clients.set(socket, state)

    sendToClient(socket, {
      type: 'ready',
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      serverInfo: options.serverInfo,
    })

    socket.on('message', (raw) => {
      const text = raw.toString('utf-8')
      let message: BrowserToServerMessage
      try {
        message = decodeBridgeMessage(text) as BrowserToServerMessage
      } catch (err) {
        log('failed to parse message', { error: String(err), raw: text })
        sendToClient(socket, { type: 'error', message: 'invalid JSON' })
        return
      }
      void handleClientMessage(state, message, options.providers, log)
    })

    socket.on('close', () => {
      log(`client disconnected from ${remote}`)
      for (const controller of state.activeTurnAborts.values()) controller.abort()
      state.activeTurnAborts.clear()
      state.bridge.rejectAll(new Error('client disconnected'))
      clients.delete(socket)
    })

    socket.on('error', (err) => {
      log('socket error', { error: err.message })
    })
  })

  wss.on('error', (err) => {
    log('server error', { error: err.message })
  })

  return wss
}

async function handleClientMessage(
  state: ClientState,
  message: BrowserToServerMessage,
  providers: ProvidersBundle,
  log: (m: string, meta?: Record<string, unknown>) => void,
): Promise<void> {
  switch (message.type) {
    case 'hello':
      log('client hello', { protocolVersion: message.protocolVersion })
      return

    case 'user-message': {
      const { turnId, text, timelineSummary } = message
      log('user-message received', { turnId, length: text.length })
      const abort = new AbortController()
      state.activeTurnAborts.set(turnId, abort)
      try {
        await runAgentTurn({
          turnId,
          userText: text,
          timelineSummary,
          abortSignal: abort.signal,
          bridge: state.bridge,
          providers,
          onMessage: (event) => {
            logAgentEvent(turnId, event, log)
            forwardAgentEvent(state.socket, turnId, event)
          },
        })
      } finally {
        state.activeTurnAborts.delete(turnId)
      }
      return
    }

    case 'cancel-turn': {
      const controller = state.activeTurnAborts.get(message.turnId)
      if (controller) {
        controller.abort()
        log('turn cancelled', { turnId: message.turnId })
      }
      return
    }

    case 'browser-action-result': {
      state.bridge.handleResult(message.requestId, message.result, message.error)
      return
    }

    case 'state-changed':
      // Reserved for later milestones (state sync).
      return
  }
}

function forwardAgentEvent(socket: WebSocket, turnId: string, event: AgentEvent): void {
  switch (event.kind) {
    case 'assistant-text':
      sendToClient(socket, { type: 'agent-message', turnId, text: event.text })
      return
    case 'tool-call':
      sendToClient(socket, {
        type: 'tool-call',
        turnId,
        callId: event.callId,
        toolName: event.toolName,
        args: event.args,
      })
      return
    case 'tool-result':
      sendToClient(socket, {
        type: 'tool-result',
        turnId,
        callId: event.callId,
        result: event.result,
        error: event.isError ? describeToolError(event.result) : undefined,
      })
      return
    case 'turn-end':
      sendToClient(socket, { type: 'turn-end', turnId })
      return
    case 'error':
      sendToClient(socket, { type: 'error', message: event.message, turnId })
      return
  }
}

/**
 * Stdout diagnostics for every agent event. Tool calls and tool results land
 * in `npm run dev:agent` output so post-mortems don't require digging through
 * the browser's chat-panel state. Args + results are JSON-stringified with
 * a length cap so long base64 payloads (e.g. audio bytes for transcription)
 * don't flood the log.
 */
function logAgentEvent(
  turnId: string,
  event: AgentEvent,
  log: (m: string, meta?: Record<string, unknown>) => void,
): void {
  const MAX_PAYLOAD_LEN = 600
  switch (event.kind) {
    case 'tool-call':
      log('tool-call', {
        turnId,
        toolName: event.toolName,
        args: truncateForLog(event.args, MAX_PAYLOAD_LEN),
      })
      return
    case 'tool-result':
      log('tool-result', {
        turnId,
        callId: event.callId,
        isError: event.isError,
        result: truncateForLog(event.result, MAX_PAYLOAD_LEN),
      })
      return
    case 'error':
      log('agent error', { turnId, message: event.message })
      return
    default:
      return
  }
}

function truncateForLog(value: unknown, maxLen: number): string {
  try {
    const json = JSON.stringify(value)
    if (json.length <= maxLen) return json
    return json.slice(0, maxLen - 1) + '…'
  } catch {
    return '[unserializable]'
  }
}

/**
 * Extract the human-readable error message from an MCP tool_result that came
 * back with `is_error: true`. The SDK wraps thrown errors as text content
 * blocks like `[{ type: 'text', text: 'unknown media: foo' }]`. Without
 * this, the chat would just see "tool reported error" and the agent would
 * have to guess what went wrong.
 */
function describeToolError(result: unknown): string {
  if (Array.isArray(result)) {
    for (const block of result) {
      if (block && typeof block === 'object' && 'text' in block) {
        const text = (block as { text?: unknown }).text
        if (typeof text === 'string' && text.length > 0) return text
      }
    }
  }
  if (typeof result === 'string' && result.length > 0) return result
  return 'tool reported error'
}

function sendToClient(socket: WebSocket, message: ServerToBrowserMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return
  socket.send(encodeBridgeMessage(message))
}
