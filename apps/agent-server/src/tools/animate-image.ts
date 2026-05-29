import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import { estimateVideoGenerationCost } from '../providers/video/cost.ts'
import { pickVideoGenerationProvider } from '../providers/video/router.ts'
import type { VideoAspectRatio, VideoGenerationStrategy } from '../providers/video/types.ts'

export interface CreateAnimateImageToolOptions {
  bridge: BrowserActionBridge
  providers: ProvidersBundle
  abortSignal: AbortSignal
}

interface ReadImageClipResult {
  mediaId: string
  trackId: string
  from: number
  durationInFrames: number
  itemType: 'image'
  imageSourceUrl: string
  originalGeneration: {
    provider: string
    model: string
    prompt: string
    params: Record<string, unknown>
  }
}

interface ReplacePlaceholderResult {
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

/**
 * Default Kling image-to-video model on fal. Verified against
 * https://fal.ai/models/fal-ai/kling-video/v3/standard/image-to-video/api
 * on 2026-05-27. Schema differs from text-to-video:
 *   - body: `{ start_image_url, prompt, duration: "3"-"15", generate_audio }`
 *   - no `aspect_ratio` field (auto-detected from the image)
 */
const DEFAULT_IMAGE_TO_VIDEO_MODEL = 'fal-ai/kling-video/v3/standard/image-to-video'

/**
 * Sensible motion prompt when the user doesn't supply one. Kling
 * image-to-video requires a `prompt`; sending an empty string sometimes
 * produces no motion at all. This nudges the model toward subtle,
 * professional camera movement that keeps the original composition
 * intact — exactly what b-roll needs.
 */
const DEFAULT_MOTION_PROMPT = 'Subtle natural motion, gentle cinematic camera movement'

const inputSchema = {
  image_clip_id: z
    .string()
    .describe(
      'The bare uuid of the AI-generated IMAGE clip on the timeline to animate. Must be a clip that came from generate_image — the tool reads the still\'s stored fal URL from generation.json and feeds it to Kling image-to-video as the source frame. Pass JUST the uuid, no "item:" or "media:" prefix.',
    ),
  motion_prompt: z
    .string()
    .optional()
    .describe(
      'Optional plain-English description of the camera/subject motion to add to the still. Example: "slow drift left to right, subtle parallax". Defaults to subtle natural motion when omitted — the model preserves the still\'s composition and just adds movement.',
    ),
  duration_sec: z
    .number()
    .optional()
    .describe(
      "Optional duration of the animated clip in seconds. Kling v3 image-to-video accepts integer values from 3 to 15. Defaults to the still's existing timeline window length.",
    ),
  provider: z
    .enum(['auto', 'fal', 'kie'])
    .optional()
    .describe('Which provider to use. "auto" (default) picks fal.'),
  model: z
    .string()
    .optional()
    .describe(
      `Provider-specific image-to-video model id. fal default is "${DEFAULT_IMAGE_TO_VIDEO_MODEL}". For higher quality at higher cost, use "fal-ai/kling-video/v3/pro/image-to-video".`,
    ),
  track_id: z
    .string()
    .optional()
    .describe(
      'Optional explicit timeline track id for the animated clip. Defaults to the same track the source image is on (it replaces the image in place).',
    ),
}

/**
 * `animate_image` — M4.7 part 2. Takes an AI-generated still image on
 * the timeline and animates it into a moving b-roll clip via fal Kling
 * image-to-video, preserving the still's text legibility and composition.
 *
 * Flow:
 *   1. read-image-clip-for-animation (browser, read-only) → returns the
 *      source still's mediaId + the original fal URL stored in its
 *      generation.json envelope.
 *   2. requestConfirmation (M5.2) → shows the user a spend-approval card
 *      (the still preview + estimated cost + editable motion prompt). Runs
 *      BEFORE any mutation, so a decline leaves the timeline untouched.
 *      Skipped automatically when the bridge has no confirmation channel.
 *   3. replace-clip-with-placeholder (browser, mutating) → captures a
 *      pre-mutation snapshot of the timeline, removes the image clip,
 *      inserts a placeholder over the same range. M4.1's pattern.
 *   4. provider.generate with imageUrl set → fal Kling image-to-video
 *      returns the rendered MP4 URL.
 *   5. swap-generation-placeholder-with-url (browser, mutating) →
 *      replaces the placeholder with the actual video clip and writes
 *      generation.json. mediaKind defaults to 'video'.
 *
 * Single Ctrl+Z rewinds all three browser mutations because step 3 stashed
 * the pre-mutation snapshot under the placeholder id; the swap in step 5
 * pushes ONE combined undo entry. Same semantics as
 * replace_clip_with_regeneration on AI-generated video clips.
 */
export function createAnimateImageTool(options: CreateAnimateImageToolOptions) {
  return tool(
    'animate_image',
    'Animate an AI-generated still image on the timeline into a moving video clip via fal Kling image-to-video. Replaces the still with the animated version in the same window — single Ctrl+Z restores the original still. Use this after generate_image to add motion while keeping text legible (text-to-video models would mangle the text, but image-to-video preserves the input frame as the starting point). Requires an AI-generated image clip — errors on non-image clips or images that weren\'t generated. SPEND GATE: before rendering, the user sees an approval card in chat (the still preview + estimated cost) and must approve. If they decline, the tool returns status:"declined" and makes NO timeline change — report that you skipped it and do not retry unless the user asks again.',
    inputSchema,
    async (args) => {
      const strategy: VideoGenerationStrategy = args.provider ?? 'auto'
      const { provider, reason: routingReason } = pickVideoGenerationProvider(
        options.providers.videoGeneration,
        strategy,
      )

      // 1) Read the source image clip + its stored fal URL.
      const clipInfo = await options.bridge.invokeBrowserAction<ReadImageClipResult>(
        'read-image-clip-for-animation',
        { clipId: args.image_clip_id },
        options.abortSignal,
      )

      let motionPrompt = args.motion_prompt?.trim() || DEFAULT_MOTION_PROMPT
      const model = args.model ?? DEFAULT_IMAGE_TO_VIDEO_MODEL

      // Resolve the target duration BEFORE any mutation so the confirmation
      // card can show it. Honor an explicit duration_sec; otherwise default to
      // the still's existing timeline window length (clipInfo carries it). The
      // browser handler doesn't return project FPS, so best-effort guess 30 —
      // Kling snaps to its 3..15s enum regardless.
      const FALLBACK_FPS = 30
      let targetDurationSec =
        args.duration_sec !== undefined
          ? args.duration_sec
          : Math.max(3, Math.round(clipInfo.durationInFrames / FALLBACK_FPS))

      // 2) M5.2 spend-confirmation gate. The still IS the card. This runs
      //    BEFORE any timeline mutation, so declining leaves the timeline
      //    untouched. Skipped automatically when the bridge has no
      //    confirmation channel (e.g. unit tests) — the render just proceeds.
      if (options.bridge.requestConfirmation) {
        const decision = await options.bridge.requestConfirmation(
          {
            title: 'Animate this still?',
            summary: motionPrompt,
            previewImageUrl: clipInfo.imageSourceUrl,
            costEstimate: estimateVideoGenerationCost(model, targetDurationSec),
            details: [
              { label: 'Model', value: model.replace(/^fal-ai\//, '') },
              { label: 'Duration', value: `${targetDurationSec}s` },
              { label: 'Provider', value: provider.id },
            ],
            editableFields: [
              { key: 'motion_prompt', label: 'Motion', value: motionPrompt, multiline: true },
            ],
            approveLabel: 'Animate',
            rejectLabel: 'Skip',
          },
          options.abortSignal,
        )

        if (decision.decision === 'reject') {
          const declined = {
            status: 'declined' as const,
            clipId: args.image_clip_id,
            message: 'You declined to animate the still. No timeline changes were made.',
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(declined, null, 2) }],
          }
        }

        if (decision.decision === 'edit' && decision.edits) {
          const editedMotion = decision.edits.motion_prompt
          if (typeof editedMotion === 'string' && editedMotion.trim().length > 0) {
            motionPrompt = editedMotion.trim()
          }
          const editedDuration = decision.edits.duration_sec
          if (typeof editedDuration === 'number' && Number.isFinite(editedDuration)) {
            targetDurationSec = editedDuration
          }
        }
      }

      // 3) Replace the still clip with a placeholder (M4.1 pattern). The
      //    placeholder lives in the same trackId/from/durationInFrames as the
      //    original image and a single Ctrl+Z will roll back here.
      const placeholder = await options.bridge.invokeBrowserAction<ReplacePlaceholderResult>(
        'replace-clip-with-placeholder',
        {
          clipId: args.image_clip_id,
          prompt: `Animating: ${motionPrompt.slice(0, 100)}`,
          providerId: provider.id,
          modelId: model,
        },
        options.abortSignal,
      )

      try {
        // 4) Run the image-to-video model.
        const generation = await provider.generate(
          {
            prompt: motionPrompt,
            // Kling image-to-video ignores aspect_ratio (auto-detected from
            // the image) but the type requires us to pass one. Pass 16:9
            // as a no-op default.
            aspect: '16:9' as VideoAspectRatio,
            targetDurationSec,
            model,
            imageUrl: clipInfo.imageSourceUrl,
          },
          { bridge: options.bridge, signal: options.abortSignal },
        )

        // 5) Swap placeholder with the rendered video. mediaKind defaults
        //    to 'video' which is what we want here.
        const swap = await options.bridge.invokeBrowserAction<SwapPlaceholderResult>(
          'swap-generation-placeholder-with-url',
          {
            placeholderId: placeholder.placeholderId,
            sourceUrl: generation.sourceUrl,
            providerId: provider.id,
            modelId: generation.modelUsed,
            prompt: motionPrompt,
            cost: generation.cost,
            providerInputs: {
              sourceImageMediaId: clipInfo.mediaId,
              sourceImageUrl: clipInfo.imageSourceUrl,
              motion_prompt: motionPrompt,
              duration_sec: targetDurationSec,
            },
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
          sourceImageMediaId: clipInfo.mediaId,
          motionPrompt,
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
