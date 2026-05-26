import { memo, useState } from 'react'
import { cn } from '@/shared/ui/cn'
import type { ChatMessage } from '../hooks/use-agent-chat'

interface MessageBubbleProps {
  message: ChatMessage
}

export const MessageBubble = memo(function MessageBubble({ message }: MessageBubbleProps) {
  switch (message.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground whitespace-pre-wrap">
            {message.text}
          </div>
        </div>
      )
    case 'assistant':
      return (
        <div className="flex justify-start">
          <div className="max-w-[90%] rounded-lg bg-muted/70 px-3 py-2 text-xs text-foreground whitespace-pre-wrap">
            {message.text}
          </div>
        </div>
      )
    case 'tool-call':
      return <ToolCallRow message={message} />
    case 'tool-result':
      return <ToolResultRow message={message} />
    case 'tool-progress':
      return (
        <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70 px-1">
          ↻ {message.stage}
          {typeof message.fraction === 'number'
            ? ` (${Math.round(message.fraction * 100)}%)`
            : null}
        </div>
      )
    case 'error':
      return (
        <div className="flex justify-start">
          <div className="max-w-[90%] rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive whitespace-pre-wrap">
            {message.text}
          </div>
        </div>
      )
  }
})

function ToolCallRow({ message }: { message: Extract<ChatMessage, { kind: 'tool-call' }> }) {
  const [expanded, setExpanded] = useState(false)
  const displayName = message.toolName.replace(/^mcp__freecut__/, '')
  return (
    <div className="flex justify-start">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'max-w-[95%] text-left rounded-md border border-border bg-secondary/30 px-2.5 py-1.5 font-mono text-[11px] text-foreground/80 hover:bg-secondary/50 transition-colors',
        )}
      >
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">{expanded ? '▼' : '▶'}</span>
          <span className="font-semibold text-primary/80">{displayName}</span>
          <span className="text-muted-foreground">
            ({Object.keys((message.args as Record<string, unknown>) ?? {}).join(', ')})
          </span>
        </div>
        {expanded && (
          <pre className="mt-1.5 text-[10px] text-muted-foreground whitespace-pre-wrap break-all">
            {JSON.stringify(message.args, null, 2)}
          </pre>
        )}
      </button>
    </div>
  )
}

function ToolResultRow({ message }: { message: Extract<ChatMessage, { kind: 'tool-result' }> }) {
  const [expanded, setExpanded] = useState(false)
  const isError = Boolean(message.error)
  const preview = previewToolResult(message.result, message.error)
  return (
    <div className="flex justify-start">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'max-w-[95%] text-left rounded-md border px-2.5 py-1.5 font-mono text-[11px] transition-colors',
          isError
            ? 'border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20'
            : 'border-border bg-secondary/30 text-foreground/80 hover:bg-secondary/50',
        )}
      >
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">{expanded ? '▼' : '▶'}</span>
          <span>{isError ? '✗ error' : '✓ result'}</span>
          {!expanded && <span className="text-muted-foreground truncate">{preview}</span>}
        </div>
        {expanded && (
          <pre className="mt-1.5 text-[10px] text-muted-foreground whitespace-pre-wrap break-all">
            {message.error ?? JSON.stringify(message.result, null, 2)}
          </pre>
        )}
      </button>
    </div>
  )
}

function previewToolResult(result: unknown, error?: string): string {
  if (error) return ` ${error.slice(0, 80)}`
  if (Array.isArray(result)) {
    const first = result[0] as { text?: string } | undefined
    if (first && typeof first.text === 'string') {
      const t = first.text.replace(/\s+/g, ' ').trim()
      return t.length > 80 ? ` ${t.slice(0, 80)}…` : ` ${t}`
    }
  }
  const stringified = JSON.stringify(result)
  return stringified.length > 80 ? ` ${stringified.slice(0, 80)}…` : ` ${stringified}`
}
