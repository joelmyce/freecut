/**
 * HyperFrames local render (Phase 1 — rich motion graphics track).
 *
 * Drives the open-source HyperFrames CLI (`hyperframes render`) to turn an HTML
 * composition into a deterministic video, entirely on-device — no API, no cost.
 * The rendered bytes are returned base64-encoded so the tool can ship them over
 * the WS bridge for the browser to import as ordinary timeline media (mirrors
 * the generate_voiceover server-bytes→import path, with the M3 placeholder→swap
 * pattern on top).
 *
 * The renderer is injected into the tool (see `tools/add-kinetic-title.ts`) so
 * unit tests can run without spawning Chrome; the real spawn path is covered by
 * a module smoke test + live verification.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type HyperframesQuality = 'draft' | 'standard' | 'high'
export type HyperframesFormat = 'mp4' | 'webm' | 'mov'

export interface RenderCompositionOptions {
  /** Full composition HTML (a self-contained index.html with a paused GSAP timeline). */
  html: string
  /** Frame rate. Default 30. */
  fps?: number
  /** Render quality. Default 'standard'. */
  quality?: HyperframesQuality
  /** Output container. Default 'mp4' (opaque); 'webm'/'mov' carry alpha for overlays. */
  format?: HyperframesFormat
  /** Parallel Chrome workers (~256 MB each). Default 1 to stay memory-safe. */
  workers?: number
  /** Hard timeout for the render. Default 180s. */
  timeoutMs?: number
  /** Abort the render (kills the child process). */
  signal?: AbortSignal
}

export interface RenderCompositionResult {
  /** Base64-encoded rendered video bytes. */
  bytesBase64: string
  mimeType: string
  format: HyperframesFormat
}

const MIME_BY_FORMAT: Record<HyperframesFormat, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
}

/** Minimal project config (mirrors `hyperframes init`). */
const MINIMAL_CONFIG = JSON.stringify({
  $schema: 'https://hyperframes.heygen.com/schema/hyperframes.json',
  paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' },
})

/** Resolve the installed HyperFrames CLI entry (`dist/cli.js`). */
function resolveHyperframesCli(): string {
  const require = createRequire(import.meta.url)
  const pkgJson = require.resolve('hyperframes/package.json')
  return join(pkgJson, '..', 'dist', 'cli.js')
}

/**
 * Render an HTML composition to a video and return its bytes base64-encoded.
 * Writes a throwaway project dir, spawns the HyperFrames CLI, reads the output,
 * and always cleans up.
 */
export async function renderHyperframesComposition(
  options: RenderCompositionOptions,
): Promise<RenderCompositionResult> {
  const fps = options.fps ?? 30
  const quality = options.quality ?? 'standard'
  const format = options.format ?? 'mp4'
  const workers = options.workers ?? 1
  const timeoutMs = options.timeoutMs ?? 180_000

  options.signal?.throwIfAborted()

  const dir = await mkdtemp(join(tmpdir(), 'freecut-hf-'))
  const outPath = join(dir, `out.${format}`)
  try {
    await writeFile(join(dir, 'index.html'), options.html, 'utf8')
    await writeFile(join(dir, 'hyperframes.json'), MINIMAL_CONFIG, 'utf8')

    const cli = resolveHyperframesCli()
    await runCli(
      [
        cli,
        'render',
        dir,
        '-o',
        outPath,
        '-f',
        String(fps),
        '--quality',
        quality,
        '--format',
        format,
        '--workers',
        String(workers),
        '--quiet',
      ],
      { timeoutMs, signal: options.signal },
    )

    const bytes = await readFile(outPath)
    return { bytesBase64: bytes.toString('base64'), mimeType: MIME_BY_FORMAT[format], format }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function runCli(args: string[], opts: { timeoutMs: number; signal?: AbortSignal }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''

    const cleanup = () => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      child.kill('SIGKILL')
      cleanup()
      reject(new Error('hyperframes render aborted'))
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      cleanup()
      reject(new Error(`hyperframes render timed out after ${opts.timeoutMs}ms`))
    }, opts.timeoutMs)

    if (opts.signal) {
      if (opts.signal.aborted) return onAbort()
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stderr?.on('data', (d) => {
      stderr += String(d)
    })
    child.on('error', (err) => {
      cleanup()
      reject(err)
    })
    child.on('exit', (code) => {
      cleanup()
      if (code === 0) resolve()
      else reject(new Error(`hyperframes render exited with code ${code}: ${stderr.slice(-800)}`))
    })
  })
}
