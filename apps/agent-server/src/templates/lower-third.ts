import type {
  MgAnimation,
  MgLayer,
  MotionGraphicContent,
  MotionGraphicSpec,
  MotionGraphicStyle,
  MotionGraphicTemplate,
} from './types.ts'

/**
 * `lower_third` — a name + optional role identifier card in the lower third,
 * over a rounded panel. The whole group slides in from the left and fades in,
 * holds, then fades out. Built entirely from native text + shape + keyframe
 * primitives, so it inserts instantly, costs nothing, and stays fully editable.
 */

const DEFAULT_ACCENT = '#3B82F6' // blue-500 — themes the role line
const PANEL_COLOR = '#0F172A' // slate-900 — the panel behind the text
const NAME_COLOR = '#FFFFFF'

// Animation timing (clip-relative seconds). The out-fade is anchored to the
// clip END so it adapts to any target duration.
const SLIDE_FRAC = 0.5 // start half a canvas-width to the left of the resting spot
const IN_SLIDE_SEC = 0.45
const IN_FADE_SEC = 0.35
const OUT_FADE_SEC = 0.4

// Layout (center-origin fractions). The card lives in the lower-left.
const PANEL_X = -0.17
const PANEL_Y = 0.34
const TEXT_X = -0.16

/** Classic lower-third move: slide in from the left + fade in, hold, fade out. */
function slideInFade(restingXFrac: number): MgAnimation[] {
  return [
    {
      property: 'x',
      keyframes: [
        { atSec: 0, value: restingXFrac - SLIDE_FRAC, easing: 'ease-out' },
        { atSec: IN_SLIDE_SEC, value: restingXFrac, easing: 'linear' },
      ],
    },
    {
      property: 'opacity',
      keyframes: [
        { atSec: 0, value: 0, easing: 'ease-out' },
        { atSec: IN_FADE_SEC, value: 1, easing: 'linear' },
        { beforeEndSec: OUT_FADE_SEC, value: 1, easing: 'ease-in' },
        { beforeEndSec: 0, value: 0, easing: 'linear' },
      ],
    },
  ]
}

export const lowerThirdTemplate: MotionGraphicTemplate = {
  id: 'lower_third',
  description:
    'Name + optional role identifier card in the lower third over a panel; slides in from the left, holds, fades out.',
  requiredContent: ['name'],
  build(content: MotionGraphicContent, style?: MotionGraphicStyle): MotionGraphicSpec {
    const accent = style?.accentColor?.trim() || DEFAULT_ACCENT
    const panelColor = style?.surfaceColor?.trim() || PANEL_COLOR
    const nameColor = style?.titleColor?.trim() || NAME_COLOR
    const fontFamily = style?.fontFamily?.trim() || undefined
    const name = content.name?.trim() || 'Name'
    const role = content.role?.trim() || undefined

    // BACK → FRONT. Index 0 (the panel) lands on the lowest/backmost track.
    const layers: MgLayer[] = [
      {
        kind: 'shape',
        name: 'Lower third panel',
        shapeType: 'rectangle',
        fillColor: panelColor,
        cornerRadiusFrac: 0.018,
        xFrac: PANEL_X,
        yFrac: PANEL_Y,
        widthFrac: 0.52,
        heightFrac: role ? 0.16 : 0.11,
        opacity: 0.92,
        animations: slideInFade(PANEL_X),
      },
      {
        kind: 'text',
        name: 'Lower third name',
        text: name,
        color: nameColor,
        fontFamily,
        fontWeight: 'bold',
        textAlign: 'left',
        fontSizeFrac: 0.045,
        xFrac: TEXT_X,
        yFrac: role ? PANEL_Y - 0.032 : PANEL_Y,
        widthFrac: 0.46,
        heightFrac: 0.08,
        animations: slideInFade(TEXT_X),
      },
    ]

    if (role) {
      layers.push({
        kind: 'text',
        name: 'Lower third role',
        text: role,
        color: accent,
        fontFamily,
        fontWeight: 'medium',
        textAlign: 'left',
        fontSizeFrac: 0.026,
        xFrac: TEXT_X,
        yFrac: PANEL_Y + 0.042,
        widthFrac: 0.46,
        heightFrac: 0.05,
        animations: slideInFade(TEXT_X),
      })
    }

    return {
      templateId: lowerThirdTemplate.id,
      defaultDurationSec: 5,
      layers,
    }
  },
}
