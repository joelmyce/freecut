import { config as loadDotenv } from 'dotenv'
import { startBridgeServer } from './bridge/server.ts'
import { DEFAULT_BRIDGE_PORT } from './bridge/protocol.ts'

loadDotenv()

const PORT = Number(process.env.FREECUT_AGENT_PORT ?? DEFAULT_BRIDGE_PORT)

const log = (message: string, meta?: Record<string, unknown>) => {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : ''
  console.log(`[agent-server] ${message}${suffix}`)
}

const wss = startBridgeServer({
  port: PORT,
  serverInfo: { name: 'freecut-agent-server', version: '0.0.0' },
  log,
})

const shutdown = (signal: NodeJS.Signals) => {
  log(`shutting down (${signal})`)
  wss.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
