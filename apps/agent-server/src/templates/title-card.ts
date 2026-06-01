import type {
  MgAnimation,
  MgLayer,
  MotionGraphicContent,
  MotionGraphicSpec,
  MotionGraphicStyle,
  MotionGraphicTemplate,
} from './types.ts'

/**
 * `title_card` — a centered headline with an optional sub-headline and a short
 * accent divider that grows out from the center. The title fades + scales in
 * (subtle), the divider wipes open, the subtitle fades up; everything holds,
 * then fades out. Native text + shape + keyframes only.
 */

const DEFAULT_ACCENT = '#3B82F6'
const TITLE_COLOR = '#FFFFFF'
const SUBTITLE_COLOR = '#CBD5E1' // slate-300

const IN_FADE_SEC = 0.4
const IN_GROW_SEC = 0.45
const OUT_FADE_SEC = 0.45

const DIVIDER_WIDTH_FRAC = 0.12

/** opacity: fade in (after `delaySec`), hold, fade out (anchored to clip end). */
function fadeInOut(delaySec = 0): MgAnimation {
  return {
    property: 'opacity',
    keyframes: [
      { atSec: delaySec, value: 0, easing: 'ease-out' },
      { atSec: delaySec + 0.35, value: 1, easing: 'linear' },
      { beforeEndSec: OUT_FADE_SEC, value: 1, easing: 'ease-in' },
      { beforeEndSec: 0, value: 0, easing: 'linear' },
    ],
  }
}

export const titleCardTemplate: MotionGraphicTemplate = {
  id: 'title_card',
  description:
    'Centered headline with an optional sub-headline and a growing accent divider; fades + scales in, holds, fades out.',
  requiredContent: ['title'],
  build(content: MotionGraphicContent, style?: MotionGraphicStyle): MotionGraphicSpec {
    const accent = style?.accentColor?.trim() || DEFAULT_ACCENT
    const titleColor = style?.titleColor?.trim() || TITLE_COLOR
    const subtitleColor = style?.secondaryColor?.trim() || SUBTITLE_COLOR
    const backgroundColor = style?.backgroundColor?.trim() || undefined
    const fontFamily = style?.fontFamily?.trim() || undefined
    const title = content.title?.trim() || 'Title'
    const subtitle = content.subtitle?.trim() || undefined

    const titleY = subtitle ? -0.05 : -0.01
    const dividerY = subtitle ? 0.025 : 0.06
    const titleSizeFrac = 0.085

    // BACK → FRONT. Optional flat background (brand) sits behind everything so
    // the card reads as an editorial slate; the divider sits behind the text.
    const layers: MgLayer[] = []

    if (backgroundColor) {
      layers.push({
        kind: 'shape',
        name: 'Background',
        shapeType: 'rectangle',
        fillColor: backgroundColor,
        xFrac: 0,
        yFrac: 0,
        widthFrac: 1,
        heightFrac: 1,
        animations: [fadeInOut()],
      })
    }

    layers.push(
      {
        kind: 'shape',
        name: 'Title accent',
        shapeType: 'rectangle',
        fillColor: accent,
        cornerRadiusFrac: 0.004,
        xFrac: 0,
        yFrac: dividerY,
        widthFrac: DIVIDER_WIDTH_FRAC,
        heightFrac: 0.006,
        animations: [
          {
            property: 'width',
            keyframes: [
              { atSec: 0, value: 0, easing: 'ease-out' },
              { atSec: IN_FADE_SEC, value: DIVIDER_WIDTH_FRAC, easing: 'linear' },
            ],
          },
          fadeInOut(),
        ],
      },
      {
        kind: 'text',
        name: 'Title',
        text: title,
        color: titleColor,
        fontFamily,
        fontWeight: 'bold',
        textAlign: 'center',
        fontSizeFrac: titleSizeFrac,
        xFrac: 0,
        yFrac: titleY,
        widthFrac: 0.84,
        heightFrac: 0.2,
        animations: [
          {
            // Subtle scale-in: grow from 92% to full size as it fades in.
            property: 'fontSize',
            keyframes: [
              { atSec: 0, value: titleSizeFrac * 0.92, easing: 'ease-out' },
              { atSec: IN_GROW_SEC, value: titleSizeFrac, easing: 'linear' },
            ],
          },
          fadeInOut(),
        ],
      },
    )

    if (subtitle) {
      layers.push({
        kind: 'text',
        name: 'Subtitle',
        text: subtitle,
        color: subtitleColor,
        fontFamily,
        fontWeight: 'normal',
        textAlign: 'center',
        fontSizeFrac: 0.032,
        xFrac: 0,
        yFrac: 0.1,
        widthFrac: 0.7,
        heightFrac: 0.08,
        animations: [
          // Fade up: rise from +0.03 of height into place while fading in.
          {
            property: 'y',
            keyframes: [
              { atSec: 0.15, value: 0.13, easing: 'ease-out' },
              { atSec: 0.55, value: 0.1, easing: 'linear' },
            ],
          },
          fadeInOut(0.15),
        ],
      })
    }

    return {
      templateId: titleCardTemplate.id,
      defaultDurationSec: 4,
      layers,
    }
  },
}
