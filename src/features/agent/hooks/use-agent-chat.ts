import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { createLogger } from '@/shared/logging/logger'
import { summarizeTimelineForAgent } from '@/shared/state/agent'
import { getAgentBridgeClient } from '../bridge/client'
import type { ServerToBrowserMessage } from '../bridge/protocol'
import { captureTimelineAgentSnapshot } from '../timeline-snapshot'

const log = createLogger('use-agent-chat')

export type ChatMessage =
  | { id: string; kind: 'user'; turnId: string; text: string; ts: number }
  | { id: string; kind: 'assistant'; turnId: string; text: string; ts: number }
  | {
      id: string
      kind: 'tool-call'
      turnId: string
      callId: string
      toolName: string
      args: unknown
      ts: number
    }
  | {
      id: string
      kind: 'tool-result'
      turnId: string
      callId: string
      result: unknown
      error?: string
      ts: number
    }
  | {
      id: string
      kind: 'tool-progress'
      turnId: string
      callId: string
      stage: string
      fraction?: number
      ts: number
    }
  | { id: string; kind: 'error'; turnId?: string; text: string; ts: number }

export interface UseAgentChat {
  messages: ReadonlyArray<ChatMessage>
  activeTurnId: string | null
  isConnected: boolean
  send(text: string): boolean
  cancel(): boolean
  clear(): void
}

export function useAgentChat(): UseAgentChat {
  const client = useMemo(() => getAgentBridgeClient(), [])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  const [isConnected, setIsConnected] = useState(() => client.isConnected())
  const counterRef = useRef(0)

  useEffect(() => {
    return client.subscribe((msg: ServerToBrowserMessage) => {
      handleMessage(msg, setMessages, setActiveTurnId, () => ++counterRef.current)
    })
  }, [client])

  useEffect(() => {
    // The bridge client doesn't surface explicit connect/disconnect events to
    // subscribers, so we poll. Cheap (just two readyState lookups) and the
    // UI doesn't need sub-second resolution.
    const interval = setInterval(() => {
      const next = client.isConnected()
      setIsConnected((prev) => (prev !== next ? next : prev))
    }, 1000)
    return () => clearInterval(interval)
  }, [client])

  const send = useCallback(
    (text: string): boolean => {
      const trimmed = text.trim()
      if (!trimmed) return false
      if (activeTurnId !== null) return false

      const turnId = `chat-${Date.now()}-${++counterRef.current}`
      const summary = summarizeTimelineForAgent(captureTimelineAgentSnapshot())
      const sent = client.send({
        type: 'user-message',
        turnId,
        text: trimmed,
        timelineSummary: summary,
      })

      if (!sent) {
        log.warn('bridge not connected; message dropped')
        setMessages((prev) => [
          ...prev,
          {
            id: `err-${Date.now()}-${++counterRef.current}`,
            kind: 'error',
            text: 'Agent bridge not connected. Make sure `npm run dev:all` is running.',
            ts: Date.now(),
          },
        ])
        return false
      }

      setMessages((prev) => [
        ...prev,
        { id: `usr-${turnId}`, kind: 'user', turnId, text: trimmed, ts: Date.now() },
      ])
      setActiveTurnId(turnId)
      return true
    },
    [activeTurnId, client],
  )

  const cancel = useCallback((): boolean => {
    if (!activeTurnId) return false
    const sent = client.send({ type: 'cancel-turn', turnId: activeTurnId })
    if (sent) log.info(`cancel requested for ${activeTurnId}`)
    return sent
  }, [activeTurnId, client])

  const clear = useCallback(() => {
    setMessages([])
  }, [])

  return { messages, activeTurnId, isConnected, send, cancel, clear }
}

function handleMessage(
  msg: ServerToBrowserMessage,
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>,
  setActiveTurnId: Dispatch<SetStateAction<string | null>>,
  nextSeq: () => number,
): void {
  const ts = Date.now()
  switch (msg.type) {
    case 'agent-message':
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${ts}-${nextSeq()}`,
          kind: 'assistant',
          turnId: msg.turnId,
          text: msg.text,
          ts,
        },
      ])
      return
    case 'tool-call':
      setMessages((prev) => [
        ...prev,
        {
          id: `tc-${msg.callId}`,
          kind: 'tool-call',
          turnId: msg.turnId,
          callId: msg.callId,
          toolName: msg.toolName,
          args: msg.args,
          ts,
        },
      ])
      return
    case 'tool-result':
      setMessages((prev) => [
        ...prev,
        {
          id: `tr-${msg.callId}`,
          kind: 'tool-result',
          turnId: msg.turnId,
          callId: msg.callId,
          result: msg.result,
          error: msg.error,
          ts,
        },
      ])
      return
    case 'tool-progress':
      setMessages((prev) => [
        ...prev,
        {
          id: `tp-${ts}-${nextSeq()}`,
          kind: 'tool-progress',
          turnId: msg.turnId,
          callId: msg.callId,
          stage: msg.stage,
          fraction: msg.fraction,
          ts,
        },
      ])
      return
    case 'turn-end':
      setActiveTurnId((prev) => (prev === msg.turnId ? null : prev))
      return
    case 'error':
      setMessages((prev) => [
        ...prev,
        { id: `e-${ts}-${nextSeq()}`, kind: 'error', turnId: msg.turnId, text: msg.message, ts },
      ])
      return
    case 'ready':
    case 'invoke-browser-action':
    case 'cancel-browser-action':
    case 'mutate-timeline':
      // Not chat-relevant.
      return
  }
}
