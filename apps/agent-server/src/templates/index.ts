/**
 * Motion-graphic template registry (M6.4 — `add_motion_graphic`).
 *
 * Add a template by importing its definition and listing it in `TEMPLATES`.
 * When you add one, also extend the `template` enum in
 * `tools/add-motion-graphic.ts` so the agent can select it.
 */

import { lowerThirdTemplate } from './lower-third.ts'
import { statCalloutTemplate } from './stat-callout.ts'
import { titleCardTemplate } from './title-card.ts'
import type { MotionGraphicTemplate } from './types.ts'

export type {
  MgAnimatableProperty,
  MgAnimation,
  MgEasing,
  MgKeyframe,
  MgLayer,
  MgShapeLayer,
  MgShapeType,
  MgTextLayer,
  MotionGraphicContent,
  MotionGraphicSpec,
  MotionGraphicTemplate,
} from './types.ts'

const TEMPLATES: Record<string, MotionGraphicTemplate> = {
  [lowerThirdTemplate.id]: lowerThirdTemplate,
  [titleCardTemplate.id]: titleCardTemplate,
  [statCalloutTemplate.id]: statCalloutTemplate,
}

/** All registered template ids (for docs / validation). */
export const MOTION_GRAPHIC_TEMPLATE_IDS = Object.keys(TEMPLATES)

export function getMotionGraphicTemplate(id: string): MotionGraphicTemplate | undefined {
  return TEMPLATES[id]
}

export function listMotionGraphicTemplates(): MotionGraphicTemplate[] {
  return Object.values(TEMPLATES)
}
