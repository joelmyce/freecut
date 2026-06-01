import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import { estimateVideoGenerationCost } from '../providers/video/cost.ts'
import { pickVideoGenerationProvider } from '../providers/video/router.ts'
import type { VideoAspectRatio, VideoGenerationStrategy } from '../providers/video/types.ts'
import { buildTranscriptContextBlock } from './prompt-grounding.ts'

/**
 * Model id used ONLY for the M5.2 cost estimate + card display. The provider
 * picks its own default model when the caller omits `model`.
 */
const DEFAULT_BROLL_MODEL = 'fal-ai/kling-video/v3/standard/text-to-video'

export interface CreateGenerateBrollToolOptions {
  bridge: BrowserActionBridge
  providers: ProvidersBundle
  abortSignal: AbortSignal
}

interface InsertPlaceholderResult {
  placeholderId: string
  trackId: string
  from: number
  durationInFrames: number
}

interface SwapPlaceholderResult {
  clipId: string
  mediaId: string
  trackId: string
  from: number
  durationInFrames: number
}

interface TranscriptContextResult {
  text: string | null
  sourceMediaIds: string[]
  startSeconds: number
  endSeconds: number
}

const inputSchema = {
  prompt: z
    .string()
    .min(1)
    .describe(
      'Plain-English description of the b-roll shot to generate. Models work best with concrete subject + setting + mood, e.g. "neon-lit city skyline at night, slow drone push-in, cinematic".',
    ),
  start_seconds: z
    .number()
    .min(0)
    .describe('Start of the placeholder on the project timeline, in seconds from project zero.'),
  end_seconds: z
    .number()
    .describe(
      'End of the placeholder on the project timeline, in seconds. Must exceed start_seconds.',
    ),
  provider: z
    .enum(['auto', 'fal', 'kie'])
    .optional()
    .describe('Which provider to use. "auto" (default) picks the first available — currently fal.'),
  model: z
    .string()
    .optional()
    .describe(
      'Provider-specific model id. fal default is "fal-ai/kling-video/v3/standard/text-to-video" (Kling 3 Standard — the current GA tier). Override when the user names a specific model — e.g. "fal-ai/kling-video/v3/pro/text-to-video" for higher quality. The legacy v1.5 and v2.1 standard sub-models were retired by fal on 2026-05-27 and will 404.',
    ),
  aspect: z
    .enum(['16:9', '9:16', '1:1'])
    .optional()
    .describe('Aspect ratio for the rendered clip. Defaults to 16:9.'),
  track_id: z
    .string()
    .optional()
    .describe(
      'Optional explicit timeline track id. Omit to drop the clip onto a new track above existing video.',
    ),
}

export function createGenerateBrollTool(options: CreateGenerateBrollToolOptions) {
  return tool(
    'generate_broll',
    'Generate a b-roll video clip from a text prompt via a remote model (fal). SPEND GATE: before rendering, the user sees an approval card in chat (the prompt + estimated cost) and must approve; if they decline, the tool returns status:"declined" and makes NO timeline change — report that you skipped it and do not retry unless the user asks again. On approval it inserts a placeholder at the requested time range, swaps in the rendered clip when it finishes (typically 30-90s), and writes generation metadata. A single Ctrl+Z removes the final clip. Returns the clip id, provider/model, and dollar cost when available.',
    inputSchema,
    async (args) => {
      const { start_seconds, end_seconds } = args
      let promptText = args.prompt
      if (end_seconds <= start_seconds) {
        throw new Error('end_seconds must be greater than start_seconds')
      }
      const targetDurationSec = end_seconds - start_seconds

      const strategy: VideoGenerationStrategy = args.provider ?? 'auto'
      const { provider, reason: routingReason } = pickVideoGenerationProvider(
        options.providers.videoGeneration,
        strategy,
      )

      const aspect: VideoAspectRatio = args.aspect ?? '16:9'
      const modelForEstimate = args.model ?? DEFAULT_BROLL_MODEL

      // M5.2 spend-confirmation gate. Runs BEFORE any timeline mutation (and
      // before transcript grounding, so a prompt edit on the card flows into
      // the grounded prompt). Skipped automatically when the bridge has no
      // confirmation channel (e.g. unit tests) — generation just proceeds.
      if (options.bridge.requestConfirmation) {
        const decision = await options.bridge.requestConfirmation(
          {
            title: 'Generate this b-roll?',
            summary: promptText,
            costEstimate: estimateVideoGenerationCost(modelForEstimate, targetDurationSec),
            details: [
              { label: 'Model', value: modelForEstimate.replace(/^fal-ai\//, '') },
              { label: 'Duration', value: `${Math.round(targetDurationSec)}s` },
              { label: 'Aspect', value: aspect },
              { label: 'Provider', value: provider.id },
            ],
            editableFields: [
              { key: 'prompt', label: 'Prompt', value: promptText, multiline: true },
            ],
            approveLabel: 'Generate',
            rejectLabel: 'Skip',
          },
          options.abortSignal,
        )
        if (decision.decision === 'reject') {
          const declined = {
            status: 'declined' as const,
            message: 'You declined to generate the b-roll. No timeline changes were made.',
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify(declined, null, 2) }] }
        }
        if (decision.decision === 'edit' && decision.edits) {
          const editedPrompt = decision.edits.prompt
          if (typeof editedPrompt === 'string' && editedPrompt.trim().length > 0) {
            promptText = editedPrompt.trim()
          }
        }
      }

      // §6.5.1: transcript-grounded prompt. Best-effort — if a transcript
      // covers the requested window, prepend it as VIDEO CONTEXT so the
      // rendered visual matches what's being said. The browser handler
      // returns `text: null` when nothing overlaps; we fall back to the
      // plain prompt in that case.
      let groundedPrompt = promptText
      let transcriptContextUsed = false
      try {
        const ctx = await options.bridge.invokeBrowserAction<TranscriptContextResult>(
          'read-transcript-context-for-range',
          { startSeconds: start_seconds, endSeconds: end_seconds },
          options.abortSignal,
        )
        if (ctx.text) {
          groundedPrompt =
            buildTranscriptContextBlock({
              text: ctx.text,
              sourceStartSec: ctx.startSeconds,
              sourceEndSec: ctx.endSeconds,
            }) +
            '\n\n' +
            promptText
          transcriptContextUsed = true
        }
      } catch (err) {
        // Non-fatal — transcript grounding is opportunistic. Continue with
        // the plain prompt rather than failing the whole generation.
        const msg = err instanceof Error ? err.message : String(err)
        if (!options.abortSignal.aborted) {
          // Don't swallow abort errors — let them propagate via the outer try.
          process.stderr.write(`[generate_broll] transcript grounding failed: ${msg}\n`)
        } else {
          throw err
        }
      }

      // 1) Insert placeholder.
      const placeholder = await options.bridge.invokeBrowserAction<InsertPlaceholderResult>(
        'insert-generation-placeholder',
        {
          startSeconds: start_seconds,
          endSeconds: end_seconds,
          prompt: promptText,
          trackId: args.track_id,
          providerId: provider.id,
          modelId: args.model,
        },
        options.abortSignal,
      )

      // 2) Run the provider. If the abort fires (turn cancel) we'll clean up
      //    the placeholder in the catch and re-throw.
      try {
        const generation = await provider.generate(
          { prompt: groundedPrompt, aspect, targetDurationSec, model: args.model },
          { bridge: options.bridge, signal: options.abortSignal },
        )

        // 3) Swap placeholder with the downloaded asset (and write metadata).
        const swap = await options.bridge.invokeBrowserAction<SwapPlaceholderResult>(
          'swap-generation-placeholder-with-url',
          {
            placeholderId: placeholder.placeholderId,
            sourceUrl: generation.sourceUrl,
            providerId: provider.id,
            modelId: generation.modelUsed,
            prompt: promptText,
            cost: generation.cost,
            providerInputs: { aspect },
          },
          options.abortSignal,
        )

        const result = {
          clipId: swap.clipId,
          mediaId: swap.mediaId,
          trackId: swap.trackId,
          providerUsed: provider.id,
          modelUsed: generation.modelUsed,
          cost: generation.cost,
          durationSec: generation.durationSec,
          routingReason,
          usedTranscriptContext: transcriptContextUsed,
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        }
      } catch (err) {
        const aborted = options.abortSignal.aborted || (err as Error)?.name === 'AbortError'
        if (aborted) {
          // Cancel: remove the placeholder cleanly, then re-throw.
          await safeInvoke(options.bridge, 'remove-generation-placeholder', {
            placeholderId: placeholder.placeholderId,
          })
          throw err
        }
        // Failure: leave a visible error placeholder for the user.
        const errorMessage = err instanceof Error ? err.message : String(err)
        await safeInvoke(options.bridge, 'mark-generation-placeholder-error', {
          placeholderId: placeholder.placeholderId,
          errorMessage,
        })
        throw err
      }
    },
  )
}

/**
 * Best-effort fire-and-forget bridge call for cleanup paths — swallows
 * errors because the original failure is what the agent should surface.
 * The cleanup uses a fresh AbortController to avoid being shorted out by
 * the same abort that triggered the cleanup.
 */
async function safeInvoke(
  bridge: BrowserActionBridge,
  action: string,
  args: unknown,
): Promise<void> {
  try {
    const controller = new AbortController()
    await bridge.invokeBrowserAction(action, args, controller.signal)
  } catch {
    // ignore
  }
}
