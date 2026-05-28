import { describe, expect, it, vi } from 'vitest'
import { KokoroBrowserProxyTtsProvider } from './kokoro.ts'
import type { ProviderContext } from '../types.ts'

type InvokeFn = (action: string, args: unknown, signal: AbortSignal) => Promise<unknown>

function makeInvoke<T>(result: T) {
  // Typed inner signature so `mock.calls[i]` destructures into the bridge
  // tuple `[action, args, signal]` — `vi.fn()` with no signature defaults
  // to inferring `[]` and `.calls[i][0]` becomes a TS error.
  const fn: InvokeFn = async () => result as unknown
  return vi.fn(fn)
}

function ctx(invoke: ReturnType<typeof makeInvoke>): ProviderContext {
  return {
    bridge: { invokeBrowserAction: invoke },
    signal: new AbortController().signal,
  } as unknown as ProviderContext
}

describe('KokoroBrowserProxyTtsProvider', () => {
  it('always reports available — browser readiness is observed via bridge errors', () => {
    expect(new KokoroBrowserProxyTtsProvider().isAvailable()).toBe(true)
  })

  it('delegates synthesize to the browser bridge with the request shape kokoro-tts-service expects', async () => {
    const invoke = makeInvoke({
      audioBytesBase64: 'AAAA',
      mimeType: 'audio/wav',
      durationSec: 1.5,
      modelUsed: 'fp32',
    })
    const provider = new KokoroBrowserProxyTtsProvider()

    const result = await provider.synthesize(
      { text: 'hello world', voiceId: 'af_heart', speed: 1.2, model: 'fp32' },
      ctx(invoke),
    )

    expect(invoke).toHaveBeenCalledOnce()
    const call = invoke.mock.calls[0]
    expect(call).toBeDefined()
    expect(call![0]).toBe('synthesize-voiceover-local')
    expect(call![1]).toMatchObject({
      text: 'hello world',
      voiceId: 'af_heart',
      speed: 1.2,
      model: 'fp32',
    })
    expect(result.audioBytesBase64).toBe('AAAA')
    expect(result.mimeType).toBe('audio/wav')
    expect(result.durationSec).toBe(1.5)
    expect(result.modelUsed).toBe('fp32')
  })

  it('forwards a default speed of 1.0 when none was supplied', async () => {
    const invoke = makeInvoke({
      audioBytesBase64: '',
      mimeType: 'audio/wav',
      durationSec: 0,
      modelUsed: 'fp32',
    })
    const provider = new KokoroBrowserProxyTtsProvider()

    await provider.synthesize({ text: 'hi', voiceId: 'af_heart' }, ctx(invoke))

    const call = invoke.mock.calls[0]
    expect(call).toBeDefined()
    const payload = call![1] as { speed?: number }
    expect(payload.speed).toBe(1.0)
  })

  it('emits a delegating-to-browser progress stage', async () => {
    const invoke = makeInvoke({
      audioBytesBase64: '',
      mimeType: 'audio/wav',
      durationSec: 0,
      modelUsed: 'fp32',
    })
    const provider = new KokoroBrowserProxyTtsProvider()
    const onProgress = vi.fn()

    await provider.synthesize({ text: 'hi', voiceId: 'af_heart' }, {
      bridge: { invokeBrowserAction: invoke },
      signal: new AbortController().signal,
      onProgress,
    } as unknown as ProviderContext)

    expect(onProgress).toHaveBeenCalledWith({ stage: 'delegating-to-browser' })
  })
})
