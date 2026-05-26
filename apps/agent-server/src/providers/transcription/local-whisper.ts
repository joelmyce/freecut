import type { ProviderContext } from '../types.ts'
import type { Transcript, TranscriptionInput, TranscriptionProvider } from './types.ts'

/**
 * Delegates to the browser's existing `mediaTranscriptionService`. The actual
 * inference runs in the browser (transformers.js + WebGPU), so the server's
 * job here is purely to forward the request through the bridge and await the
 * resulting transcript. Browser saves the transcript via its own pipeline.
 *
 * `isAvailable()` always returns `true` because we can't observe browser
 * connection state from the provider — the bridge call itself will fail if
 * no browser is attached, which the router treats as a transient error
 * rather than a config issue.
 */
export class LocalWhisperBrowserProxy implements TranscriptionProvider {
  readonly id = 'local-whisper' as const

  isAvailable(): boolean {
    return true
  }

  async transcribe(input: TranscriptionInput, ctx: ProviderContext): Promise<Transcript> {
    ctx.onProgress?.({ stage: 'delegating-to-browser' })
    return await ctx.bridge.invokeBrowserAction<Transcript>(
      'transcribe-local',
      {
        mediaId: input.assetId,
        language: input.language,
        model: input.model,
      },
      ctx.signal,
    )
  }
}
