import type { BrowserActionHandler } from './types'

export class BrowserActionRegistry {
  private readonly handlers = new Map<string, BrowserActionHandler>()

  register(action: string, handler: BrowserActionHandler): () => void {
    if (this.handlers.has(action)) {
      throw new Error(`browser action already registered: ${action}`)
    }
    this.handlers.set(action, handler)
    return () => {
      this.handlers.delete(action)
    }
  }

  has(action: string): boolean {
    return this.handlers.has(action)
  }

  async dispatch(action: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    const handler = this.handlers.get(action)
    if (!handler) {
      throw new Error(`no handler registered for browser action: ${action}`)
    }
    return await handler(args, signal)
  }
}
