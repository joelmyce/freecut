import { z } from 'zod'
import { BRAND_IDS } from './index.ts'

/**
 * Shared `brand` + `brand_mode` input fields for styling tools. Spread
 * `...brandKnobFields` into a tool's inputSchema to make it brand-aware; the
 * tool then resolves via `resolveBrandKnobsOrThrow()` and fills only the knobs
 * the user did not set explicitly (explicit > brand > default).
 *
 * This is the `withBrand()` mixin every FUTURE HyperFrames tool reuses — see the
 * `hyperframes-feature-menu` memory note.
 */
export const brandKnobFields = {
  brand: z
    .string()
    .optional()
    .describe(
      `Optional saved brand profile to style this with (known brands: ${BRAND_IDS.join(
        ', ',
      )}). Pass when the user NAMES a brand — "on the Abdias brand", "Abdias Marketing", "my brand", "on-brand", "branded". The tool fills brand colors + fonts for any styling knob the user didn't set explicitly; do NOT also spell out the brand's hex colors or font (the tool knows them). Explicit per-call colors/fonts still override the brand. OMIT this entirely when no brand is named — styling then stays at the tool's generic default.`,
    ),
  brand_mode: z
    .enum(['light', 'dark'])
    .optional()
    .describe(
      'Optional brand mode: "light" (the brand\'s Paper mode — editorial / creator content, and the default) or "dark" (its Ink mode — product / technical). Pass ONLY when the user signals it ("paper"/"light"/"for the carousel" → light; "ink"/"dark"/"product" → dark). Omit and the brand\'s own default mode applies.',
    ),
}
