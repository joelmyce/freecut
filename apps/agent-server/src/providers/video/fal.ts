import type { ProviderContext } from '../types.ts'
import type {
  VideoGenerationInput,
  VideoGenerationProvider,
  VideoGenerationResult,
} from './types.ts'

const FAL_QUEUE_BASE = 'https://queue.fal.run'

/**
 * Kling 1.5 Standard text-to-video. Picked as the default — fast, cheap,
 * and stable. Schema differs from later Kling versions:
 *   - v1 / v1.5 / v2.x family: `{prompt, aspect_ratio, duration: "5" | "10"}`
 *   - v3 family: `{prompt, aspect_ratio, duration: "3"-"15", generate_audio}`
 * The body builder branches on the model id so users can still override
 * to a Kling 3.x model via the tool's `model` arg without sending a
 * malformed payload (older models reject `duration: "6"`).
 */
const DEFAULT_MODEL = 'fal-ai/kling-video/v1.5/standard/text-to-video'

/** Snap point between the two legacy Kling duration buckets. Anything above this
 * rounds up to "10", anything at-or-below rounds down to "5". 7.5s is the
 * midpoint between the two enum values, so it's the fair tie-breaker. */
const KLING_LEGACY_DURATION_SNAP_SEC = 7.5
const KLING_V3_MIN_DURATION_SEC = 3
const KLING_V3_MAX_DURATION_SEC = 15

/**
 * Poll interval for the fal queue status endpoint. Fal's docs recommend
 * 1-2s for video generation jobs; 1.5s gives a smooth progress feel without
 * hammering their API. The first poll fires after this delay (we don't
 * pre-poll because submission itself takes a few hundred ms).
 */
const POLL_INTERVAL_MS = 1500

/**
 * Hard upper bound on a single video generation. fal jobs occasionally
 * stick in IN_QUEUE if the model is at capacity — we'd rather error out
 * cleanly than wait forever. Five minutes is comfortably more than the
 * 30-90s a typical Luma/Kling job takes.
 */
const MAX_WAIT_MS = 5 * 60 * 1000

interface QueueSubmitResponse {
  request_id: string
  response_url?: string
  status_url?: string
  cancel_url?: string
}

interface QueueStatusResponse {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELED'
  queue_position?: number
  response_url?: string
  logs?: ReadonlyArray<{ message?: string; timestamp?: string; level?: string }>
}

interface FalVideoOutput {
  video?: { url?: string; content_type?: string; file_size?: number } | string
  output?: { url?: string } | string
  url?: string
  videos?: ReadonlyArray<{ url?: string }>
  duration?: number
  duration_seconds?: number
}

export interface FalVideoProviderOptions {
  apiKey: string | undefined
  /** Override the default fal model. */
  defaultModel?: string
  fetchImpl?: typeof fetch
  /** Override the queue base URL — used by tests with a mock server. */
  queueBaseUrl?: string
  /** Override poll interval — used by tests to avoid real timers. */
  pollIntervalMs?: number
  /** Override max wait — used by tests to fail fast. */
  maxWaitMs?: number
  /** Optional sleep — defaults to setTimeout-based; tests pass a synchronous stub. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * fal.ai video generation provider. Submits a job to fal's queue API,
 * polls status, and returns the rendered video URL. Cancellation:
 *   - Pre-submit: the request can be aborted via the fetch's signal.
 *   - Post-submit: we issue a best-effort POST to the cancel_url; this
 *     stops billing only if the job hasn't started yet (fal docs).
 * Progress: we emit `submitting` once, then `queued` / `running` with the
 * queue position when fal reports it.
 */
export class FalVideoProvider implements VideoGenerationProvider {
  readonly id = 'fal' as const
  private readonly apiKey: string | undefined
  private readonly defaultModel: string
  private readonly fetchImpl: typeof fetch
  private readonly queueBaseUrl: string
  private readonly pollIntervalMs: number
  private readonly maxWaitMs: number
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>

  constructor(options: FalVideoProviderOptions) {
    const trimmed = options.apiKey?.trim()
    this.apiKey = trimmed && trimmed.length > 0 ? trimmed : undefined
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL
    this.fetchImpl = options.fetchImpl ?? fetch
    this.queueBaseUrl = options.queueBaseUrl ?? FAL_QUEUE_BASE
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
    this.maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS
    this.sleep = options.sleep ?? defaultSleep
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey)
  }

  async generate(
    input: VideoGenerationInput,
    ctx: ProviderContext,
  ): Promise<VideoGenerationResult> {
    if (!this.apiKey) {
      throw new Error('fal video provider requires FAL_API_KEY')
    }
    const model = input.model ?? this.defaultModel

    ctx.onProgress?.({ stage: 'submitting' })
    const submission = await this.submit(model, input, ctx.signal)

    const statusUrl =
      submission.status_url ??
      `${this.queueBaseUrl}/${model}/requests/${submission.request_id}/status`
    const responseUrl =
      submission.response_url ?? `${this.queueBaseUrl}/${model}/requests/${submission.request_id}`
    const cancelUrl =
      submission.cancel_url ??
      `${this.queueBaseUrl}/${model}/requests/${submission.request_id}/cancel`

    let cancelled = false
    const onAbort = () => {
      cancelled = true
      this.requestCancel(cancelUrl).catch(() => {
        // Best-effort cancel — fal returns 4xx if the job already finished.
      })
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })

    // Errors from a cancellation race need to surface as the canonical
    // AbortError (not whatever fal happened to throw when the request was
    // mid-flight). We translate in the catch so the finally can stay
    // side-effect-only — throwing from finally trips eslint's
    // no-unsafe-finally and silently overrides the original error chain.
    try {
      const started = Date.now()
      while (true) {
        ctx.signal.throwIfAborted()
        await this.sleep(this.pollIntervalMs, ctx.signal)
        const status = await this.checkStatus(statusUrl, ctx.signal)
        if (status.status === 'IN_QUEUE') {
          ctx.onProgress?.({
            stage: 'queued',
            detail: status.queue_position != null ? `position ${status.queue_position}` : undefined,
          })
        } else if (status.status === 'IN_PROGRESS') {
          ctx.onProgress?.({ stage: 'running' })
        } else if (status.status === 'COMPLETED') {
          break
        } else if (status.status === 'FAILED' || status.status === 'CANCELED') {
          throw new Error(`fal job ${status.status.toLowerCase()}`)
        }
        if (Date.now() - started > this.maxWaitMs) {
          throw new Error(`fal job timed out after ${Math.round(this.maxWaitMs / 1000)}s`)
        }
      }

      ctx.onProgress?.({ stage: 'fetching-result' })
      const result = await this.fetchResult(responseUrl, ctx.signal)
      const sourceUrl = extractVideoUrl(result)
      if (!sourceUrl) {
        throw new Error('fal job completed but no video URL in response')
      }
      const durationSec =
        typeof result.duration === 'number'
          ? result.duration
          : typeof result.duration_seconds === 'number'
            ? result.duration_seconds
            : input.targetDurationSec
      return {
        sourceUrl,
        modelUsed: model,
        durationSec,
        mimeType: 'video/mp4',
      }
    } catch (err) {
      if (cancelled) {
        const abortErr = new Error('aborted')
        abortErr.name = 'AbortError'
        throw abortErr
      }
      throw err
    } finally {
      ctx.signal.removeEventListener('abort', onAbort)
    }
  }

  private async submit(
    model: string,
    input: VideoGenerationInput,
    signal: AbortSignal,
  ): Promise<QueueSubmitResponse> {
    const body = buildRequestBody(model, input)
    const res = await this.fetchImpl(`${this.queueBaseUrl}/${model}`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const suffix = detail ? ` — ${detail.slice(0, 500)}` : ''
      throw new Error(`fal submit failed: ${res.status} ${res.statusText}${suffix}`)
    }
    return (await res.json()) as QueueSubmitResponse
  }

  private async checkStatus(statusUrl: string, signal: AbortSignal): Promise<QueueStatusResponse> {
    const res = await this.fetchImpl(statusUrl, {
      method: 'GET',
      headers: { Authorization: `Key ${this.apiKey}` },
      signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(
        `fal status check failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
      )
    }
    return (await res.json()) as QueueStatusResponse
  }

  private async fetchResult(responseUrl: string, signal: AbortSignal): Promise<FalVideoOutput> {
    const res = await this.fetchImpl(responseUrl, {
      method: 'GET',
      headers: { Authorization: `Key ${this.apiKey}` },
      signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(
        `fal result fetch failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
      )
    }
    return (await res.json()) as FalVideoOutput
  }

  private async requestCancel(cancelUrl: string): Promise<void> {
    if (!this.apiKey) return
    await this.fetchImpl(cancelUrl, {
      method: 'PUT',
      headers: { Authorization: `Key ${this.apiKey}` },
    })
  }
}

function isKlingV3(model: string): boolean {
  return /\/kling-video\/v3\b/.test(model)
}

function buildRequestBody(model: string, input: VideoGenerationInput): Record<string, unknown> {
  if (isKlingV3(model)) {
    const rounded = Math.round(input.targetDurationSec)
    const clamped = Math.max(
      KLING_V3_MIN_DURATION_SEC,
      Math.min(KLING_V3_MAX_DURATION_SEC, rounded),
    )
    return {
      prompt: input.prompt,
      aspect_ratio: input.aspect,
      duration: String(Number.isFinite(clamped) ? clamped : 5),
      // B-roll is silent footage by default; audio gen is a separate workflow
      // (M5 `generate_voiceover`). Turning it off keeps the per-clip cost lower.
      generate_audio: false,
    }
  }
  // Legacy Kling family (v1 / v1.5 / v2.x): duration enum is "5" or "10".
  // Snap to the nearest, with the midpoint rounding up so a 6-7s request
  // doesn't get clipped down to 5s when 10s is closer.
  const duration = input.targetDurationSec > KLING_LEGACY_DURATION_SNAP_SEC ? '10' : '5'
  return {
    prompt: input.prompt,
    aspect_ratio: input.aspect,
    duration,
  }
}

function extractVideoUrl(output: FalVideoOutput): string | undefined {
  if (typeof output.video === 'string') return output.video
  if (output.video && typeof output.video === 'object' && output.video.url) return output.video.url
  if (typeof output.output === 'string') return output.output
  if (output.output && typeof output.output === 'object' && output.output.url)
    return output.output.url
  if (output.url) return output.url
  if (output.videos && output.videos.length > 0 && output.videos[0]?.url)
    return output.videos[0].url
  return undefined
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
