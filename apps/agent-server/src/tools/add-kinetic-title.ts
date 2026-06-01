import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { BrowserActionBridge } from '../providers/index.ts'
import { renderKineticTitle, type RenderCompositionResult } from '../hyperframes/index.ts'
import { resolveBrandKnobsOrThrow } from '../brand/index.ts'
import { brandKnobFields } from '../brand/tool-fields.ts'

/** Injectable renderer so tests run without spawning Chrome. */
export type KineticTitleRenderer = (args: {
  title: string
  subtitle?: string
  accentColor?: string
  backgroundColor?: string
  titleColor?: string
  subtitleColor?: string
  fontFamily?: string
  durationSec: number
  signal?: AbortSignal
}) => Promise<RenderCompositionResult>

export interface CreateAddKineticTitleToolOptions {
  bridge: BrowserActionBridge
  abortSignal: AbortSignal
  /** Defaults to the real local HyperFrames render. Overridden in tests. */
  render?: KineticTitleRenderer
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

const DEFAULT_DURATION_SEC = 4

const inputSchema = {
  title: z
    .string()
    .min(1)
    .describe('The headline text. Kept short — this is a title card, not a paragraph.'),
  subtitle: z
    .string()
    .optional()
    .describe('Optional smaller line under the headline (a tagline / author / date).'),
  accent_color: z
    .string()
    .optional()
    .describe(
      'Optional CSS color (hex like "#22D3EE" or a name) for the accent underline + sheen. Defaults to indigo (#6366F1).',
    ),
  title_color: z
    .string()
    .optional()
    .describe('Optional CSS color for the headline text. Defaults to white.'),
  background_color: z
    .string()
    .optional()
    .describe(
      'Optional CSS color for the card background (the center of the radial gradient). Defaults to a near-black navy.',
    ),
  subtitle_color: z
    .string()
    .optional()
    .describe('Optional CSS color for the subtitle text. Defaults to light grey.'),
  font_family: z
    .string()
    .optional()
    .describe(
      'Optional Google Fonts family name to brand the type — e.g. "Montserrat", "Poppins", "Playfair Display", "Inter". Loaded from Google Fonts at render; falls back to a system sans if unavailable. Pass the family name exactly as Google lists it.',
    ),
  start_seconds: z
    .number()
    .min(0)
    .describe('Where on the timeline (seconds) the title starts. Use the playhead if unsure.'),
  target_seconds: z
    .number()
    .positive()
    .optional()
    .describe('How long the title stays on screen, in seconds. Defaults to 4.'),
  ...brandKnobFields,
}

/**
 * `add_kinetic_title` — Phase 1 HyperFrames rich-graphics tool (first slice).
 *
 * Renders a stylized, animated title card LOCALLY via the open-source
 * HyperFrames HTML→MP4 renderer (free, no API), then drops it on the timeline as
 * ordinary media using the M3 placeholder→swap pattern. This is the
 * **rich/baked** complement to the native `add_motion_graphic` title: it does
 * effects FreeCut primitives can't (blur-clear word kinetics, gradient accent),
 * at the cost of being a rendered clip rather than live-editable text.
 *
 * Pipeline: insert placeholder → render HTML→MP4 on-device (~10-30s) → ship the
 * bytes over the bridge → swap the placeholder for the imported clip. One Ctrl+Z
 * removes the final clip. Cancel removes the placeholder; failure marks it.
 */
export function createAddKineticTitleTool(options: CreateAddKineticTitleToolOptions) {
  const render = options.render ?? renderKineticTitle

  return tool(
    'add_kinetic_title',
    'Render a STYLIZED, ANIMATED title card locally (free, no API) via the HyperFrames engine and drop it on the timeline. Use when the user wants a fancy/animated/"motion-designed" title with effects beyond plain text — "animated title", "kinetic title", "cinematic intro title", "stylized title card". The words stagger in with a blur-clear, an accent underline wipes open, an optional subtitle fades up. This is a RENDERED clip (takes ~10-30s; a placeholder shows while it renders, then the finished clip swaps in — one Ctrl+Z removes it). For a SIMPLE, instantly-editable title you will tweak by hand, prefer add_motion_graphic template:"title_card" instead — this tool trades live editability for richer motion. Provide title (required); optionally subtitle, start_seconds, and target_seconds (default 4s). For BRANDING, the easiest path is brand:"abdias" (+ optional brand_mode) when the user names a saved brand — it fills the brand colors + font automatically. Otherwise pass any of accent_color, title_color, background_color, subtitle_color (CSS colors) and font_family (a Google Fonts name like "Montserrat" / "Poppins" / "Playfair Display") to brand it by hand; explicit colors/font override a brand.',
    inputSchema,
    async (args) => {
      const durationSec = args.target_seconds ?? DEFAULT_DURATION_SEC
      const endSeconds = args.start_seconds + durationSec
      const promptLabel = `Kinetic title: "${args.title}"`

      // Brand fills any styling knob the user didn't set explicitly
      // (explicit per-call value > brand token > template default).
      const brandKnobs = resolveBrandKnobsOrThrow(args.brand, args.brand_mode)
      const accentColor = args.accent_color ?? brandKnobs?.accentColor
      const titleColor = args.title_color ?? brandKnobs?.titleColor
      const backgroundColor = args.background_color ?? brandKnobs?.backgroundColor
      const subtitleColor = args.subtitle_color ?? brandKnobs?.secondaryColor
      const fontFamily = args.font_family ?? brandKnobs?.fontFamily

      // 1) Placeholder at the requested window.
      const placeholder = await options.bridge.invokeBrowserAction<InsertPlaceholderResult>(
        'insert-generation-placeholder',
        {
          startSeconds: args.start_seconds,
          endSeconds,
          prompt: promptLabel,
          providerId: 'hyperframes',
          modelId: 'kinetic-title',
        },
        options.abortSignal,
      )

      try {
        // 2) Render locally (HTML→MP4, on-device).
        const rendered = await render({
          title: args.title,
          subtitle: args.subtitle,
          accentColor,
          backgroundColor,
          titleColor,
          subtitleColor,
          fontFamily,
          durationSec,
          signal: options.abortSignal,
        })

        // 3) Swap the placeholder for the rendered clip (bytes, not a URL).
        const swap = await options.bridge.invokeBrowserAction<SwapPlaceholderResult>(
          'swap-generation-placeholder-with-url',
          {
            placeholderId: placeholder.placeholderId,
            sourceBytesBase64: rendered.bytesBase64,
            mediaMimeType: rendered.mimeType,
            providerId: 'hyperframes',
            modelId: 'kinetic-title',
            prompt: promptLabel,
            providerInputs: {
              template: 'kinetic_title',
              brand: brandKnobs?.brandId,
              brandMode: brandKnobs?.mode,
              accentColor,
              backgroundColor,
              titleColor,
              subtitleColor,
              fontFamily,
              durationSec,
            },
          },
          options.abortSignal,
        )

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  template: 'kinetic_title',
                  engine: 'hyperframes',
                  clipId: swap.clipId,
                  mediaId: swap.mediaId,
                  trackId: swap.trackId,
                  fromSeconds: args.start_seconds,
                  durationSeconds: durationSec,
                  title: args.title,
                },
                null,
                2,
              ),
            },
          ],
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

/** Best-effort cleanup bridge call (fresh signal so it isn't shorted by the abort). */
async function safeInvoke(
  bridge: BrowserActionBridge,
  action: string,
  args: unknown,
): Promise<void> {
  try {
    await bridge.invokeBrowserAction(action, args, new AbortController().signal)
  } catch {
    // ignore — the original error is what matters
  }
}
