import { config as loadDotenv } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { startBridgeServer } from './bridge/server.ts'
import { DEFAULT_BRIDGE_PORT } from './bridge/protocol.ts'

// Load .env from the monorepo root, not the workspace package cwd —
// `npm run dev --workspace=...` sets cwd to apps/agent-server/.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
loadDotenv({ path: resolve(REPO_ROOT, '.env') })

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
