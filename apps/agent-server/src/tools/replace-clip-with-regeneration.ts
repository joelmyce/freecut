import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import { pickVideoGenerationProvider } from '../providers/video/router.ts'
import type {
  VideoAspectRatio,
  VideoGenerationProviderId,
  VideoGenerationStrategy,
} from '../providers/video/types.ts'
import { buildTranscriptContextBlock } from './prompt-grounding.ts'

export interface CreateReplaceClipToolOptions {
  bridge: BrowserActionBridge
  providers: ProvidersBundle
  abortSignal: AbortSignal
}

interface ReadClipForRegenResult {
  mediaId: string | null
  trackId: string
  from: number
  durationInFrames: number
  itemType: string
  originalGeneration: {
    provider: string
    model: string
    prompt: string
    cost?: { amount: number; currency: 'USD' }
    durationSec?: number
    params: Record<string, unknown>
  } | null
  transcriptContext: {
    text: string
    sourceStartSec: number
    sourceEndSec: number
  } | null
}

interface ReplaceClipResult {
  placeholderId: string
  trackId: string
  from: number
  durationInFrames: number
}

interface SwapResult {
  clipId: string
  mediaId: string
  trackId: string
  from: number
  durationInFrames: number
}

const inputSchema = {
  clip_id: z
    .string()
    .describe(
      'The item id of the clip on the timeline to regenerate. Pull from a "(item:XYZ)" tag in the timeline summary (omit the "item:" prefix). For media-backed clips this is the item id, NOT the underlying mediaId.',
    ),
  new_prompt: z
    .string()
    .optional()
    .describe(
      'FULL REPLACEMENT prompt. Use ONLY when the user describes a completely different subject (e.g. "replace this with footage of mountains instead"). Do NOT use for stylistic tweaks like "more cinematic" / "more dramatic" / "wider shot" / "at night" — use prompt_modifier for those. REQUIRED only if the clip was not previously AI-generated AND no prompt_modifier is supplied — the tool will error otherwise.',
    ),
  prompt_modifier: z
    .string()
    .optional()
    .describe(
      'Additive style/mood/composition modifier APPENDED to the original prompt. Use this whenever the user asks to MODIFY an existing AI-generated clip — phrases like "make it more cinematic", "more dramatic", "wider shot", "at night", "from above". This preserves the original subject (e.g. "city skyline") while shifting the look. Requires the clip to be AI-generated (recoverable original prompt). If the user wants a completely different subject, use new_prompt instead. Cannot be combined with new_prompt.',
    ),
  provider: z
    .enum(['auto', 'fal', 'kie'])
    .optional()
    .describe(
      '"auto" (default) prefers the original provider when known, else falls back to whichever is available. Force "fal" or "kie" only when the user names a specific provider.',
    ),
  model: z
    .string()
    .optional()
    .describe(
      'Provider-specific model id. Default reuses the ORIGINAL model so the regen is consistent with the source clip. DO NOT override this based on quality-sounding adjectives like "cinematic", "better", "higher quality", "more dramatic" — those map to prompt_modifier, not to a model swap. Only override when the user explicitly names a model ("kling 3", "kling pro", "v1.5 standard", etc.).',
    ),
  aspect: z
    .enum(['16:9', '9:16', '1:1'])
    .optional()
    .describe('Aspect ratio for the rendered clip. Defaults to 16:9.'),
}

export function createReplaceClipWithRegenerationTool(options: CreateReplaceClipToolOptions) {
  return tool(
    'replace_clip_with_regeneration',
    "Regenerate an AI-generated clip in place by removing it and dropping a placeholder over the same track + time range, then swapping in the new render when it finishes. By default reuses the clip's original prompt (recovered from generation.json); pass new_prompt to override. Errors clearly if the clip was never AI-generated and no new_prompt is provided. Transcript-grounded — if a transcript covers the clip's source window, it is prepended to the prompt for stylistic consistency. Single Ctrl+Z restores the original clip.",
    inputSchema,
    async (args) => {
      if (args.new_prompt && args.prompt_modifier) {
        throw new Error(
          'Pass either new_prompt (full replacement) or prompt_modifier (style tweak), not both. For "make it more X" requests use prompt_modifier alone; reserve new_prompt for completely different subjects.',
        )
      }

      // 1) Read clip + recovered generation envelope.
      const clipInfo = await options.bridge.invokeBrowserAction<ReadClipForRegenResult>(
        'read-clip-for-regen',
        { clipId: args.clip_id },
        options.abortSignal,
      )

      // 2) Compose prompt. Priority:
      //   - new_prompt → full replacement (user wants a different subject).
      //   - prompt_modifier + original prompt → "original. modifier" (additive tweak, keeps subject).
      //   - original prompt alone → identity regen.
      // If neither user input nor an original prompt is available, error before
      // any timeline mutation.
      const originalPrompt = clipInfo.originalGeneration?.prompt
      let basePrompt: string | undefined
      let regenMode: 'identity' | 'modifier' | 'replacement'
      if (args.new_prompt) {
        basePrompt = args.new_prompt
        regenMode = 'replacement'
      } else if (args.prompt_modifier) {
        if (!originalPrompt) {
          throw new Error(
            `Clip ${args.clip_id} is not AI-generated, so prompt_modifier "${args.prompt_modifier}" has nothing to append to. Pass new_prompt with the full description instead.`,
          )
        }
        basePrompt = `${originalPrompt}. ${args.prompt_modifier}`
        regenMode = 'modifier'
      } else if (originalPrompt) {
        basePrompt = originalPrompt
        regenMode = 'identity'
      } else {
        throw new Error(
          `Clip ${args.clip_id} was not AI-generated (no generation.json for its media). Pass new_prompt explicitly to regenerate it from scratch.`,
        )
      }
      const groundedPrompt = clipInfo.transcriptContext
        ? buildTranscriptContextBlock(clipInfo.transcriptContext) + '\n\n' + basePrompt
        : basePrompt

      // 3) Pick provider. If the user supplied one explicitly, honour it.
      //    Otherwise prefer the original provider when it's still available;
      //    fall back to 'auto' if not. This keeps regen idempotent in the
      //    common case (re-render same clip, same provider/model) while
      //    letting users force a different backend.
      const strategy: VideoGenerationStrategy = args.provider ?? 'auto'
      const originalProviderId = clipInfo.originalGeneration?.provider
      const resolvedStrategy =
        strategy === 'auto' && isKnownVideoProviderId(originalProviderId)
          ? originalProviderId
          : strategy
      const { provider, reason: routingReason } = pickVideoGenerationProvider(
        options.providers.videoGeneration,
        resolvedStrategy,
      )

      // 4) Pick model. Explicit > original (only if provider matches) > default.
      const reusedOriginalModel =
        args.model === undefined &&
        clipInfo.originalGeneration &&
        clipInfo.originalGeneration.provider === provider.id
          ? clipInfo.originalGeneration.model
          : undefined
      const modelOverride = args.model ?? reusedOriginalModel

      const aspect: VideoAspectRatio = args.aspect ?? '16:9'
      const targetDurationSec =
        clipInfo.originalGeneration?.durationSec ??
        clipInfo.durationInFrames /
          // Frames are in project FPS; we don't know it server-side, so the
          // browser reports duration in frames and we approximate via the
          // fal `targetDurationSec` field. Use 30 fps as a safe estimator —
          // the provider quantizes to its supported buckets anyway.
          30

      // 5) Replace the clip with a placeholder (mutating, snapshot captured).
      const placeholder = await options.bridge.invokeBrowserAction<ReplaceClipResult>(
        'replace-clip-with-placeholder',
        {
          clipId: args.clip_id,
          prompt: basePrompt,
          providerId: provider.id,
          modelId: modelOverride,
        },
        options.abortSignal,
      )

      // 6) Generate. On abort or failure, fall back to the same cleanup
      //    paths generate_broll uses.
      try {
        const generation = await provider.generate(
          { prompt: groundedPrompt, aspect, targetDurationSec, model: modelOverride },
          { bridge: options.bridge, signal: options.abortSignal },
        )

        const swap = await options.bridge.invokeBrowserAction<SwapResult>(
          'swap-generation-placeholder-with-url',
          {
            placeholderId: placeholder.placeholderId,
            sourceUrl: generation.sourceUrl,
            providerId: provider.id,
            modelId: generation.modelUsed,
            prompt: basePrompt,
            cost: generation.cost,
            providerInputs: { aspect, replacedClipId: args.clip_id },
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
          usedTranscriptContext: clipInfo.transcriptContext !== null,
          regenMode,
          finalPromptPreview: basePrompt.length > 200 ? basePrompt.slice(0, 199) + '…' : basePrompt,
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        }
      } catch (err) {
        const aborted = options.abortSignal.aborted || (err as Error)?.name === 'AbortError'
        if (aborted) {
          await safeInvoke(options.bridge, 'remove-generation-placeholder', {
            placeholderId: placeholder.placeholderId,
          })
          throw err
        }
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

function isKnownVideoProviderId(id: string | undefined): id is VideoGenerationProviderId {
  return id === 'fal' || id === 'kie'
}

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
