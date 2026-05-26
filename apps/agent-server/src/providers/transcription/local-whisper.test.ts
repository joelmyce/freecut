import { describe, expect, it, vi } from 'vitest'
import { LocalWhisperBrowserProxy } from './local-whisper.ts'
import type { BrowserActionBridge, ProviderContext } from '../types.ts'
import type { Transcript } from './types.ts'

function makeBridge(
  impl?: (action: string, args: unknown, signal: AbortSignal) => Promise<unknown>,
): BrowserActionBridge {
  return {
    invokeBrowserAction: vi.fn(
      impl ?? (async () => ({})),
    ) as BrowserActionBridge['invokeBrowserAction'],
  }
}

describe('LocalWhisperBrowserProxy', () => {
  it('is always available', () => {
    expect(new LocalWhisperBrowserProxy().isAvailable()).toBe(true)
  })

  it('delegates to the browser via transcribe-local with matching args', async () => {
    const transcript: Transcript = {
      text: 'hello world',
      segments: [{ text: 'hello world', start: 0, end: 1.5 }],
      language: 'en',
      durationSec: 1.5,
    }
    const bridge = makeBridge(async () => transcript)
    const ctx: ProviderContext = { bridge, signal: new AbortController().signal }
    const provider = new LocalWhisperBrowserProxy()

    const result = await provider.transcribe(
      { assetId: 'media-123', language: 'en', model: 'tiny' },
      ctx,
    )

    expect(bridge.invokeBrowserAction).toHaveBeenCalledTimes(1)
    expect(bridge.invokeBrowserAction).toHaveBeenCalledWith(
      'transcribe-local',
      { mediaId: 'media-123', language: 'en', model: 'tiny' },
      ctx.signal,
    )
    expect(result).toEqual(transcript)
  })

  it('forwards the abort signal to the bridge call', async () => {
    const controller = new AbortController()
    const seenSignal = vi.fn()
    const bridge = makeBridge(async (_action, _args, signal) => {
      seenSignal(signal)
      return { text: '', segments: [], durationSec: 0 } satisfies Transcript
    })
    const provider = new LocalWhisperBrowserProxy()

    await provider.transcribe({ assetId: 'm1' }, { bridge, signal: controller.signal })

    expect(seenSignal).toHaveBeenCalledWith(controller.signal)
  })

  it('emits a delegating-to-browser progress event', async () => {
    const bridge = makeBridge(async () => ({
      text: '',
      segments: [],
      durationSec: 0,
    }))
    const onProgress = vi.fn()
    const provider = new LocalWhisperBrowserProxy()

    await provider.transcribe(
      { assetId: 'm1' },
      { bridge, signal: new AbortController().signal, onProgress },
    )

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'delegating-to-browser' }),
    )
  })
})
