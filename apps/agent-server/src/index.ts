import { config as loadDotenv } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { startBridgeServer } from './bridge/server.ts'
import { DEFAULT_BRIDGE_PORT } from './bridge/protocol.ts'
import {
  GeminiTranscriptReasoningProvider,
  GeminiVideoAnalysisProvider,
} from './providers/analysis/index.ts'
import { GiphyGifProvider } from './providers/gif/index.ts'
import { FalImageProvider } from './providers/image/index.ts'
import {
  GeminiTranscriptionProvider,
  LocalWhisperBrowserProxy,
  OpenAIWhisperProvider,
} from './providers/transcription/index.ts'
import { ElevenLabsTtsProvider, KokoroBrowserProxyTtsProvider } from './providers/tts/index.ts'
import { FalVideoProvider } from './providers/video/index.ts'
import type { ProvidersBundle } from './providers/index.ts'

// Load .env from the monorepo root, not the workspace package cwd —
// `npm run dev --workspace=...` sets cwd to apps/agent-server/.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
loadDotenv({ path: resolve(REPO_ROOT, '.env') })

const PORT = Number(process.env.FREECUT_AGENT_PORT ?? DEFAULT_BRIDGE_PORT)

const log = (message: string, meta?: Record<string, unknown>) => {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : ''
  // CLI bootstrap output — written to stdout via process.stdout.write
  // because the project lints away raw `console.log` calls.
  process.stdout.write(`[agent-server] ${message}${suffix}\n`)
}

function buildProviders(): ProvidersBundle {
  const openai = new OpenAIWhisperProvider({ apiKey: process.env.OPENAI_API_KEY })
  const gemini = new GeminiTranscriptionProvider({ apiKey: process.env.GEMINI_API_KEY })
  const geminiVideo = new GeminiVideoAnalysisProvider({ apiKey: process.env.GEMINI_API_KEY })
  const geminiTranscript = new GeminiTranscriptReasoningProvider({
    apiKey: process.env.GEMINI_API_KEY,
  })
  const fal = new FalVideoProvider({ apiKey: process.env.FAL_API_KEY })
  const falImage = new FalImageProvider({ apiKey: process.env.FAL_API_KEY })
  const giphy = new GiphyGifProvider({ apiKey: process.env.GIPHY_API_KEY })
  const elevenlabs = new ElevenLabsTtsProvider({ apiKey: process.env.ELEVENLABS_API_KEY })
  return {
    transcription: [new LocalWhisperBrowserProxy(), openai, gemini],
    videoGeneration: [fal],
    analysis: [geminiVideo],
    imageGeneration: [falImage],
    gifSearch: [giphy],
    tts: [new KokoroBrowserProxyTtsProvider(), elevenlabs],
    transcriptReasoning: [geminiTranscript],
  }
}

const providers = buildProviders()
log('providers initialised', {
  transcription: providers.transcription.map((p) => ({ id: p.id, available: p.isAvailable() })),
  videoGeneration: providers.videoGeneration.map((p) => ({ id: p.id, available: p.isAvailable() })),
  analysis: providers.analysis.map((p) => ({ id: p.id, available: p.isAvailable() })),
  imageGeneration: providers.imageGeneration.map((p) => ({
    id: p.id,
    available: p.isAvailable(),
  })),
  gifSearch: providers.gifSearch.map((p) => ({ id: p.id, available: p.isAvailable() })),
  tts: providers.tts.map((p) => ({ id: p.id, available: p.isAvailable() })),
  transcriptReasoning: (providers.transcriptReasoning ?? []).map((p) => ({
    id: p.id,
    available: p.isAvailable(),
  })),
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
