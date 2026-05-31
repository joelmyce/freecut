/**
 * HyperFrames rich-graphics renderer (free/local HTML→video).
 *
 * Public surface for the agent tools: build a composition's HTML from a template
 * and render it to video bytes via the local HyperFrames CLI. Add a template by
 * exporting its `build…Html` fn and a `render…` convenience here.
 */

import {
  renderHyperframesComposition,
  type HyperframesFormat,
  type HyperframesQuality,
  type RenderCompositionResult,
} from './render.ts'
import { buildKineticTitleHtml, type KineticTitleContent } from './templates/kinetic-title.ts'

export {
  renderHyperframesComposition,
  type HyperframesFormat,
  type HyperframesQuality,
  type RenderCompositionOptions,
  type RenderCompositionResult,
} from './render.ts'
export {
  buildKineticTitleHtml,
  type KineticTitleContent,
  type KineticTitleOptions,
} from './templates/kinetic-title.ts'

export interface RenderKineticTitleOptions extends KineticTitleContent {
  durationSec: number
  width?: number
  height?: number
  fps?: number
  quality?: HyperframesQuality
  format?: HyperframesFormat
  signal?: AbortSignal
}

/** Build + render a kinetic title in one call. */
export async function renderKineticTitle(
  options: RenderKineticTitleOptions,
): Promise<RenderCompositionResult> {
  const html = buildKineticTitleHtml(
    {
      title: options.title,
      subtitle: options.subtitle,
      accentColor: options.accentColor,
      backgroundColor: options.backgroundColor,
    },
    { durationSec: options.durationSec, width: options.width, height: options.height },
  )
  return renderHyperframesComposition({
    html,
    fps: options.fps,
    quality: options.quality,
    format: options.format,
    signal: options.signal,
  })
}
