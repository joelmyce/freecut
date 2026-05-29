import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  DEFAULT_CONFIRMATION_TIMEOUT_MS,
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

function captureConfirmationId(sender: ReturnType<typeof makeSender>): string {
  const last = sender.sent.at(-1)
  if (!last || last.type !== 'pending-confirmation') {
    throw new Error('expected last sent message to be pending-confirmation')
  }
  return last.confirmationId
}

describe('SocketBrowserActionBridge — confirmations (M5.2)', () => {
  it('sends pending-confirmation with the card and resolves on the response', async () => {
    const sender = makeSender()
    const bridge = new SocketBrowserActionBridge(sender)
    const promise = bridge.requestConfirmation(
      { title: 'Animate?', summary: 'drift left', costEstimate: { amount: 0.25, currency: 'USD' } },
      new AbortController().signal,
    )

    expect(sender.sent).toHaveLength(1)
    expect(sender.sent[0]).toMatchObject({
      type: 'pending-confirmation',
      title: 'Animate?',
      summary: 'drift left',
      costEstimate: { amount: 0.25, currency: 'USD' },
    })

    bridge.handleConfirmationResponse(captureConfirmationId(sender), 'approve')
    await expect(promise).resolves.toMatchObject({ decision: 'approve' })
  })

  it('passes edits through when the decision is edit', async () => {
    const sender = makeSender()
    const bridge = new SocketBrowserActionBridge(sender)
    const promise = bridge.requestConfirmation(
      { title: 't', summary: 's' },
      new AbortController().signal,
    )

    bridge.handleConfirmationResponse(captureConfirmationId(sender), 'edit', {
      motion_prompt: 'zoom out',
    })
    await expect(promise).resolves.toEqual({
      decision: 'edit',
      edits: { motion_prompt: 'zoom out' },
    })
  })

  it('throws synchronously when the signal is already aborted and sends nothing', async () => {
    const sender = makeSender()
    const bridge = new SocketBrowserActionBridge(sender)
    const controller = new AbortController()
    controller.abort()
    await expect(
      bridge.requestConfirmation({ title: 't', summary: 's' }, controller.signal),
    ).rejects.toThrow(/aborted/)
    expect(sender.sent).toHaveLength(0)
  })

  it('throws when the socket is closed', async () => {
    const sender = makeSender()
    sender.open = false
    const bridge = new SocketBrowserActionBridge(sender)
    await expect(
      bridge.requestConfirmation({ title: 't', summary: 's' }, new AbortController().signal),
    ).rejects.toThrow(/closed/)
  })

  it('rejects on mid-flight abort WITHOUT sending a cancel message', async () => {
    const sender = makeSender()
    const bridge = new SocketBrowserActionBridge(sender)
    const controller = new AbortController()
    const promise = bridge.requestConfirmation({ title: 't', summary: 's' }, controller.signal)

    controller.abort()
    await expect(promise).rejects.toThrow(/aborted/)
    // Unlike browser actions, confirmations have no cancel wire message — only
    // the original pending-confirmation was ever sent.
    expect(sender.sent).toHaveLength(1)
  })

  it('no-ops handleConfirmationResponse for unknown ids', () => {
    const sender = makeSender()
    const bridge = new SocketBrowserActionBridge(sender)
    expect(() => bridge.handleConfirmationResponse('nope', 'approve')).not.toThrow()
  })

  it('rejectAll terminates pending confirmations', async () => {
    const sender = makeSender()
    const bridge = new SocketBrowserActionBridge(sender)
    const promise = bridge.requestConfirmation(
      { title: 't', summary: 's' },
      new AbortController().signal,
    )

    bridge.rejectAll(new Error('socket closed'))
    await expect(promise).rejects.toThrow('socket closed')
  })

  it('times out a pending confirmation when no response arrives', async () => {
    vi.useFakeTimers()
    try {
      const sender = makeSender()
      const bridge = new SocketBrowserActionBridge(sender, 100, 100)
      const promise = bridge.requestConfirmation(
        { title: 't', summary: 's' },
        new AbortController().signal,
      )
      const expectation = expect(promise).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(150)
      await expectation
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives confirmations a longer default timeout than browser actions', () => {
    expect(DEFAULT_CONFIRMATION_TIMEOUT_MS).toBeGreaterThan(DEFAULT_BROWSER_ACTION_TIMEOUT_MS)
  })
})
