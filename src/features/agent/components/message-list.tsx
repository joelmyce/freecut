import { useEffect, useRef } from 'react'
import { MessageBubble } from './message-bubble'
import type { ChatMessage } from '../hooks/use-agent-chat'

interface MessageListProps {
  messages: ReadonlyArray<ChatMessage>
  isLoading: boolean
}

export function MessageList({ messages, isLoading }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Auto-scroll to bottom on new message or loading state change.
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages.length, isLoading])

  if (messages.length === 0 && !isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center px-6 text-center text-xs text-muted-foreground/70">
        <div className="max-w-[80%] space-y-2">
          <div className="font-medium text-muted-foreground">Ask the editor agent.</div>
          <div>
            Try{' '}
            <span className="font-mono bg-secondary/40 px-1 rounded">
              transcribe clip &lt;id&gt;
            </span>
            {' — '}
            you can pull clip ids from the timeline summary the agent sees.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2">
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}
      {isLoading && (
        <div className="flex justify-start">
          <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground italic">
            <span className="inline-block animate-pulse">thinking…</span>
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  )
}
