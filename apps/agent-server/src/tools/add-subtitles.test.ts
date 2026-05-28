import { describe, expect, it, vi } from 'vitest'
import { createAddSubtitlesTool } from './add-subtitles.ts'
import type { BrowserActionBridge } from '../providers/index.ts'

function mockBridge(
  impl?: (action: string, args: unknown, signal: AbortSignal) => Promise<unknown>,
): BrowserActionBridge {
  return {
    invokeBrowserAction: vi.fn(
      impl ??
        (async () => ({ insertedItemCount: 0, removedItemCount: 0, hasWordTimestamps: true })),
    ) as BrowserActionBridge['invokeBrowserAction'],
  }
}

async function callTool(toolDef: ReturnType<typeof createAddSubtitlesTool>, args: unknown) {
  return await toolDef.handler(args as Parameters<typeof toolDef.handler>[0], undefined)
}

describe('createAddSubtitlesTool', () => {
  it('forwards asset_id to the browser as mediaId and returns the structured result with karaoke defaults', async () => {
    const bridge = mockBridge(async () => ({
      insertedItemCount: 3,
      removedItemCount: 0,
      hasWordTimestamps: true,
    }))
    const toolDef = createAddSubtitlesTool({
      bridge,
      abortSignal: new AbortController().signal,
    })
    const result = await callTool(toolDef, { asset_id: 'media-1' })

    expect(bridge.invokeBrowserAction).toHaveBeenCalledTimes(1)
    const [action, sentArgs] = (bridge.invokeBrowserAction as ReturnType<typeof vi.fn>).mock
      .calls[0] as [
      string,
      {
        mediaId: string
        replaceExisting?: boolean
        style?: string
        karaokeHighlightColor?: string
      },
    ]
    expect(action).toBe('add-subtitles')
    // Tool defaults style + highlight color to undefined so the SERVICE layer
    // owns the karaoke-as-default decision. Caller-side wiring is just pass-through.
    expect(sentArgs).toEqual({
      mediaId: 'media-1',
      replaceExisting: undefined,
      style: undefined,
      karaokeHighlightColor: undefined,
    })

    const text = (result.content[0] as { type: 'text'; text: string }).text
    const parsed = JSON.parse(text)
    // Response echoes effective defaults — karaoke + gold — so the agent has
    // them to quote back to the user.
    expect(parsed).toEqual({
      mediaId: 'media-1',
      insertedItemCount: 3,
      removedItemCount: 0,
      hasWordTimestamps: true,
      style: 'karaoke',
      highlightColor: '#FFD700',
      wordsPerCue: 3,
    })
  })

  it('forwards words_per_cue when the user asks for a different chunk size', async () => {
    const bridge = mockBridge(async () => ({
      insertedItemCount: 5,
      removedItemCount: 0,
      hasWordTimestamps: true,
    }))
    const toolDef = createAddSubtitlesTool({
      bridge,
      abortSignal: new AbortController().signal,
    })
    const result = await callTool(toolDef, { asset_id: 'media-1', words_per_cue: 1 })

    const [, sentArgs] = (bridge.invokeBrowserAction as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { wordsPerCue?: number },
    ]
    expect(sentArgs.wordsPerCue).toBe(1)

    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text)
    expect(parsed.wordsPerCue).toBe(1)
  })

  it('propagates the replace_existing flag', async () => {
    const bridge = mockBridge(async () => ({
      insertedItemCount: 4,
      removedItemCount: 4,
      hasWordTimestamps: true,
    }))
    const toolDef = createAddSubtitlesTool({
      bridge,
      abortSignal: new AbortController().signal,
    })
    await callTool(toolDef, { asset_id: 'media-1', replace_existing: true })

    const [, sentArgs] = (bridge.invokeBrowserAction as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { mediaId: string; replaceExisting?: boolean },
    ]
    expect(sentArgs.replaceExisting).toBe(true)
  })

  it('forwards style + highlight_color when the user opts out of karaoke or picks a color', async () => {
    const bridge = mockBridge(async () => ({
      insertedItemCount: 2,
      removedItemCount: 0,
      hasWordTimestamps: true,
    }))
    const toolDef = createAddSubtitlesTool({
      bridge,
      abortSignal: new AbortController().signal,
    })
    const result = await callTool(toolDef, {
      asset_id: 'media-1',
      style: 'standard',
      highlight_color: '#00FFFF',
    })

    const [, sentArgs] = (bridge.invokeBrowserAction as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { style?: string; karaokeHighlightColor?: string },
    ]
    expect(sentArgs.style).toBe('standard')
    expect(sentArgs.karaokeHighlightColor).toBe('#00FFFF')

    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text)
    expect(parsed.style).toBe('standard')
    expect(parsed.highlightColor).toBe('#00FFFF')
  })

  it('surfaces hasWordTimestamps:false so the agent can warn when karaoke will not animate', async () => {
    const bridge = mockBridge(async () => ({
      insertedItemCount: 1,
      removedItemCount: 0,
      hasWordTimestamps: false,
    }))
    const toolDef = createAddSubtitlesTool({
      bridge,
      abortSignal: new AbortController().signal,
    })
    const result = await callTool(toolDef, { asset_id: 'media-1' })

    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text)
    expect(parsed.hasWordTimestamps).toBe(false)
  })

  it('forwards the abort signal to the bridge call', async () => {
    let captured: AbortSignal | undefined
    const bridge: BrowserActionBridge = {
      invokeBrowserAction: vi.fn(async (_action, _args, signal) => {
        captured = signal
        return { insertedItemCount: 0, removedItemCount: 0, hasWordTimestamps: true }
      }) as BrowserActionBridge['invokeBrowserAction'],
    }
    const controller = new AbortController()
    const toolDef = createAddSubtitlesTool({ bridge, abortSignal: controller.signal })

    await callTool(toolDef, { asset_id: 'media-1' })
    expect(captured).toBe(controller.signal)
  })

  it('surfaces handler errors verbatim', async () => {
    const bridge = mockBridge(async () => {
      throw new Error('No transcript found for this media item')
    })
    const toolDef = createAddSubtitlesTool({
      bridge,
      abortSignal: new AbortController().signal,
    })

    await expect(callTool(toolDef, { asset_id: 'media-1' })).rejects.toThrow(/No transcript found/)
  })
})
