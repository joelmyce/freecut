import type { ProviderContext } from '../types.ts'
import type {
  ImageAspectRatio,
  ImageGenerationInput,
  ImageGenerationProvider,
  ImageGenerationResult,
  ImageResolutionTier,
} from './types.ts'

const FAL_QUEUE_BASE = 'https://queue.fal.run'

/**
 * GPT Image 2 — OpenAI's image model hosted on fal. Picked for M4.7
 * because gpt-image-2 renders legible on-screen text accurately, exactly
 * the case text-to-video (Kling) hallucinates faux-glyphs for. See
 * PHASE-1-PLAN.md §6.9 + AI-EDITOR-VISION.md §7.
 *
 * **fal URL namespace gotcha.** fal hosts two flavors of model paths on
 * `queue.fal.run`:
 *   - `fal-ai/<model>` for fal-native models (kling, recraft, flux,
 *     ideogram, etc.) — what `FalVideoProvider` uses.
 *   - `<vendor>/<model>` for vendor-namespaced wrappers (openai/...,
 *     etc.) — what this provider uses.
 *
 * Submitting to `fal-ai/openai/gpt-image-2` 404s with
 * "Application 'openai' not found"; the correct submission path is
 * `https://queue.fal.run/openai/gpt-image-2`. Verified against
 * https://fal.ai/models/openai/gpt-image-2/api on 2026-05-27.
 *
 * Schema is fal's standard "image" envelope:
 *   - body: `{ prompt, image_size, quality?, num_images?, output_format? }`
 *   - response: `{ images: [{ url, width, height, content_type, file_name }, ...] }`
 */
const DEFAULT_MODEL = 'openai/gpt-image-2'

const POLL_INTERVAL_MS = 1500
/**
 * Upper bound on a single image generation. Most fal image models finish in
 * 5-15s, but `openai/gpt-image-2` regularly takes 110-130s for "high" quality
 * (verified against fal's dashboard on 2026-05-27 — a 129.5s job timed out
 * under the previous 120s ceiling even though the image rendered fine on
 * their side). 5 min gives generous headroom for the slowest case without
 * blocking forever if a job actually wedges.
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
}

interface FalImageOutput {
  images?: ReadonlyArray<{
    url?: string
    width?: number
    height?: number
    content_type?: string
  }>
  // Some fal image models return a single `image` field, others `images[]`.
  image?: { url?: string; width?: number; height?: number; content_type?: string }
}

export interface FalImageProviderOptions {
  apiKey: string | undefined
  /** Override the default fal image model. */
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
 * fal.ai image generation provider. Same queue-based submit/poll/result
 * pattern as `FalVideoProvider`. Cheaper + faster (typically 5-10s per
 * gen vs 30-90s for video).
 */
export class FalImageProvider implements ImageGenerationProvider {
  readonly id = 'fal-image' as const
  private readonly apiKey: string | undefined
  private readonly defaultModel: string
  private readonly fetchImpl: typeof fetch
  private readonly queueBaseUrl: string
  private readonly pollIntervalMs: number
  private readonly maxWaitMs: number
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>

  constructor(options: FalImageProviderOptions) {
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
    input: ImageGenerationInput,
    ctx: ProviderContext,
  ): Promise<ImageGenerationResult> {
    if (!this.apiKey) {
      throw new Error('fal image provider requires FAL_API_KEY')
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
      this.requestCancel(cancelUrl).catch(() => {})
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })

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
          throw new Error(`fal image job ${status.status.toLowerCase()}`)
        }
        if (Date.now() - started > this.maxWaitMs) {
          throw new Error(`fal image job timed out after ${Math.round(this.maxWaitMs / 1000)}s`)
        }
      }

      ctx.onProgress?.({ stage: 'fetching-result' })
      const result = await this.fetchResult(responseUrl, ctx.signal)
      const image = result.images?.[0] ?? result.image
      const sourceUrl = image?.url
      if (!sourceUrl) {
        throw new Error('fal image job completed but no image URL in response')
      }
      return {
        sourceUrl,
        modelUsed: model,
        width: image?.width,
        height: image?.height,
        mimeType: image?.content_type ?? 'image/png',
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
    input: ImageGenerationInput,
    signal: AbortSignal,
  ): Promise<QueueSubmitResponse> {
    const body = buildRequestBody(input)
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
      throw new Error(`fal image submit failed: ${res.status} ${res.statusText}${suffix}`)
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
        `fal image status check failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
      )
    }
    return (await res.json()) as QueueStatusResponse
  }

  private async fetchResult(responseUrl: string, signal: AbortSignal): Promise<FalImageOutput> {
    const res = await this.fetchImpl(responseUrl, {
      method: 'GET',
      headers: { Authorization: `Key ${this.apiKey}` },
      signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(
        `fal image result fetch failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
      )
    }
    return (await res.json()) as FalImageOutput
  }

  private async requestCancel(cancelUrl: string): Promise<void> {
    if (!this.apiKey) return
    await this.fetchImpl(cancelUrl, {
      method: 'PUT',
      headers: { Authorization: `Key ${this.apiKey}` },
    })
  }
}

/**
 * fal's `image_size` field accepts either a named preset OR a literal
 * `{width, height}` object with multiples of 16, max 3840px edge. The
 * named presets cap at 1024px on the short edge for landscape variants,
 * which upscale-blurs on 1080p+ timelines — so we send explicit
 * `{width, height}` dimensions for the `high` and `max` resolution
 * tiers and reserve the preset names for the `standard` (fast/cheap)
 * tier.
 */
function buildRequestBody(input: ImageGenerationInput): Record<string, unknown> {
  const tier = input.resolution ?? 'max'
  return {
    prompt: input.prompt,
    image_size: resolveImageSize(input.aspect, tier),
  }
}

function resolveImageSize(
  aspect: ImageAspectRatio,
  tier: ImageResolutionTier,
): string | { width: number; height: number } {
  if (tier === 'standard') {
    // Fall back to fal's preset names — fastest/cheapest tier, lowest
    // resolution. Use these when render speed > pixel fidelity.
    return aspectToFalImageSize(aspect)
  }
  return aspectToCustomSize(aspect, tier)
}

function aspectToFalImageSize(aspect: ImageAspectRatio): string {
  switch (aspect) {
    case '16:9':
      return 'landscape_16_9'
    case '9:16':
      return 'portrait_16_9'
    case '4:3':
      return 'landscape_4_3'
    case '3:4':
      return 'portrait_4_3'
    case '1:1':
    default:
      return 'square_hd'
  }
}

/**
 * Custom dimensions for the `high` (~1080p) and `max` (~1440p / 2K) tiers.
 * All values are multiples of 16 (fal's requirement) and within the
 * 3840px max-edge cap. Aspect ratios are preserved exactly:
 *   - 16:9   → 1920×1088 (high) / 2560×1440 (max)
 *   - 9:16   → 1088×1920 / 1440×2560
 *   - 4:3    → 1600×1200 / 1920×1440
 *   - 3:4    → 1200×1600 / 1440×1920
 *   - 1:1    → 1536×1536 / 2048×2048
 */
function aspectToCustomSize(
  aspect: ImageAspectRatio,
  tier: 'high' | 'max',
): { width: number; height: number } {
  const high = tier === 'high'
  switch (aspect) {
    case '16:9':
      return high ? { width: 1920, height: 1088 } : { width: 2560, height: 1440 }
    case '9:16':
      return high ? { width: 1088, height: 1920 } : { width: 1440, height: 2560 }
    case '4:3':
      return high ? { width: 1600, height: 1200 } : { width: 1920, height: 1440 }
    case '3:4':
      return high ? { width: 1200, height: 1600 } : { width: 1440, height: 1920 }
    case '1:1':
    default:
      return high ? { width: 1536, height: 1536 } : { width: 2048, height: 2048 }
  }
}

async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    if (signal.aborted) {
      clearTimeout(timer)
      reject(new Error('aborted'))
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
