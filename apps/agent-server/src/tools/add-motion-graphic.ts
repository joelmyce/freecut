import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { BrowserActionBridge } from '../providers/index.ts'
import { getMotionGraphicTemplate } from '../templates/index.ts'
import type { MotionGraphicContent, MotionGraphicStyle } from '../templates/index.ts'
import { resolveBrandKnobsOrThrow } from '../brand/index.ts'
import { brandKnobFields } from '../brand/tool-fields.ts'

export interface CreateAddMotionGraphicToolOptions {
  bridge: BrowserActionBridge
  abortSignal: AbortSignal
}

/** Payload returned by the browser `add-motion-graphic` handler. */
interface AddMotionGraphicActionResult {
  insertedItemCount: number
  insertedTrackCount: number
  fromSeconds: number
  durationSeconds: number
  layerLabels: string[]
}

const contentSchema = z
  .object({
    name: z
      .string()
      .optional()
      .describe(
        'lower_third: the bold primary line — the person or brand name (e.g. "Alex Rivera", "Acme Inc."). REQUIRED for lower_third.',
      ),
    role: z
      .string()
      .optional()
      .describe(
        'lower_third: the secondary line under the name — a title, role, handle, or location (e.g. "Founder, Acme", "@alexrivera", "San Francisco"). Optional; omit for a single-line card.',
      ),
    title: z
      .string()
      .optional()
      .describe(
        'title_card: the centered headline (e.g. "Chapter One", "How It Works"). REQUIRED for title_card.',
      ),
    subtitle: z
      .string()
      .optional()
      .describe(
        'title_card: the smaller line under the headline. Optional; omit for a headline-only card.',
      ),
    value: z
      .string()
      .optional()
      .describe(
        'stat_callout: the big hero value, AS A STRING so any format works ("10,000+", "$2.5M", "98%", "3x"). REQUIRED for stat_callout. NOTE: it pops in with punch but does NOT tick/count up.',
      ),
    label: z
      .string()
      .optional()
      .describe(
        'stat_callout: the caption under the value (e.g. "subscribers", "revenue", "faster"). Optional.',
      ),
    accent_color: z
      .string()
      .optional()
      .describe(
        'Optional CSS color (hex like "#22D3EE" or a name like "cyan") used to theme the accent element (lower_third role line, title_card divider, stat_callout label). Defaults to blue (#3B82F6). Pass when the user names a color or asks to match a brand.',
      ),
  })
  .describe(
    'Template content. Which fields are read depends on `template` (see each field). Unused fields are ignored.',
  )

const inputSchema = {
  // NOTE: extend this enum (and the templates registry) when adding templates.
  template: z
    .enum(['lower_third', 'title_card', 'stat_callout'])
    .describe(
      'Which native motion-graphic template to insert. "lower_third" = a name + optional role identifier card in the lower third (slides in from the left). "title_card" = a centered headline + optional subtitle with a growing accent divider (fades + scales in). "stat_callout" = a big hero value + optional caption that pops in (font-scale overshoot; does NOT tick/count).',
    ),
  content: contentSchema,
  target_seconds: z
    .number()
    .positive()
    .optional()
    .describe(
      'How long the graphic stays on screen, in seconds. Defaults to the template default (5s for lower_third). The slide-in and fade-out adapt to fit. Minimum effective duration is ~1.5s.',
    ),
  start_seconds: z
    .number()
    .min(0)
    .optional()
    .describe(
      'Where on the timeline (in seconds) the graphic starts. Defaults to the current playhead position. Use the start of the clip the speaker is introduced over when the user says "identify them here" / "when they start talking".',
    ),
  ...brandKnobFields,
}

/**
 * `add_motion_graphic` — M6.4. Composes native FreeCut text + shape + keyframe
 * primitives into a motion graphic and inserts it DIRECTLY onto the timeline as
 * ordinary editable items. **Side effects: mutate** — but the whole graphic is
 * one undo entry (single Ctrl+Z removes it).
 *
 * Architecture (mirrors detect_chapters): the server picks a template and fills
 * in the user's content, producing a resolution-INDEPENDENT MotionGraphicSpec
 * (fraction geometry + clip-relative animations). The browser `add-motion-graphic`
 * handler materializes it against the live project (fps + canvas size + playhead)
 * — creating one stacked track per layer and committing items + keyframes
 * atomically. No remote provider, no render queue, no placeholder→swap; the
 * graphic is on screen the instant the tool returns.
 *
 * SCOPE: native-editable / zero-cost templates only — the Hyperframe complement.
 * Avatar / talking-head / stylized lower thirds are NOT built here.
 */
export function createAddMotionGraphicTool(options: CreateAddMotionGraphicToolOptions) {
  return tool(
    'add_motion_graphic',
    'Insert a native FreeCut motion graphic built from real text + shape + keyframe layers — it appears INSTANTLY, costs nothing (no AI generation, no rendering), and stays fully editable on the timeline. Three templates: "lower_third" (content.name required, role?/accent_color? optional) — a speaker name card in the lower third for "add a lower third / name tag / chyron / nameplate / identify the speaker"; "title_card" (content.title required, subtitle?/accent_color?) — a centered headline for "title card / intro title / section title / chapter title"; "stat_callout" (content.value required as a STRING like "10,000+"/"$2.5M"/"98%", label?/accent_color?) — a big hero number for "show a stat / big number / metric / counter" (it pops in with punch but does NOT tick through numbers). The whole graphic inserts as ONE undo entry (single Ctrl+Z removes it) on its own stacked tracks above the current content; it defaults to the playhead and a few seconds on screen (override with start_seconds / target_seconds). Prefer this over generate_image/generate_broll for any name card, title, or stat — it is the instant, editable, free path. NOT for stylized, animated-avatar, or talking-head graphics — only clean native text+shape cards. For BRANDING, pass brand:"abdias" (and optionally brand_mode) when the user names a saved brand — the card then uses the brand colors + font (title cards and stat callouts also get the brand\'s flat background); an explicit accent_color still overrides the brand accent.',
    inputSchema,
    async (args) => {
      const template = getMotionGraphicTemplate(args.template)
      if (!template) {
        throw new Error(
          `add_motion_graphic: unknown template "${args.template}". Supported: lower_third, title_card, stat_callout.`,
        )
      }

      const content: MotionGraphicContent = {
        name: args.content.name,
        role: args.content.role,
        title: args.content.title,
        subtitle: args.content.subtitle,
        value: args.content.value,
        label: args.content.label,
      }

      const missing = template.requiredContent.filter((key) => {
        const value = content[key]
        return typeof value !== 'string' || value.trim().length === 0
      })
      if (missing.length > 0) {
        throw new Error(
          `add_motion_graphic: template "${args.template}" requires ${missing.join(
            ', ',
          )}. Ask the user for the missing value(s), then call add_motion_graphic again.`,
        )
      }

      // Brand fills any styling knob the user didn't set explicitly; an explicit
      // accent_color still wins (explicit > brand > template default).
      const brandKnobs = resolveBrandKnobsOrThrow(args.brand, args.brand_mode)
      const style: MotionGraphicStyle = {
        accentColor: args.content.accent_color ?? brandKnobs?.accentColor,
        titleColor: brandKnobs?.titleColor,
        secondaryColor: brandKnobs?.secondaryColor,
        backgroundColor: brandKnobs?.backgroundColor,
        surfaceColor: brandKnobs?.surfaceColor,
        fontFamily: brandKnobs?.fontFamily,
      }

      const spec = template.build(content, style)

      const result = await options.bridge.invokeBrowserAction<AddMotionGraphicActionResult>(
        'add-motion-graphic',
        {
          spec,
          targetSeconds: args.target_seconds,
          startSeconds: args.start_seconds,
        },
        options.abortSignal,
      )

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                template: args.template,
                insertedItemCount: result.insertedItemCount,
                insertedTrackCount: result.insertedTrackCount,
                fromSeconds: result.fromSeconds,
                durationSeconds: result.durationSeconds,
                layers: result.layerLabels,
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )
}
