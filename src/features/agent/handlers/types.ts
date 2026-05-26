/**
 * Browser-side handler for a server-initiated `invoke-browser-action`.
 * Receives the action args (whatever the server sent) and an AbortSignal
 * that fires if the server requests cancellation. Return whatever the
 * matching server-side provider expects — gets JSON-encoded over the wire.
 */
export type BrowserActionHandler = (args: unknown, signal: AbortSignal) => Promise<unknown>
