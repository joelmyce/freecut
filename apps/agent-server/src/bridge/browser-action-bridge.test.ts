import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  SocketBrowserActionBridge,
  type BridgeSocketSender,
} from './browser-action-bridge.ts'
import type { ServerToBrowserMessage } from './protocol.ts'

function makeSender(): BridgeSocketSender & { sent: ServerToBrowserMessage[]; open: boolean } {
  const sent: ServerToBrowserMessage[] = []
  let open = true
  return {
    sent,
    get open() {
      return open
    },
    set open(value: boolean) {
      open = value
    },
    send: (msg) => {
      sent.push(msg)
    },
    isOpen: () => open,
  }
}

function captureRequestId(sender: ReturnType<typeof makeSender>): string {
  const last = sender.sent.at(-1)
  if (!last || last.type !== 'invoke-browser-action') {
    throw new Error('expected last sent message to be invoke-browser-action')
  }
  return last.requestId
}

describe('SocketBrowserActionBridge', () => {
  it('sends invoke-browser-action with action + args + requestId', async () => {
    const sender = makeSender()
    const bridge = new SocketBrowserActionBridge(sender)
    const controller = new AbortController()
    const promise = bridge.invokeBrowserAction('test-action', { foo: 1 }, controller.signal)

    expect(sender.sent).toHaveLength(1)
    const sent = sender.sent[0]
    expect(sent).toMatchObject({
      type: 'invoke-browser-action',
      action: 'test-action',
      args: { foo: 1 },
    })

    bridge.handleResult(captureRequestId(sender), { ok: true })
    await expect(promise).resolves.toEqual({ ok: true })
  })

  it('rejects the promise with the error string when browser reports an error', async () => {
    const sender = makeSender()
    const bridge = new SocketBrowserActionBridge(sender)
    const controller = new AbortController()
    const promise = bridge.invokeBrowserAction('test-action', {}, controller.signal)

    bridge.handleResult(captureRequestId(sender), undefined, 'something went wrong')
    await expect(promise).rejects.toThrow('something went wrong')
  })

  it('throws synchronously when the signal is already aborted', async () => {
    const sender = makeSender()
    const bridge = new SocketBrowserActionBridge(sender)
    const controller = new AbortController()
    controller.abort()
    await expect(bridge.invokeBrowserAction('test-action', {}, controller.signal)).rejects.toThrow(
      /aborted/,
    )
    expect(sender.sent).toHaveLength(0)
  })

  it('throws when the underlying socket is closed', async () => {
    const sender = makeSender()
    sender.open = false
    const bridge = new SocketBrowserActionBridge(sender)
    const controller = new AbortController()
    await expect(bridge.invokeBrowserAction('test-action', {}, controller.signal)).rejects.toThrow(
      /closed/,
    )
  })

  it('rejects in-flight requests and sends cancel-browser-action when the signal aborts mid-flight', async () => {
    const sender = makeSender()
    const bridge = new SocketBrowserActionBridge(sender)
    const controller = new AbortController()
    const promise = bridge.invokeBrowserAction('test-action', {}, controller.signal)
    const requestId = captureRequestId(sender)

    controller.abort()
    await expect(promise).rejects.toThrow(/aborted/)

    expect(sender.sent).toHaveLength(2)
    expect(sender.sent[1]).toEqual({ type: 'cancel-browser-action', requestId })
  })

  it('does not attempt to send cancel-browser-action when the socket has closed', async () => {
    const sender = makeSender()
    const bridge = new SocketBrowserActionBridge(sender)
    const controller = new AbortController()
    const promise = bridge.invokeBrowserAction('test-action', {}, controller.signal)

    sender.open = false
    controller.abort()
    await expect(promise).rejects.toThrow(/aborted/)

    expect(sender.sent).toHaveLength(1)
  })

  it('silently ignores results for unknown requestIds', async () => {
    const sender = makeSender()
    const bridge = new SocketBrowserActionBridge(sender)
    expect(() => bridge.handleResult('nonexistent', { x: 1 })).not.toThrow()
  })

  it('rejectAll terminates every in-flight request', async () => {
    const sender = makeSender()
    const bridge = new SocketBrowserActionBridge(sender)
    const p1 = bridge.invokeBrowserAction('a1', {}, new AbortController().signal)
    const p2 = bridge.invokeBrowserAction('a2', {}, new AbortController().signal)

    bridge.rejectAll(new Error('socket closed'))

    await expect(p1).rejects.toThrow('socket closed')
    await expect(p2).rejects.toThrow('socket closed')
  })

  it('times out a pending request when no result arrives', async () => {
    vi.useFakeTimers()
    try {
      const sender = makeSender()
      const bridge = new SocketBrowserActionBridge(sender, 100)
      const promise = bridge.invokeBrowserAction('slow', {}, new AbortController().signal)
      const expectation = expect(promise).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(150)
      await expectation
    } finally {
      vi.useRealTimers()
    }
  })

  it('exports a sane default timeout', () => {
    expect(DEFAULT_BROWSER_ACTION_TIMEOUT_MS).toBeGreaterThan(60_000)
  })
})
