import { WebSocket } from 'ws'
import {
  DEFAULT_BRIDGE_PORT,
  decodeBridgeMessage,
  encodeBridgeMessage,
  type ServerToBrowserMessage,
} from '../bridge/protocol.ts'

const port = Number(process.env.FREECUT_AGENT_PORT ?? DEFAULT_BRIDGE_PORT)
const url = `ws://127.0.0.1:${port}`
const userText = process.argv[2] ?? 'Please call the echo tool with the message "hello from M0".'
const turnId = `m0-${Date.now()}`

console.log(`[say-hi] connecting to ${url}`)
const socket = new WebSocket(url)

const turnTimeout = setTimeout(() => {
  console.error('[say-hi] turn timed out after 90s — aborting')
  socket.close()
  process.exit(2)
}, 90_000)
turnTimeout.unref()

socket.on('open', () => {
  console.log('[say-hi] connected — sending user-message')
  socket.send(
    encodeBridgeMessage({
      type: 'user-message',
      turnId,
      text: userText,
    }),
  )
})

socket.on('message', (raw) => {
  const text = raw.toString('utf-8')
  let message: ServerToBrowserMessage
  try {
    message = decodeBridgeMessage(text) as ServerToBrowserMessage
  } catch (err) {
    console.error('[say-hi] failed to parse server message', err)
    return
  }

  switch (message.type) {
    case 'ready':
      console.log(
        `[say-hi] server ready: ${message.serverInfo.name}@${message.serverInfo.version} (protocol v${message.protocolVersion})`,
      )
      return
    case 'agent-message':
      console.log(`[say-hi] agent: ${message.text}`)
      return
    case 'tool-call':
      console.log(`[say-hi] tool-call: ${message.toolName} ${JSON.stringify(message.args)}`)
      return
    case 'tool-result':
      console.log(`[say-hi] tool-result (${message.callId}): ${JSON.stringify(message.result)}`)
      return
    case 'tool-progress':
      console.log(
        `[say-hi] tool-progress: ${message.stage}${message.fraction !== undefined ? ` (${Math.round(message.fraction * 100)}%)` : ''}`,
      )
      return
    case 'turn-end':
      console.log('[say-hi] turn-end — closing')
      clearTimeout(turnTimeout)
      socket.close()
      return
    case 'error':
      console.error(`[say-hi] error: ${message.message}`)
      return
    case 'invoke-browser-action':
    case 'mutate-timeline':
      console.warn(`[say-hi] received ${message.type} — not expected in M0`)
      return
  }
})

socket.on('close', () => {
  console.log('[say-hi] socket closed')
  process.exit(0)
})

socket.on('error', (err) => {
  console.error('[say-hi] socket error:', err.message)
  process.exit(1)
})
