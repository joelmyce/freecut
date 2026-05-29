/**
 * Bridge protocol shared between the browser client and the agent server.
 *
 * NOTE: a copy of this file lives at `apps/agent-server/src/bridge/protocol.ts`.
 * Keep them in sync manually until a shared package is extracted (TODO M2+).
 */

export const BRIDGE_PROTOCOL_VERSION = 1
export const DEFAULT_BRIDGE_PORT = 5174

// --- M5.2 concept-card approval (shared shapes) ---------------------------
// Defined here (not imported from the provider layer) so this file stays
// standalone — its byte-twin at `apps/agent-server/src/bridge/protocol.ts`
// can't reach this browser feature.

/** A user's decision on a concept-card confirmation. */
export type ConfirmationDecisionKind = 'approve' | 'reject' | 'edit'

/** Cost figure shown on a confirmation card. Always advisory — fal does not
 *  return a real price, so this is a heuristic estimate (`isEstimate: true`). */
export interface ConfirmationCostEstimate {
  amount: number
  currency: string
  isEstimate?: boolean
}

/** A field the user can tweak before approving (e.g. the motion prompt). */
export interface ConfirmationEditableField {
  key: string
  label: string
  value: string
  multiline?: boolean
}

/** The card a tool asks the browser to render before an expensive,
 *  side-effecting render. Carried verbatim by `pending-confirmation`. */
export interface ConfirmationCard {
  title: string
  summary: string
  costEstimate?: ConfirmationCostEstimate
  previewImageUrl?: string
  details?: ReadonlyArray<{ label: string; value: string }>
  editableFields?: ReadonlyArray<ConfirmationEditableField>
  approveLabel?: string
  rejectLabel?: string
}

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
  // M5.2 concept-card approval: the user's decision on a `pending-confirmation`
  // card. `edits` carries field overrides when decision === 'edit'.
  | {
      type: 'confirmation-response'
      confirmationId: string
      decision: ConfirmationDecisionKind
      edits?: Record<string, unknown>
    }

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
  | { type: 'cancel-browser-action'; requestId: string }
  | { type: 'turn-end'; turnId: string }
  | { type: 'error'; message: string; turnId?: string }
  // M5.2: ask the user to approve/reject/edit an expensive render. The tool
  // blocks until a matching `confirmation-response` arrives.
  | ({ type: 'pending-confirmation'; confirmationId: string } & ConfirmationCard)

export type BridgeMessage = BrowserToServerMessage | ServerToBrowserMessage

export function encodeBridgeMessage(message: BridgeMessage): string {
  return JSON.stringify(message)
}

export function decodeBridgeMessage(raw: string): BridgeMessage {
  return JSON.parse(raw) as BridgeMessage
}
