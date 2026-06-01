/**
 * Brand profile schema (BRAND PROFILE milestone — A+B).
 *
 * A brand profile encodes the user's channel brand ONCE so the agent can apply
 * it on request ("do X on the Abdias brand") and otherwise leave styling at the
 * tools' generic defaults. The profile is the SERVER's source of truth; the
 * browser never sees brand tokens — it only receives concrete color/font
 * strings already baked into the specs it materializes.
 *
 * Resolution flattens a (profile, mode) pair into {@link ResolvedBrandKnobs} —
 * the single tool-ready shape every styling tool consumes (today
 * add_kinetic_title + add_motion_graphic; later the HyperFrames feature-menu).
 * That reuse is deliberate: see the `hyperframes-feature-menu` memory note.
 */

export type BrandMode = 'light' | 'dark'

/** Concrete color tokens for one mode (light "Paper" or dark "Ink"). */
export interface BrandModeTokens {
  /** Full-frame surface — e.g. a title-card background. */
  background: string
  /** Elevated surface — panels, lower-third scrim, cards. */
  surface: string
  /** Primary text / headline color on this mode's surfaces. */
  textPrimary: string
  /** Secondary / body / role text. */
  textSecondary: string
  /** Structural accent — dividers, rules, the role line. (Signal-Blue family.) */
  accentStructural: string
  /**
   * Emphasis accent — "like salt": the logo dot, one italic word. NEVER a fill
   * or mass. (Terracotta / Clay family.) Tier-2 editorial templates only.
   */
  accentEmphasis: string
}

export interface BrandFonts {
  /** Display / headline font (Google-Fonts family name). */
  display: string
  /** Body / UI / label font. */
  body: string
  /** Technical / data / timestamp font (for future chart/counter tools). */
  mono: string
  /** Brand rule: emphasize exactly one word per headline in italic (Tier-2). */
  italicEmphasis: boolean
}

export interface BrandRules {
  italicWordsPerHeadline: number
  noPureBlackWhite: boolean
  noGradient: boolean
  noEmoji: boolean
  /** Combined accent budget as a % of the composition (80/15/5 rule → 5). */
  accentBudgetPct: number
}

/**
 * Wordmark spec. Unused by v1 styling — present so the future logo-reveal
 * HyperFrames tool has the data without a schema migration.
 */
export interface BrandWordmark {
  text: string
  /** Color of the dot/period separator. */
  dotColor: string
  /** Substring of `text` rendered in italic (e.g. "Marketing"). */
  italicPart?: string
}

export interface BrandProfile {
  id: string
  name: string
  /** Lowercase phrases that select this brand when named in chat. */
  aliases: readonly string[]
  defaultMode: BrandMode
  fonts: BrandFonts
  modes: Record<BrandMode, BrandModeTokens>
  rules: BrandRules
  wordmark?: BrandWordmark
  /** Content-language hint (e.g. "es"). Unused by v1 styling. */
  language?: string
}

/**
 * Flattened, tool-ready styling knobs for a (profile, mode) pair. This is the
 * single shape every styling tool consumes — add a HyperFrames tool later and
 * it reads from here. Color fields are CSS color strings; font fields are
 * Google-Fonts family names.
 */
export interface ResolvedBrandKnobs {
  brandId: string
  mode: BrandMode
  /** Full-frame background (title cards). */
  backgroundColor: string
  /** Panel / scrim / card surface (lower thirds). */
  surfaceColor: string
  /** Headline / primary text. */
  titleColor: string
  /** Subtitle / secondary / role text. */
  secondaryColor: string
  /** Structural accent (dividers, role line) — maps onto existing accent knobs. */
  accentColor: string
  /** Emphasis accent ("salt") — Tier-2 editorial only; never a fill. */
  emphasisColor: string
  /** Display / headline font family. */
  fontFamily: string
  /** Body font family. */
  bodyFontFamily: string
  /** Technical / data font family (future chart/counter tools). */
  monoFontFamily: string
}
