/**
 * Bridge protocol shared between the agent server and the browser client.
 *
 * Phase 1 / M0: only `user-message`, `agent-message`, `tool-call`, `tool-result`,
 * and a `ready` heartbeat are actually emitted. The rest are reserved for
 * later milestones (see docs/PHASE-1-PLAN.md §2.1) and declared here so
 * downstream typing settles now instead of after the chat panel ships.
 *
 * NOTE: a copy of this file lives at `src/features/agent/bridge/protocol.ts`.
 * Keep them in sync manually until a shared package is extracted (TODO M2+).
 */

export const BRIDGE_PROTOCOL_VERSION = 1
export const DEFAULT_BRIDGE_PORT = 5174

export type BrowserToServerMessage =
  | { type: 'hello'; protocolVersion: number; clientId?: string }
  | {
      type: 'user-message'
      turnId: string
      text: string
      timelineSummary?: string
      selection?: { itemIds: string[]; trackIds: string[] }
    }
  | {
      type: 'browser-action-result'
      requestId: string
      result?: unknown
      error?: string
    }
  | { type: 'state-changed'; changedKeys: string[] }
  | { type: 'cancel-turn'; turnId: string }

export type ServerToBrowserMessage =
  | { type: 'ready'; protocolVersion: number; serverInfo: { name: string; version: string } }
  | { type: 'agent-message'; turnId: string; text: string }
  | { type: 'tool-call'; turnId: string; callId: string; toolName: string; args: unknown }
  | {
      type: 'tool-progress'
      turnId: string
      callId: string
      stage: string
      fraction?: number
    }
  | {
      type: 'tool-result'
      turnId: string
      callId: string
      result?: unknown
      error?: string
    }
  | {
      type: 'invoke-browser-action'
      requestId: string
      action: string
      args: unknown
    }
  | {
      type: 'mutate-timeline'
      requestId: string
      action: string
      args: unknown
    }
  | { type: 'turn-end'; turnId: string }
  | { type: 'error'; message: string; turnId?: string }

export type BridgeMessage = BrowserToServerMessage | ServerToBrowserMessage

export function encodeBridgeMessage(message: BridgeMessage): string {
  return JSON.stringify(message)
}

export function decodeBridgeMessage(raw: string): BridgeMessage {
  // Trust internal source — this is our own protocol, not user input.
  return JSON.parse(raw) as BridgeMessage
}
