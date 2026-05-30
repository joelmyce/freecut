import type {
  MgAnimation,
  MgLayer,
  MotionGraphicContent,
  MotionGraphicSpec,
  MotionGraphicTemplate,
} from './types.ts'

/**
 * `stat_callout` — a big hero value (kept as a string, so "$2.5M" / "10,000+" /
 * "98%" all work) with an optional caption beneath. The value POPS in: a font
 * scale that overshoots then settles, a fast fade, and a small rise; the label
 * fades up just behind it. This is the native stand-in for an "animated
 * counter" — the value lands with punch but does NOT tick through numbers (that
 * would need a renderer feature; see docs/PHASE-1-PLAN.md §6.13).
 */

const DEFAULT_ACCENT = '#3B82F6'
const VALUE_COLOR = '#FFFFFF'

const OUT_FADE_SEC = 0.45
const VALUE_SIZE_FRAC = 0.17
const VALUE_Y = -0.03

/** opacity: fade in (after `delaySec`), hold, fade out (anchored to clip end). */
function fadeInOut(delaySec: number, inSec: number): MgAnimation {
  return {
    property: 'opacity',
    keyframes: [
      { atSec: delaySec, value: 0, easing: 'ease-out' },
      { atSec: delaySec + inSec, value: 1, easing: 'linear' },
      { beforeEndSec: OUT_FADE_SEC, value: 1, easing: 'ease-in' },
      { beforeEndSec: 0, value: 0, easing: 'linear' },
    ],
  }
}

export const statCalloutTemplate: MotionGraphicTemplate = {
  id: 'stat_callout',
  description:
    'A big hero value with an optional caption that pops in (font-scale overshoot + fade + rise). Native stand-in for a counter — punchy, but does not tick.',
  requiredContent: ['value'],
  build(content: MotionGraphicContent): MotionGraphicSpec {
    const accent = content.accentColor?.trim() || DEFAULT_ACCENT
    const value = content.value?.trim() || '100%'
    const label = content.label?.trim() || undefined

    // BACK → FRONT. Value behind so the (front) label never gets clipped by it.
    const layers: MgLayer[] = [
      {
        kind: 'text',
        name: 'Stat value',
        text: value,
        color: VALUE_COLOR,
        fontWeight: 'bold',
        textAlign: 'center',
        fontSizeFrac: VALUE_SIZE_FRAC,
        xFrac: 0,
        yFrac: VALUE_Y,
        widthFrac: 0.86,
        heightFrac: 0.3,
        animations: [
          {
            // Pop: 60% → 112% (overshoot) → 100%.
            property: 'fontSize',
            keyframes: [
              { atSec: 0, value: VALUE_SIZE_FRAC * 0.6, easing: 'ease-out' },
              { atSec: 0.16, value: VALUE_SIZE_FRAC * 1.12, easing: 'ease-in-out' },
              { atSec: 0.3, value: VALUE_SIZE_FRAC, easing: 'ease-out' },
            ],
          },
          {
            // Small rise into place.
            property: 'y',
            keyframes: [
              { atSec: 0, value: VALUE_Y + 0.02, easing: 'ease-out' },
              { atSec: 0.3, value: VALUE_Y, easing: 'linear' },
            ],
          },
          fadeInOut(0, 0.2),
        ],
      },
    ]

    if (label) {
      layers.push({
        kind: 'text',
        name: 'Stat label',
        text: label,
        color: accent,
        fontWeight: 'medium',
        textAlign: 'center',
        fontSizeFrac: 0.038,
        xFrac: 0,
        yFrac: 0.1,
        widthFrac: 0.7,
        heightFrac: 0.08,
        animations: [
          {
            property: 'y',
            keyframes: [
              { atSec: 0.2, value: 0.13, easing: 'ease-out' },
              { atSec: 0.55, value: 0.1, easing: 'linear' },
            ],
          },
          fadeInOut(0.2, 0.25),
        ],
      })
    }

    return {
      templateId: statCalloutTemplate.id,
      defaultDurationSec: 4,
      layers,
    }
  },
}
