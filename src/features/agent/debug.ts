import { createLogger } from '@/shared/logging/logger'
import { summarizeTimelineForAgent, type TimelineAgentSnapshot } from '@/shared/state/agent'
import type { AgentBridgeClient } from './bridge/client'
import { captureTimelineAgentSnapshot } from './timeline-snapshot'

const log = createLogger('agent-debug')

export interface AgentDebugApi {
  /** Send a user-message to the agent. Returns the generated turnId. */
  sendMessage(text: string, opts?: { turnId?: string }): { turnId: string; sent: boolean }
  cancelTurn(turnId: string): boolean
  snapshot(): TimelineAgentSnapshot
  summary(): string
  isConnected(): boolean
}

export function createAgentDebugApi(client: AgentBridgeClient): AgentDebugApi {
  return {
    sendMessage(text, opts) {
      const turnId = opts?.turnId ?? `debug-${Date.now()}`
      const summary = summarizeTimelineForAgent(captureTimelineAgentSnapshot())
      const sent = client.send({
        type: 'user-message',
        turnId,
        text,
        timelineSummary: summary,
      })
      if (sent) {
        log.info(`sent user-message turn=${turnId}`)
      } else {
        log.warn('bridge not connected; message dropped')
      }
      return { turnId, sent }
    },
    cancelTurn(turnId) {
      return client.send({ type: 'cancel-turn', turnId })
    },
    snapshot() {
      return captureTimelineAgentSnapshot()
    },
    summary() {
      return summarizeTimelineForAgent(captureTimelineAgentSnapshot())
    },
    isConnected() {
      return client.isConnected()
    },
  }
}
