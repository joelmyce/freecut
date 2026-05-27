import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import { pickImageGenerationProvider } from '../providers/image/index.ts'
import type {
  ImageAspectRatio,
  ImageGenerationStrategy,
  ImageResolutionTier,
} from '../providers/image/index.ts'

export interface CreateGenerateImageToolOptions {
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

const inputSchema = {
  prompt: z
    .string()
    .min(1)
    .describe(
      'Plain-English description of the image to generate. Image models like gpt-image-2 render legible text accurately, so use this tool (not generate_broll) when the image needs readable on-screen text, logos, or UI labels. Example: "screenshot of a VS Code editor showing a React component, dark theme, syntax highlighted code with import statements visible".',
    ),
  start_seconds: z
    .number()
    .min(0)
    .describe('Start of the image clip on the project timeline, in seconds from project zero.'),
  end_seconds: z
    .number()
    .describe(
      'End of the image clip on the project timeline, in seconds. Must exceed start_seconds. The still will hold for this duration; pick something readable (3-8s for text-heavy stills).',
    ),
  provider: z
    .enum(['auto', 'fal'])
    .optional()
    .describe('Which provider to use. "auto" (default) picks the first available — currently fal.'),
  model: z
    .string()
    .optional()
    .describe(
      'Provider-specific model id. fal default is "openai/gpt-image-2" — picked because OpenAI\'s image model renders legible on-screen text accurately, unlike text-to-video models which hallucinate gibberish glyphs. Note: vendor-namespaced models on fal (openai/..., etc.) do NOT take a "fal-ai/" prefix in their id. Override only when the user names a specific model.',
    ),
  aspect: z
    .enum(['16:9', '9:16', '1:1', '4:3', '3:4'])
    .optional()
    .describe('Aspect ratio for the generated image. Defaults to 16:9.'),
  resolution: z
    .enum(['standard', 'high', 'max'])
    .optional()
    .describe(
      'Output resolution tier. "max" (default) targets ~1440p / 2K (e.g. 2560x1440 for 16:9) — crisp on 4K timelines but slower + costlier per gen. "high" targets ~1080p (1920x1088 for 16:9) — matches typical project canvas. "standard" uses fal\'s named preset (~1024px short edge) — fastest, lowest quality. Drop to "high" or "standard" when speed/cost matters more than pixel fidelity.',
    ),
  track_id: z
    .string()
    .optional()
    .describe(
      'Optional explicit timeline track id. Omit to drop the image onto a new track above existing video.',
    ),
}

/**
 * `generate_image` — fal image generation (M4.7). Drops a still image
 * onto the timeline via the M3 placeholder→swap pattern. Default model
 * is `fal-ai/openai/gpt-image-2` for accurate text rendering.
 *
 * Use this instead of `generate_broll` when:
 *   - The b-roll needs legible on-screen text, logos, or UI labels
 *     (Kling and other text-to-video models render text as gibberish).
 *   - The user wants to iterate on composition cheaply before paying
 *     for motion — the still IS a concept card.
 *   - Followed by `animate_image` for the full image-then-animate flow.
 */
export function createGenerateImageTool(options: CreateGenerateImageToolOptions) {
  return tool(
    'generate_image',
    'Generate a still image from a text prompt via fal (default: gpt-image-2). Best for b-roll that needs LEGIBLE on-screen text — text-to-video models hallucinate gibberish glyphs but image models render text accurately. Inserts a placeholder at the requested time range immediately, swaps in the rendered still when ready (typically 5-15s). Single Ctrl+Z removes the final clip. Often chained with animate_image for moving b-roll that preserves text legibility.',
    inputSchema,
    async (args) => {
      const { start_seconds, end_seconds, prompt } = args
      if (end_seconds <= start_seconds) {
        throw new Error('end_seconds must be greater than start_seconds')
      }

      const strategy: ImageGenerationStrategy = args.provider ?? 'auto'
      const { provider, reason: routingReason } = pickImageGenerationProvider(
        options.providers.imageGeneration,
        strategy,
      )

      const aspect: ImageAspectRatio = args.aspect ?? '16:9'
      const resolution: ImageResolutionTier = args.resolution ?? 'max'

      // 1) Insert placeholder.
      const placeholder = await options.bridge.invokeBrowserAction<InsertPlaceholderResult>(
        'insert-generation-placeholder',
        {
          startSeconds: start_seconds,
          endSeconds: end_seconds,
          prompt,
          trackId: args.track_id,
          providerId: provider.id,
          modelId: args.model,
        },
        options.abortSignal,
      )

      // 2) Run the provider. If the abort fires we'll clean up the
      //    placeholder in the catch and re-throw.
      try {
        const generation = await provider.generate(
          { prompt, aspect, resolution, model: args.model },
          { bridge: options.bridge, signal: options.abortSignal },
        )

        // 3) Swap placeholder with the downloaded asset. `mediaKind: 'image'`
        //    tells the browser handler to import as an image (not video) and
        //    write outputKind: 'image' to the generation envelope.
        const swap = await options.bridge.invokeBrowserAction<SwapPlaceholderResult>(
          'swap-generation-placeholder-with-url',
          {
            placeholderId: placeholder.placeholderId,
            sourceUrl: generation.sourceUrl,
            providerId: provider.id,
            modelId: generation.modelUsed,
            prompt,
            cost: generation.cost,
            providerInputs: { aspect, resolution },
            mediaKind: 'image',
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
          width: generation.width,
          height: generation.height,
          routingReason,
          mediaKind: 'image' as const,
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
