import { describe, expect, it, vi } from 'vitest'
import { createAddSubtitlesTool } from './add-subtitles.ts'
import type { BrowserActionBridge } from '../providers/index.ts'

function mockBridge(
  impl?: (action: string, args: unknown, signal: AbortSignal) => Promise<unknown>,
): BrowserActionBridge {
  return {
    invokeBrowserAction: vi.fn(
      impl ?? (async () => ({ insertedItemCount: 0, removedItemCount: 0 })),
    ) as BrowserActionBridge['invokeBrowserAction'],
  }
}

async function callTool(toolDef: ReturnType<typeof createAddSubtitlesTool>, args: unknown) {
  return await toolDef.handler(args as Parameters<typeof toolDef.handler>[0], undefined)
}

describe('createAddSubtitlesTool', () => {
  it('forwards asset_id to the browser as mediaId and returns the structured result', async () => {
    const bridge = mockBridge(async () => ({ insertedItemCount: 3, removedItemCount: 0 }))
    const toolDef = createAddSubtitlesTool({
      bridge,
      abortSignal: new AbortController().signal,
    })
    const result = await callTool(toolDef, { asset_id: 'media-1' })

    expect(bridge.invokeBrowserAction).toHaveBeenCalledTimes(1)
    const [action, sentArgs] = (bridge.invokeBrowserAction as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { mediaId: string; replaceExisting?: boolean }]
    expect(action).toBe('add-subtitles')
    expect(sentArgs).toEqual({ mediaId: 'media-1', replaceExisting: undefined })

    const text = (result.content[0] as { type: 'text'; text: string }).text
    const parsed = JSON.parse(text)
    expect(parsed).toEqual({
      mediaId: 'media-1',
      insertedItemCount: 3,
      removedItemCount: 0,
    })
  })

  it('propagates the replace_existing flag', async () => {
    const bridge = mockBridge(async () => ({ insertedItemCount: 4, removedItemCount: 4 }))
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

  it('forwards the abort signal to the bridge call', async () => {
    let captured: AbortSignal | undefined
    const bridge: BrowserActionBridge = {
      invokeBrowserAction: vi.fn(async (_action, _args, signal) => {
        captured = signal
        return { insertedItemCount: 0, removedItemCount: 0 }
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
