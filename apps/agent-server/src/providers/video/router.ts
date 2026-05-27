import type { VideoGenerationProvider, VideoGenerationStrategy } from './types.ts'

export interface PickVideoProviderResult {
  provider: VideoGenerationProvider
  reason: string
}

/**
 * Choose a video generation provider for the requested strategy. Phase 1
 * only ships fal; kie is reserved for M3+ once we have a second working
 * provider. `auto` falls through fal → kie in that order.
 */
export function pickVideoGenerationProvider(
  providers: ReadonlyArray<VideoGenerationProvider>,
  strategy: VideoGenerationStrategy,
): PickVideoProviderResult {
  const findAvailable = (id: VideoGenerationProvider['id']) =>
    providers.find((p) => p.id === id && p.isAvailable())

  if (strategy === 'fal') {
    const fal = findAvailable('fal')
    if (!fal) throw new Error('fal video provider is not available (missing FAL_API_KEY)')
    return { provider: fal, reason: 'explicit strategy: fal' }
  }

  if (strategy === 'kie') {
    const kie = findAvailable('kie')
    if (!kie) throw new Error('kie video provider is not available')
    return { provider: kie, reason: 'explicit strategy: kie' }
  }

  const fal = findAvailable('fal')
  if (fal) return { provider: fal, reason: 'auto: fal available' }

  const kie = findAvailable('kie')
  if (kie) return { provider: kie, reason: 'auto: fal unavailable, falling back to kie' }

  throw new Error('No video generation provider is available')
}
