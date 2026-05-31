import { describe, expect, it, vi } from 'vitest'
import { createAddKineticTitleTool, type KineticTitleRenderer } from './add-kinetic-title.ts'
import type { BrowserActionBridge } from '../providers/index.ts'

interface BridgeCall {
  action: string
  args: Record<string, unknown>
}

function makeBridge(): { bridge: BrowserActionBridge; calls: BridgeCall[] } {
  const calls: BridgeCall[] = []
  const bridge: BrowserActionBridge = {
    invokeBrowserAction: (async (action: string, args: unknown) => {
      calls.push({ action, args: args as Record<string, unknown> })
      if (action === 'insert-generation-placeholder') {
        return { placeholderId: 'ph-1', trackId: 'tr-1', from: 0, durationInFrames: 120 }
      }
      if (action === 'swap-generation-placeholder-with-url') {
        return {
          clipId: 'clip-1',
          mediaId: 'media-1',
          trackId: 'tr-1',
          from: 0,
          durationInFrames: 120,
        }
      }
      return {}
    }) as BrowserActionBridge['invokeBrowserAction'],
  }
  return { bridge, calls }
}

const fakeRender: KineticTitleRenderer = async () => ({
  bytesBase64: 'QUJD', // "ABC"
  mimeType: 'video/mp4',
  format: 'mp4',
})

async function callTool(toolDef: ReturnType<typeof createAddKineticTitleTool>, args: unknown) {
  return await toolDef.handler(args as Parameters<typeof toolDef.handler>[0], undefined)
}

describe('createAddKineticTitleTool', () => {
  it('inserts a placeholder, renders locally, and swaps in the rendered bytes', async () => {
    const { bridge, calls } = makeBridge()
    const render = vi.fn(fakeRender)
    const tool = createAddKineticTitleTool({
      bridge,
      abortSignal: new AbortController().signal,
      render,
    })

    const result = await callTool(tool, {
      title: 'Welcome',
      subtitle: 'to the show',
      accent_color: '#22D3EE',
      start_seconds: 6,
      target_seconds: 5,
    })

    // placeholder window = [start, start + duration]
    const insert = calls.find((c) => c.action === 'insert-generation-placeholder')!
    expect(insert.args).toMatchObject({
      startSeconds: 6,
      endSeconds: 11,
      providerId: 'hyperframes',
    })

    // renderer got the content + duration
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Welcome',
        subtitle: 'to the show',
        accentColor: '#22D3EE',
        durationSec: 5,
      }),
    )

    // swap carries BYTES (not a URL) + engine metadata
    const swap = calls.find((c) => c.action === 'swap-generation-placeholder-with-url')!
    expect(swap.args).toMatchObject({
      placeholderId: 'ph-1',
      sourceBytesBase64: 'QUJD',
      mediaMimeType: 'video/mp4',
      providerId: 'hyperframes',
      modelId: 'kinetic-title',
    })
    expect(swap.args.sourceUrl).toBeUndefined()

    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text)
    expect(parsed).toMatchObject({
      template: 'kinetic_title',
      engine: 'hyperframes',
      clipId: 'clip-1',
      durationSeconds: 5,
    })
  })

  it('defaults the duration to 4 seconds', async () => {
    const { bridge, calls } = makeBridge()
    const tool = createAddKineticTitleTool({
      bridge,
      abortSignal: new AbortController().signal,
      render: fakeRender,
    })
    await callTool(tool, { title: 'Hi', start_seconds: 0 })
    const insert = calls.find((c) => c.action === 'insert-generation-placeholder')!
    expect(insert.args).toMatchObject({ startSeconds: 0, endSeconds: 4 })
  })

  it('forwards branding params (colors + Google font) to the renderer', async () => {
    const { bridge } = makeBridge()
    const render = vi.fn(fakeRender)
    const tool = createAddKineticTitleTool({
      bridge,
      abortSignal: new AbortController().signal,
      render,
    })
    await callTool(tool, {
      title: 'Hi',
      start_seconds: 0,
      title_color: '#F5C518',
      background_color: '#2A0E4F',
      subtitle_color: '#ABCDEF',
      font_family: 'Montserrat',
    })
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        titleColor: '#F5C518',
        backgroundColor: '#2A0E4F',
        subtitleColor: '#ABCDEF',
        fontFamily: 'Montserrat',
      }),
    )
  })

  it('marks the placeholder as errored when the render fails (and rethrows)', async () => {
    const { bridge, calls } = makeBridge()
    const render: KineticTitleRenderer = async () => {
      throw new Error('hyperframes render exited with code 1')
    }
    const tool = createAddKineticTitleTool({
      bridge,
      abortSignal: new AbortController().signal,
      render,
    })

    await expect(callTool(tool, { title: 'Hi', start_seconds: 0 })).rejects.toThrow(/render exited/)
    expect(calls.some((c) => c.action === 'mark-generation-placeholder-error')).toBe(true)
    expect(calls.some((c) => c.action === 'swap-generation-placeholder-with-url')).toBe(false)
  })

  it('removes the placeholder (no error marker) when aborted mid-render', async () => {
    const { bridge, calls } = makeBridge()
    const controller = new AbortController()
    const render: KineticTitleRenderer = async () => {
      controller.abort()
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    const tool = createAddKineticTitleTool({ bridge, abortSignal: controller.signal, render })

    await expect(callTool(tool, { title: 'Hi', start_seconds: 0 })).rejects.toThrow()
    expect(calls.some((c) => c.action === 'remove-generation-placeholder')).toBe(true)
    expect(calls.some((c) => c.action === 'mark-generation-placeholder-error')).toBe(false)
  })
})
