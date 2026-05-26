import { describe, expect, it, vi } from 'vitest'
import { createTranscribeTool } from './transcribe.ts'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import type { TranscriptionProvider } from '../providers/transcription/index.ts'

function mockProvider(
  id: TranscriptionProvider['id'],
  available: boolean,
  transcribeImpl?: TranscriptionProvider['transcribe'],
): TranscriptionProvider {
  return {
    id,
    isAvailable: () => available,
    transcribe:
      transcribeImpl ??
      (async () => ({
        text: 'hello world',
        segments: [
          { text: 'hello', start: 0, end: 1 },
          { text: 'world', start: 1, end: 2 },
        ],
        durationSec: 2,
      })),
  }
}

function mockBridge(): BrowserActionBridge {
  return { invokeBrowserAction: vi.fn() as BrowserActionBridge['invokeBrowserAction'] }
}

async function callTool(toolDef: ReturnType<typeof createTranscribeTool>, args: unknown) {
  // SDK passes `extra` as unknown — undefined here is fine for handler-internal tests.
  return await toolDef.handler(args as Parameters<typeof toolDef.handler>[0], undefined)
}

describe('createTranscribeTool', () => {
  it('routes via the provider router and returns the expected result shape', async () => {
    const local = mockProvider('local-whisper', true)
    const openai = mockProvider('openai-whisper', false)
    const providers: ProvidersBundle = { transcription: [local, openai] }
    const transcribeSpy = vi.spyOn(local, 'transcribe')

    const toolDef = createTranscribeTool({
      bridge: mockBridge(),
      providers,
      abortSignal: new AbortController().signal,
    })

    const result = await callTool(toolDef, { asset_id: 'm1' })
    const text = (result.content[0] as { type: 'text'; text: string }).text
    const parsed = JSON.parse(text)
    expect(parsed).toMatchObject({
      transcriptId: 'm1',
      segmentCount: 2,
      durationSec: 2,
      provider: 'local-whisper',
    })
    expect(parsed.routingReason).toMatch(/local/i)
    expect(transcribeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: 'm1' }),
      expect.objectContaining({ bridge: expect.any(Object), signal: expect.any(AbortSignal) }),
    )
  })

  it('forces openai when provider="openai"', async () => {
    const local = mockProvider('local-whisper', true)
    const openai = mockProvider('openai-whisper', true)
    const providers: ProvidersBundle = { transcription: [local, openai] }
    const localSpy = vi.spyOn(local, 'transcribe')
    const openaiSpy = vi.spyOn(openai, 'transcribe')

    const toolDef = createTranscribeTool({
      bridge: mockBridge(),
      providers,
      abortSignal: new AbortController().signal,
    })

    await callTool(toolDef, { asset_id: 'm1', provider: 'openai' })
    expect(openaiSpy).toHaveBeenCalled()
    expect(localSpy).not.toHaveBeenCalled()
  })

  it('throws when the explicit provider is unavailable', async () => {
    const local = mockProvider('local-whisper', true)
    const openai = mockProvider('openai-whisper', false)
    const providers: ProvidersBundle = { transcription: [local, openai] }

    const toolDef = createTranscribeTool({
      bridge: mockBridge(),
      providers,
      abortSignal: new AbortController().signal,
    })

    await expect(callTool(toolDef, { asset_id: 'm1', provider: 'openai' })).rejects.toThrow(
      /OPENAI_API_KEY/,
    )
  })

  it('forwards the configured abort signal to the provider', async () => {
    const captured: AbortSignal[] = []
    const local = mockProvider('local-whisper', true, async (_input, ctx) => {
      captured.push(ctx.signal)
      return { text: '', segments: [], durationSec: 0 }
    })
    const providers: ProvidersBundle = { transcription: [local] }
    const controller = new AbortController()

    const toolDef = createTranscribeTool({
      bridge: mockBridge(),
      providers,
      abortSignal: controller.signal,
    })

    await callTool(toolDef, { asset_id: 'm1' })
    expect(captured[0]).toBe(controller.signal)
  })

  it('passes language through to the provider input', async () => {
    let received: { language?: string } = {}
    const local = mockProvider('local-whisper', true, async (input) => {
      received = { language: input.language }
      return { text: '', segments: [], durationSec: 0 }
    })
    const providers: ProvidersBundle = { transcription: [local] }

    const toolDef = createTranscribeTool({
      bridge: mockBridge(),
      providers,
      abortSignal: new AbortController().signal,
    })

    await callTool(toolDef, { asset_id: 'm1', language: 'ja' })
    expect(received.language).toBe('ja')
  })
})
