/**
 * Brand profile registry + resolver (BRAND PROFILE milestone — A+B).
 *
 * `getBrandProfile` matches a brand by id or alias; `resolveBrandKnobs` flattens
 * a (brand, mode) pair into the tool-ready {@link ResolvedBrandKnobs} bag. The
 * registry is the seam toward a future file/workspace-backed store or a brand-
 * kit UI — swap the backing array without touching any tool.
 *
 * Add a brand: author `profiles/<id>.ts` and list it in `BRAND_PROFILES`.
 */

import { abdiasProfile } from './profiles/abdias.ts'
import type { BrandMode, BrandProfile, ResolvedBrandKnobs } from './types.ts'

export type {
  BrandMode,
  BrandModeTokens,
  BrandFonts,
  BrandRules,
  BrandWordmark,
  BrandProfile,
  ResolvedBrandKnobs,
} from './types.ts'

const BRAND_PROFILES: readonly BrandProfile[] = [abdiasProfile]

/** Known brand ids, for error messages / tool docs. */
export const BRAND_IDS: readonly string[] = BRAND_PROFILES.map((p) => p.id)

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Resolve a brand by id or alias (case-insensitive). Returns undefined when no
 * profile matches — callers decide whether that is an error or a silent no-op.
 */
export function getBrandProfile(idOrAlias: string | undefined): BrandProfile | undefined {
  if (!idOrAlias) return undefined
  const needle = normalize(idOrAlias)
  return BRAND_PROFILES.find(
    (profile) =>
      profile.id === needle || profile.aliases.some((alias) => normalize(alias) === needle),
  )
}

export function resolveBrandMode(profile: BrandProfile, mode: BrandMode | undefined): BrandMode {
  return mode ?? profile.defaultMode
}

/**
 * Flatten a (brand, mode) pair into the tool-ready knob bag. Returns undefined
 * for an unknown brand. Every styling tool calls this and fills only the knobs
 * the user did not set explicitly (explicit per-call value > brand token >
 * template default).
 */
export function resolveBrandKnobs(
  idOrAlias: string | undefined,
  mode?: BrandMode,
): ResolvedBrandKnobs | undefined {
  const profile = getBrandProfile(idOrAlias)
  if (!profile) return undefined
  const resolvedMode = resolveBrandMode(profile, mode)
  const tokens = profile.modes[resolvedMode]
  return {
    brandId: profile.id,
    mode: resolvedMode,
    backgroundColor: tokens.background,
    surfaceColor: tokens.surface,
    titleColor: tokens.textPrimary,
    secondaryColor: tokens.textSecondary,
    accentColor: tokens.accentStructural,
    emphasisColor: tokens.accentEmphasis,
    fontFamily: profile.fonts.display,
    bodyFontFamily: profile.fonts.body,
    monoFontFamily: profile.fonts.mono,
  }
}

/**
 * Resolve brand knobs for a tool: returns undefined when no brand was requested,
 * and THROWS a clear error when a brand was named but doesn't exist (so the
 * agent can relay the mistake instead of silently styling with defaults).
 */
export function resolveBrandKnobsOrThrow(
  idOrAlias: string | undefined,
  mode?: BrandMode,
): ResolvedBrandKnobs | undefined {
  if (!idOrAlias || idOrAlias.trim().length === 0) return undefined
  const knobs = resolveBrandKnobs(idOrAlias, mode)
  if (!knobs) {
    throw new Error(
      `Unknown brand "${idOrAlias}". Known brands: ${BRAND_IDS.join(', ')}. Omit "brand" to use default styling.`,
    )
  }
  return knobs
}
