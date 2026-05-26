import { config as loadDotenv } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { startBridgeServer } from './bridge/server.ts'
import { DEFAULT_BRIDGE_PORT } from './bridge/protocol.ts'
import { LocalWhisperBrowserProxy, OpenAIWhisperProvider } from './providers/transcription/index.ts'
import type { ProvidersBundle } from './providers/index.ts'

// Load .env from the monorepo root, not the workspace package cwd —
// `npm run dev --workspace=...` sets cwd to apps/agent-server/.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
loadDotenv({ path: resolve(REPO_ROOT, '.env') })

const PORT = Number(process.env.FREECUT_AGENT_PORT ?? DEFAULT_BRIDGE_PORT)

const log = (message: string, meta?: Record<string, unknown>) => {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : ''
  console.log(`[agent-server] ${message}${suffix}`)
}

function buildProviders(): ProvidersBundle {
  const openai = new OpenAIWhisperProvider({ apiKey: process.env.OPENAI_API_KEY })
  return {
    transcription: [new LocalWhisperBrowserProxy(), openai],
  }
}

const providers = buildProviders()
log('providers initialised', {
  transcription: providers.transcription.map((p) => ({ id: p.id, available: p.isAvailable() })),
})

const wss = startBridgeServer({
  port: PORT,
  serverInfo: { name: 'freecut-agent-server', version: '0.0.0' },
  providers,
  log,
})

const shutdown = (signal: NodeJS.Signals) => {
  log(`shutting down (${signal})`)
  wss.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
