import { describe, expect, it, vi } from 'vitest'
import { createAddMotionGraphicTool } from './add-motion-graphic.ts'
import type { BrowserActionBridge } from '../providers/index.ts'

const BROWSER_RESULT = {
  insertedItemCount: 3,
  insertedTrackCount: 3,
  fromSeconds: 0,
  durationSeconds: 5,
  layerLabels: ['Lower third panel', 'Lower third name', 'Lower third role'],
}

function mockBridge(
  impl?: (action: string, args: unknown, signal: AbortSignal) => Promise<unknown>,
): BrowserActionBridge {
  return {
    invokeBrowserAction: vi.fn(
      impl ?? (async () => BROWSER_RESULT),
    ) as BrowserActionBridge['invokeBrowserAction'],
  }
}

async function callTool(toolDef: ReturnType<typeof createAddMotionGraphicTool>, args: unknown) {
  return await toolDef.handler(args as Parameters<typeof toolDef.handler>[0], undefined)
}

function makeTool(bridge: BrowserActionBridge) {
  return createAddMotionGraphicTool({ bridge, abortSignal: new AbortController().signal })
}

interface SentArgs {
  spec: {
    templateId: string
    defaultDurationSec: number
    layers: Array<{
      kind: string
      name: string
      text?: string
      color?: string
      fillColor?: string
      fontFamily?: string
    }>
  }
  targetSeconds?: number
  startSeconds?: number
}

function firstCall(bridge: BrowserActionBridge): [string, SentArgs] {
  return (bridge.invokeBrowserAction as ReturnType<typeof vi.fn>).mock.calls[0] as [
    string,
    SentArgs,
  ]
}

describe('createAddMotionGraphicTool', () => {
  it('builds a lower_third spec and forwards it to the browser handler', async () => {
    const bridge = mockBridge()
    const result = await callTool(makeTool(bridge), {
      template: 'lower_third',
      content: { name: 'Alex Rivera', role: 'Founder, Acme' },
    })

    expect(bridge.invokeBrowserAction).toHaveBeenCalledTimes(1)
    const [action, sentArgs] = firstCall(bridge)
    expect(action).toBe('add-motion-graphic')
    expect(sentArgs.spec.templateId).toBe('lower_third')
    expect(sentArgs.spec.layers).toHaveLength(3)
    expect(sentArgs.spec.layers[0]!.kind).toBe('shape') // backmost panel
    expect(sentArgs.spec.layers.find((l) => l.text === 'Alex Rivera')).toBeTruthy()

    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text)
    expect(parsed).toMatchObject({
      template: 'lower_third',
      insertedItemCount: 3,
      insertedTrackCount: 3,
      durationSeconds: 5,
    })
  })

  it('omits the role layer when no role is given', async () => {
    const bridge = mockBridge()
    await callTool(makeTool(bridge), { template: 'lower_third', content: { name: 'Solo' } })
    const [, sentArgs] = firstCall(bridge)
    expect(sentArgs.spec.layers).toHaveLength(2)
  })

  it('threads the custom accent color into the built spec', async () => {
    const bridge = mockBridge()
    await callTool(makeTool(bridge), {
      template: 'lower_third',
      content: { name: 'Alex', role: '@alex', accent_color: '#22D3EE' },
    })
    const [, sentArgs] = firstCall(bridge)
    const role = sentArgs.spec.layers.find((l) => l.text === '@alex')
    expect(role?.color).toBe('#22D3EE')
  })

  it('forwards target_seconds and start_seconds', async () => {
    const bridge = mockBridge()
    await callTool(makeTool(bridge), {
      template: 'lower_third',
      content: { name: 'Alex' },
      target_seconds: 8,
      start_seconds: 12.5,
    })
    const [, sentArgs] = firstCall(bridge)
    expect(sentArgs.targetSeconds).toBe(8)
    expect(sentArgs.startSeconds).toBe(12.5)
  })

  it('rejects when required content (name) is missing — without touching the bridge', async () => {
    const bridge = mockBridge()
    await expect(
      callTool(makeTool(bridge), { template: 'lower_third', content: { role: 'orphan role' } }),
    ).rejects.toThrow(/requires name/)
    expect(bridge.invokeBrowserAction).not.toHaveBeenCalled()
  })

  it('rejects a blank name', async () => {
    const bridge = mockBridge()
    await expect(
      callTool(makeTool(bridge), { template: 'lower_third', content: { name: '   ' } }),
    ).rejects.toThrow(/requires name/)
    expect(bridge.invokeBrowserAction).not.toHaveBeenCalled()
  })

  it('builds a title_card spec from content.title', async () => {
    const bridge = mockBridge()
    await callTool(makeTool(bridge), {
      template: 'title_card',
      content: { title: 'Chapter One', subtitle: 'the beginning' },
    })
    const [, sentArgs] = firstCall(bridge)
    expect(sentArgs.spec.templateId).toBe('title_card')
    expect(sentArgs.spec.layers.find((l) => l.text === 'Chapter One')).toBeTruthy()
    expect(sentArgs.spec.layers.find((l) => l.text === 'the beginning')).toBeTruthy()
  })

  it('rejects a title_card without a title', async () => {
    const bridge = mockBridge()
    await expect(
      callTool(makeTool(bridge), { template: 'title_card', content: { subtitle: 'orphan' } }),
    ).rejects.toThrow(/requires title/)
    expect(bridge.invokeBrowserAction).not.toHaveBeenCalled()
  })

  it('builds a stat_callout spec and preserves the value string verbatim', async () => {
    const bridge = mockBridge()
    await callTool(makeTool(bridge), {
      template: 'stat_callout',
      content: { value: '$2.5M', label: 'revenue' },
    })
    const [, sentArgs] = firstCall(bridge)
    expect(sentArgs.spec.templateId).toBe('stat_callout')
    expect(sentArgs.spec.layers.find((l) => l.text === '$2.5M')).toBeTruthy()
    expect(sentArgs.spec.layers.find((l) => l.text === 'revenue')).toBeTruthy()
  })

  it('rejects a stat_callout without a value', async () => {
    const bridge = mockBridge()
    await expect(
      callTool(makeTool(bridge), { template: 'stat_callout', content: { label: 'orphan' } }),
    ).rejects.toThrow(/requires value/)
    expect(bridge.invokeBrowserAction).not.toHaveBeenCalled()
  })

  it('applies a named brand: fills colors + font and adds the flat background (title_card)', async () => {
    const bridge = mockBridge()
    await callTool(makeTool(bridge), {
      template: 'title_card',
      content: { title: 'Sistema', subtitle: 'no trucos' },
      brand: 'abdias',
    })
    const [, sentArgs] = firstCall(bridge)
    const bg = sentArgs.spec.layers.find((l) => l.name === 'Background')
    expect(bg?.fillColor).toBe('#F5F0E8') // Paper background card (brand light)
    const title = sentArgs.spec.layers.find((l) => l.text === 'Sistema')
    expect(title?.color).toBe('#0B1220') // Ink
    expect(title?.fontFamily).toBe('Fraunces')
  })

  it('lets an explicit accent_color override the brand, but still applies the brand font', async () => {
    const bridge = mockBridge()
    await callTool(makeTool(bridge), {
      template: 'lower_third',
      content: { name: 'Alex', role: 'CEO', accent_color: '#00FF00' },
      brand: 'abdias',
    })
    const [, sentArgs] = firstCall(bridge)
    const role = sentArgs.spec.layers.find((l) => l.text === 'CEO')
    expect(role?.color).toBe('#00FF00') // explicit accent wins over brand signal-blue
    const name = sentArgs.spec.layers.find((l) => l.text === 'Alex')
    expect(name?.fontFamily).toBe('Fraunces') // brand still fills the font
  })

  it('throws on an unknown brand without touching the bridge', async () => {
    const bridge = mockBridge()
    await expect(
      callTool(makeTool(bridge), {
        template: 'title_card',
        content: { title: 'X' },
        brand: 'acme',
      }),
    ).rejects.toThrow(/Unknown brand/)
    expect(bridge.invokeBrowserAction).not.toHaveBeenCalled()
  })

  it('forwards the abort signal to the bridge call', async () => {
    let captured: AbortSignal | undefined
    const bridge: BrowserActionBridge = {
      invokeBrowserAction: vi.fn(async (_action, _args, signal) => {
        captured = signal
        return BROWSER_RESULT
      }) as BrowserActionBridge['invokeBrowserAction'],
    }
    const controller = new AbortController()
    const toolDef = createAddMotionGraphicTool({ bridge, abortSignal: controller.signal })
    await callTool(toolDef, { template: 'lower_third', content: { name: 'Alex' } })
    expect(captured).toBe(controller.signal)
  })

  it('surfaces handler errors verbatim', async () => {
    const bridge = mockBridge(async () => {
      throw new Error('No project loaded')
    })
    await expect(
      callTool(makeTool(bridge), { template: 'lower_third', content: { name: 'Alex' } }),
    ).rejects.toThrow(/No project loaded/)
  })
})
