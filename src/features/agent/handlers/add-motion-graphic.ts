/**
 * Browser-side handler for `add-motion-graphic` (M6.4 — agent add_motion_graphic).
 *
 * Mutating. Receives a resolution-INDEPENDENT MotionGraphicSpec from the server
 * (fraction geometry + clip-relative animations), materializes it against the
 * live project — fps, canvas dimensions, playhead — into concrete text/shape
 * items + keyframes, then inserts them via `insertMotionGraphic` (one dedicated
 * stacked track per layer, single undo entry).
 *
 * The spec types mirror `apps/agent-server/src/templates/types.ts` and must be
 * kept in sync by hand (same discipline as `bridge/protocol.ts`). The pure
 * resolver `resolveMotionGraphicItems` is exported for unit tests — the handler
 * only gathers live project state and delegates.
 */

import type { ShapeItem, ShapeType, TextItem, TimelineItem } from '@/types/timeline'
import type { EasingType } from '@/types/keyframe'
import { usePlaybackStore } from '@/shared/state/playback'
import { createLogger } from '@/shared/logging/logger'
import { useProjectStore } from '../deps/projects-contract'
import {
  insertMotionGraphic,
  useTimelineSettingsStore,
  type KeyframeAddPayload,
  type MotionGraphicLayer,
} from '../deps/timeline-contract'
import type { BrowserActionHandler } from './types'

const log = createLogger('agent-handler-add-motion-graphic')

// --- Mirror of apps/agent-server/src/templates/types.ts (keep in sync) ---
type MgShapeType = 'rectangle' | 'circle' | 'ellipse'
type MgEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'hold'
type MgAnimatableProperty = 'x' | 'y' | 'width' | 'height' | 'opacity' | 'rotation' | 'fontSize'

interface MgKeyframe {
  atSec?: number
  beforeEndSec?: number
  value: number
  easing?: MgEasing
}
interface MgAnimation {
  property: MgAnimatableProperty
  keyframes: MgKeyframe[]
}
interface MgLayerBase {
  name: string
  xFrac: number
  yFrac: number
  widthFrac: number
  heightFrac: number
  opacity?: number
  animations?: MgAnimation[]
}
interface MgTextLayer extends MgLayerBase {
  kind: 'text'
  text: string
  fontSizeFrac: number
  fontWeight?: 'normal' | 'medium' | 'semibold' | 'bold'
  color: string
  textAlign?: 'left' | 'center' | 'right'
}
interface MgShapeLayer extends MgLayerBase {
  kind: 'shape'
  shapeType: MgShapeType
  fillColor: string
  cornerRadiusFrac?: number
}
type MgLayer = MgTextLayer | MgShapeLayer
interface MotionGraphicSpec {
  templateId: string
  defaultDurationSec: number
  layers: MgLayer[]
}
// --- end mirror ---

interface AddMotionGraphicArgs {
  spec: MotionGraphicSpec
  targetSeconds?: number
  startSeconds?: number
}

interface AddMotionGraphicResult {
  insertedItemCount: number
  insertedTrackCount: number
  fromSeconds: number
  durationSeconds: number
  layerLabels: string[]
}

/** Live project values needed to turn a spec into concrete timeline items. */
export interface MotionGraphicEnv {
  fps: number
  canvasWidth: number
  canvasHeight: number
  fromFrame: number
  durationInFrames: number
}

/** Minimum on-screen duration so the in/out animations always have room to play. */
const MIN_DURATION_SEC = 1.5

function newId(): string {
  return crypto.randomUUID()
}

function resolveKeyframeFrame(kf: MgKeyframe, env: MotionGraphicEnv): number {
  const lastFrame = Math.max(0, env.durationInFrames - 1)
  const frame =
    kf.beforeEndSec !== undefined
      ? env.durationInFrames - Math.round(kf.beforeEndSec * env.fps)
      : Math.round((kf.atSec ?? 0) * env.fps)
  return Math.max(0, Math.min(lastFrame, frame))
}

function resolveKeyframeValue(
  property: MgAnimatableProperty,
  value: number,
  env: MotionGraphicEnv,
): number {
  switch (property) {
    case 'x':
    case 'width':
      return value * env.canvasWidth
    case 'y':
    case 'height':
    case 'fontSize':
      return value * env.canvasHeight
    case 'opacity':
    case 'rotation':
      return value
  }
}

function buildKeyframePayloads(
  itemId: string,
  layer: MgLayer,
  env: MotionGraphicEnv,
): KeyframeAddPayload[] {
  if (!layer.animations || layer.animations.length === 0) return []
  const payloads: KeyframeAddPayload[] = []
  for (const anim of layer.animations) {
    for (const kf of anim.keyframes) {
      payloads.push({
        itemId,
        property: anim.property,
        frame: resolveKeyframeFrame(kf, env),
        value: resolveKeyframeValue(anim.property, kf.value, env),
        easing: (kf.easing ?? 'linear') as EasingType,
      })
    }
  }
  return payloads
}

/**
 * Pure resolver: spec + live env → concrete layers (item + keyframes + track
 * name), ordered BACK → FRONT. No store access — unit-testable in isolation.
 */
export function resolveMotionGraphicItems(
  spec: MotionGraphicSpec,
  env: MotionGraphicEnv,
): MotionGraphicLayer[] {
  const minDim = Math.min(env.canvasWidth, env.canvasHeight)

  return spec.layers.map((layer) => {
    const id = newId()
    const transform = {
      x: layer.xFrac * env.canvasWidth,
      y: layer.yFrac * env.canvasHeight,
      width: Math.max(1, layer.widthFrac * env.canvasWidth),
      height: Math.max(1, layer.heightFrac * env.canvasHeight),
      rotation: 0,
      opacity: layer.opacity ?? 1,
    }

    let item: TimelineItem
    if (layer.kind === 'text') {
      const textItem: TextItem = {
        id,
        type: 'text',
        trackId: '',
        from: env.fromFrame,
        durationInFrames: env.durationInFrames,
        label: layer.name,
        text: layer.text,
        fontSize: Math.max(1, Math.round(layer.fontSizeFrac * env.canvasHeight)),
        fontFamily: 'Inter',
        fontWeight: layer.fontWeight ?? 'normal',
        fontStyle: 'normal',
        color: layer.color,
        textAlign: layer.textAlign ?? 'center',
        verticalAlign: 'middle',
        lineHeight: 1.2,
        letterSpacing: 0,
        transform,
      }
      item = textItem
    } else {
      const shapeItem: ShapeItem = {
        id,
        type: 'shape',
        trackId: '',
        from: env.fromFrame,
        durationInFrames: env.durationInFrames,
        label: layer.name,
        shapeType: layer.shapeType as ShapeType,
        fillColor: layer.fillColor,
        strokeWidth: 0,
        cornerRadius:
          layer.cornerRadiusFrac !== undefined
            ? Math.max(0, Math.round(layer.cornerRadiusFrac * minDim))
            : undefined,
        transform,
      }
      item = shapeItem
    }

    return { item, keyframes: buildKeyframePayloads(id, layer, env), trackName: layer.name }
  })
}

export const addMotionGraphicHandler: BrowserActionHandler = async (rawArgs) => {
  const args = rawArgs as AddMotionGraphicArgs
  const spec = args.spec
  if (!spec || !Array.isArray(spec.layers) || spec.layers.length === 0) {
    throw new Error('add-motion-graphic requires a spec with at least one layer')
  }

  const fpsRaw = useTimelineSettingsStore.getState().fps
  const fps = Number.isFinite(fpsRaw) && fpsRaw > 0 ? fpsRaw : 30

  const project = useProjectStore.getState().currentProject
  const canvasWidth = project?.metadata.width ?? 1920
  const canvasHeight = project?.metadata.height ?? 1080

  const durationSec = Math.max(MIN_DURATION_SEC, args.targetSeconds ?? spec.defaultDurationSec)
  const durationInFrames = Math.max(1, Math.round(durationSec * fps))

  const fromFrame =
    args.startSeconds !== undefined && Number.isFinite(args.startSeconds)
      ? Math.max(0, Math.round(args.startSeconds * fps))
      : Math.max(0, usePlaybackStore.getState().currentFrame)

  const env: MotionGraphicEnv = { fps, canvasWidth, canvasHeight, fromFrame, durationInFrames }
  const layers = resolveMotionGraphicItems(spec, env)
  const result = insertMotionGraphic(layers)

  log.debug(
    `inserted ${result.itemIds.length} items on ${result.trackIds.length} tracks for "${spec.templateId}"`,
  )

  return {
    insertedItemCount: result.itemIds.length,
    insertedTrackCount: result.trackIds.length,
    fromSeconds: fromFrame / fps,
    durationSeconds: durationInFrames / fps,
    layerLabels: spec.layers.map((layer) => layer.name),
  } satisfies AddMotionGraphicResult
}
