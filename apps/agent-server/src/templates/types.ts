/**
 * Motion-graphic template specs (M6.4 — `add_motion_graphic`).
 *
 * A template turns user `content` into a RESOLUTION-INDEPENDENT
 * {@link MotionGraphicSpec}: layers described with center-origin FRACTION
 * geometry (fractions of canvas width/height), fraction font sizes, and
 * keyframe animations in clip-relative SECONDS. The browser handler
 * (`src/features/agent/handlers/add-motion-graphic.ts`) materializes the spec
 * against the live project (fps + canvas dimensions + playhead), creating one
 * stacked timeline track per layer and inserting the items + keyframes in a
 * SINGLE undo entry. This mirrors detect_chapters' split: the server reasons in
 * semantic units, the browser converts to concrete frames/pixels and mutates.
 *
 * This is the SERVER half. It must not import browser types (`@/...`), so the
 * shape-type / easing / animatable-property unions are duplicated here as plain
 * string literals. The browser handler keeps a matching mirror — change both
 * together (same discipline as `bridge/protocol.ts`).
 *
 * SCOPE GUARDRAIL (Hyperframe complement): these are native-editable, zero-cost
 * text + shape + keyframe compositions ONLY. NO avatar / talking-head /
 * stylized / HeyGen-template graphics — those stay on the deferred Hyperframe
 * track and arrive as rendered media via the placeholder→swap pattern. See
 * docs/PHASE-1-PLAN.md §6.13 and the m6-plan memory note.
 */

/** Subset of FreeCut `ShapeType` used by native templates. */
export type MgShapeType = 'rectangle' | 'circle' | 'ellipse'

/** Subset of FreeCut `EasingType` the templates use (basic easings only). */
export type MgEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'hold'

/** Animatable numeric property (subset of FreeCut `BuiltInAnimatableProperty`). */
export type MgAnimatableProperty =
  | 'x'
  | 'y'
  | 'width'
  | 'height'
  | 'opacity'
  | 'rotation'
  | 'fontSize'

/**
 * One keyframe in clip-relative time. Provide EXACTLY ONE of `atSec` (measured
 * forward from the clip start) or `beforeEndSec` (measured backward from the
 * clip end — lets out-animations adapt to any target duration). When both are
 * omitted the keyframe lands at the clip start.
 *
 * `value` units by property:
 *   - opacity   → absolute 0..1
 *   - rotation  → absolute degrees
 *   - x, width  → FRACTION of canvas width  (handler multiplies by width)
 *   - y, height → FRACTION of canvas height (handler multiplies by height)
 *   - fontSize  → FRACTION of canvas height (handler multiplies by height)
 */
export interface MgKeyframe {
  atSec?: number
  beforeEndSec?: number
  value: number
  easing?: MgEasing
}

export interface MgAnimation {
  property: MgAnimatableProperty
  keyframes: MgKeyframe[]
}

interface MgLayerBase {
  /** Display name used for the layer's item label AND its dedicated track. */
  name: string
  /** Center-origin geometry as fractions of the canvas (0,0 = dead center). */
  xFrac: number
  yFrac: number
  widthFrac: number
  heightFrac: number
  /** Base opacity (0..1) before any opacity animation. Default 1. */
  opacity?: number
  /** Keyframe tracks, authored in clip-relative seconds. */
  animations?: MgAnimation[]
}

export interface MgTextLayer extends MgLayerBase {
  kind: 'text'
  text: string
  /** Font size as a fraction of canvas height (scales with resolution). */
  fontSizeFrac: number
  fontWeight?: 'normal' | 'medium' | 'semibold' | 'bold'
  color: string
  textAlign?: 'left' | 'center' | 'right'
  /**
   * Optional font family (Google-Fonts name, e.g. "Fraunces"). The browser
   * materializer applies it to the TextItem and best-effort preloads it; when
   * omitted it falls back to the FreeCut default ("Inter").
   */
  fontFamily?: string
}

export interface MgShapeLayer extends MgLayerBase {
  kind: 'shape'
  shapeType: MgShapeType
  fillColor: string
  /** Corner radius as a fraction of min(canvasWidth, canvasHeight). */
  cornerRadiusFrac?: number
}

export type MgLayer = MgTextLayer | MgShapeLayer

/**
 * A fully content-filled, resolution-independent motion graphic. `layers` are
 * ordered BACK → FRONT: index 0 renders behind everything else, the last layer
 * renders on top. The handler maps that order onto stacked timeline tracks.
 */
export interface MotionGraphicSpec {
  templateId: string
  /** Default on-screen duration (seconds) when the caller omits target_seconds. */
  defaultDurationSec: number
  layers: MgLayer[]
}

/** User content slots (superset across templates; each template reads its own). */
export interface MotionGraphicContent {
  /** lower_third: primary name line. */
  name?: string
  /** lower_third: secondary role/handle line. */
  role?: string
  /** title_card: headline. */
  title?: string
  /** title_card: sub-headline. */
  subtitle?: string
  /** stat_callout: the big value, kept as a string so "$2.5M" / "10,000+" work. */
  value?: string
  /** stat_callout: caption under the value. */
  label?: string
}

/**
 * Optional styling overrides resolved by the TOOL (from an explicit accent color
 * and/or a named brand profile) and handed to `build()`. Each field overrides a
 * template's hardcoded constant; when a field is omitted the template keeps its
 * generic default, so the non-branded path is unchanged. Precedence is applied
 * before this object reaches the template (explicit per-call > brand > default).
 */
export interface MotionGraphicStyle {
  /** Headline / name / value primary-text color. */
  titleColor?: string
  /** Subtitle / role / label secondary-text color. */
  secondaryColor?: string
  /** Structural accent (title-card divider, lower-third role, stat label). */
  accentColor?: string
  /**
   * Full-frame flat background fill. When set, the title_card / stat_callout
   * templates add a backmost background layer so they read as an editorial card
   * (no gradient). lower_third ignores it (it has its own panel).
   */
  backgroundColor?: string
  /** Elevated surface fill — the lower-third panel. */
  surfaceColor?: string
  /** Display font family (Google-Fonts name) applied to every text layer. */
  fontFamily?: string
}

export interface MotionGraphicTemplate {
  id: string
  /** One-line description for tool docs / error messages. */
  description: string
  /** Required content keys; the tool validates these are present + non-empty. */
  requiredContent: Array<keyof MotionGraphicContent>
  build(content: MotionGraphicContent, style?: MotionGraphicStyle): MotionGraphicSpec
}
