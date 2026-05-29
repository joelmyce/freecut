import type { ConfirmationCostEstimate } from '../../bridge/protocol.ts'

/**
 * Rough per-second USD rates for the M5.2 spend-confirmation card ONLY.
 *
 * These are ADVISORY estimates. fal sets the real price at render time and
 * does NOT return it in its queue response (see `FalVideoProvider` — the
 * result parser never captures a cost field), so the card always labels this
 * `isEstimate: true` and renders it as "~$X.XX est.". Verify/adjust against
 * current fal pricing (https://fal.ai/models/fal-ai/kling-video/...) if
 * precise figures start to matter; nothing is billed off these numbers.
 *
 * Tier is detected by substring on the fal model id:
 *   - "/pro/"      → premium Kling tier
 *   - "/standard/" → standard Kling tier (the tool defaults)
 *   - otherwise    → unknown model, conservative middle rate
 */
const PRO_USD_PER_SEC = 0.09
const STANDARD_USD_PER_SEC = 0.05
const FALLBACK_USD_PER_SEC = 0.07

/** Snap to a sane positive duration; Kling clips are 3–15s. */
const FALLBACK_DURATION_SEC = 5

/**
 * Estimate the USD cost of a video generation for the confirmation card.
 * Always returns `isEstimate: true` — never treat as a billed amount.
 */
export function estimateVideoGenerationCost(
  model: string,
  durationSec: number,
): ConfirmationCostEstimate {
  const seconds =
    Number.isFinite(durationSec) && durationSec > 0 ? durationSec : FALLBACK_DURATION_SEC
  const perSec = /\/pro\//.test(model)
    ? PRO_USD_PER_SEC
    : /\/standard\//.test(model)
      ? STANDARD_USD_PER_SEC
      : FALLBACK_USD_PER_SEC
  const amount = Math.round(perSec * seconds * 100) / 100
  return { amount, currency: 'USD', isEstimate: true }
}
