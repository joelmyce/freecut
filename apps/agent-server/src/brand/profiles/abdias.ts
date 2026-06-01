import type { BrandProfile } from '../types.ts'

/**
 * Abdias.Marketing — "The Editorial Architect" v3.0 (April 2026).
 *
 * Hand-authored from the brand style guide (mirrored in the repo at
 * `brand/abdias/style-guide.html`). Two official modes: Light "Paper" (default —
 * editorial / creator content) and Dark "Ink" (product / technical surfaces).
 *
 * Accent split that matters for fidelity: Signal Blue is the STRUCTURAL accent
 * (dividers, role lines) → maps onto the tools' existing accent knob. Terracotta
 * is the EMPHASIS accent ("like salt" — the dot, one italic word) → reserved for
 * Tier-2 editorial templates; never used as a fill.
 */
export const abdiasProfile: BrandProfile = {
  id: 'abdias',
  name: 'Abdias.Marketing',
  aliases: [
    'abdias',
    'abdias marketing',
    'abdias.marketing',
    'abdias brand',
    'the abdias brand',
    'my brand',
    'my channel brand',
    'channel brand',
    'on brand',
    'on-brand',
    'branded',
    'editorial architect',
  ],
  defaultMode: 'light',
  fonts: {
    display: 'Fraunces', // headlines — serif, weight 500, + italic emphasis
    body: 'Inter', // body / UI / labels
    mono: 'JetBrains Mono', // technical / data / timestamps
    italicEmphasis: true,
  },
  modes: {
    // Light "Paper" — warm editorial. Default for creator content.
    light: {
      background: '#F5F0E8', // Paper
      surface: '#FAF7F2', // Paper Soft
      textPrimary: '#0B1220', // Ink
      textSecondary: '#3D4A63', // Slate (warm)
      accentStructural: '#2B5CE6', // Signal Blue
      accentEmphasis: '#B8553A', // Terracotta
    },
    // Dark "Ink" — for product / technical surfaces. Accents lighten for contrast.
    dark: {
      background: '#0B1220', // Deep Ink
      surface: '#1A2540', // Midnight
      textPrimary: '#F5F0E8', // Paper
      textSecondary: '#B8C0D0', // Paper Muted
      accentStructural: '#7FA1F0', // lighter Signal Blue (contrast on ink)
      accentEmphasis: '#D87B5A', // Clay (terracotta loses contrast on ink)
    },
  },
  rules: {
    italicWordsPerHeadline: 1,
    noPureBlackWhite: true,
    noGradient: true,
    noEmoji: true,
    accentBudgetPct: 5, // 80/15/5
  },
  wordmark: {
    text: 'Abdias.Marketing',
    dotColor: '#B8553A', // the terracotta dot
    italicPart: 'Marketing', // "Abdias" roman + "." + "Marketing" italic
  },
  language: 'es',
}
