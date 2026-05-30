import { memo, useState } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import { cn } from '@/shared/ui/cn'
import type { ConfirmationDecisionKind } from '../bridge/protocol'
import type { ChatMessage } from '../hooks/use-agent-chat'

type ConfirmHandler = (
  confirmationId: string,
  decision: ConfirmationDecisionKind,
  edits?: Record<string, unknown>,
) => void

interface MessageBubbleProps {
  message: ChatMessage
  onConfirm: ConfirmHandler
}

export const MessageBubble = memo(function MessageBubble({
  message,
  onConfirm,
}: MessageBubbleProps) {
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
    case 'confirmation':
      return <ConfirmationCard message={message} onConfirm={onConfirm} />
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

/**
 * M5.2 concept-card approval. Rendered for `kind: 'confirmation'` — shows the
 * preview (e.g. the still to animate), an estimated cost, and Approve / Edit /
 * Reject controls. Buttons are live only while `status === 'pending'`; after a
 * decision (or expiry) the card shows the outcome and disables.
 */
function ConfirmationCard({
  message,
  onConfirm,
}: {
  message: Extract<ChatMessage, { kind: 'confirmation' }>
  onConfirm: ConfirmHandler
}) {
  const primaryEditable = message.editableFields?.[0]
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(primaryEditable?.value ?? '')
  const pending = message.status === 'pending'

  const cost = message.costEstimate
  const costLabel = cost
    ? `${cost.isEstimate ? '~' : ''}$${cost.amount.toFixed(2)}${cost.isEstimate ? ' est.' : ''}`
    : null

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[95%] overflow-hidden rounded-lg border border-primary/40 bg-primary/5">
        {message.previewImageUrl && (
          <img
            src={message.previewImageUrl}
            alt={message.title}
            className="max-h-40 w-full object-cover"
          />
        )}
        <div className="space-y-2 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-foreground">{message.title}</span>
            {costLabel && (
              <span className="whitespace-nowrap font-mono text-[11px] text-amber-500">
                {costLabel}
              </span>
            )}
          </div>

          {message.summary && (
            <p className="whitespace-pre-wrap text-[11px] text-muted-foreground">
              {message.summary}
            </p>
          )}

          {message.details && message.details.length > 0 && (
            <div className="flex flex-col gap-y-0.5 font-mono text-[10px] text-muted-foreground/80">
              {message.details.map((d) => (
                <span key={d.label}>
                  <span className="text-muted-foreground/60">{d.label}:</span> {d.value}
                </span>
              ))}
            </div>
          )}

          {pending ? (
            editing && primaryEditable ? (
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                  {primaryEditable.label}
                </label>
                <textarea
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  rows={2}
                  className="w-full resize-none rounded border border-border bg-background px-2 py-1 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                />
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    disabled={editValue.trim().length === 0}
                    onClick={() =>
                      onConfirm(message.confirmationId, 'edit', {
                        [primaryEditable.key]: editValue.trim(),
                      })
                    }
                    className="flex-1 rounded bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    Render with changes
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    className="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/50"
                  >
                    Back
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => onConfirm(message.confirmationId, 'approve')}
                  className="inline-flex flex-1 items-center justify-center gap-1 rounded bg-primary px-2 py-1.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
                >
                  <Check className="h-3 w-3" /> {message.approveLabel ?? 'Approve'}
                </button>
                {primaryEditable && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditValue(primaryEditable.value)
                      setEditing(true)
                    }}
                    className="inline-flex items-center justify-center gap-1 rounded border border-border px-2 py-1.5 text-[11px] text-foreground hover:bg-muted/50"
                  >
                    <Pencil className="h-3 w-3" /> Edit
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onConfirm(message.confirmationId, 'reject')}
                  className="inline-flex items-center justify-center gap-1 rounded border border-border px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <X className="h-3 w-3" /> {message.rejectLabel ?? 'Reject'}
                </button>
              </div>
            )
          ) : (
            <div className="text-[11px] font-medium">
              {message.status === 'approved' && (
                <span className="text-emerald-500">✓ Approved</span>
              )}
              {message.status === 'edited' && (
                <span className="text-emerald-500">✎ Rendering with your changes</span>
              )}
              {message.status === 'rejected' && (
                <span className="text-muted-foreground">✗ Declined — no changes made</span>
              )}
              {message.status === 'expired' && (
                <span className="text-muted-foreground/60">— expired</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
