import type { ProviderContext } from '../types.ts'
import type { TtsInput, TtsProvider, TtsResult } from './types.ts'

/**
 * Delegates speech synthesis to the browser's existing `kokoroTtsService`
 * (Kokoro v1.0 ONNX, runs on WebGPU in the renderer). The actual model
 * inference happens in the browser tab; the server's job is to forward
 * the request through the bridge and return the resulting audio bytes
 * to the tool, which then hands them to `insert-voiceover` for the
 * media-library import.
 *
 * `isAvailable()` always returns `true` for the same reason as the local-
 * whisper proxy — we can't observe browser capability from the server
 * side, and the bridge call surfaces "no browser attached" as a transient
 * error rather than a config issue.
 */
export class KokoroBrowserProxyTtsProvider implements TtsProvider {
  readonly id = 'kokoro' as const

  isAvailable(): boolean {
    return true
  }

  async synthesize(input: TtsInput, ctx: ProviderContext): Promise<TtsResult> {
    ctx.onProgress?.({ stage: 'delegating-to-browser' })
    return await ctx.bridge.invokeBrowserAction<TtsResult>(
      'synthesize-voiceover-local',
      {
        text: input.text,
        voiceId: input.voiceId,
        speed: input.speed ?? 1.0,
        model: input.model,
      },
      ctx.signal,
    )
  }
}
