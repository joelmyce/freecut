import { useRef, useState, type KeyboardEvent } from 'react'
import { Send, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ReferencePillPicker } from './reference-pill-picker'
import { compilePillContext, type ReferencePill } from './reference-pill-utils'
import { SuggestionChips } from './suggestion-chips'

interface ChatInputProps {
  disabled: boolean
  activeTurnId: string | null
  onSend(text: string): boolean
  onCancel(): boolean
}

export function ChatInput({ disabled, activeTurnId, onSend, onCancel }: ChatInputProps) {
  const [text, setText] = useState('')
  const [pills, setPills] = useState<ReferencePill[]>([])
  const taRef = useRef<HTMLTextAreaElement>(null)

  function handleSend(): void {
    if (!text.trim() || disabled) return
    const compiled = compilePillContext(pills)
    const fullPrompt = compiled ? `${compiled}\n\n${text}` : text
    const ok = onSend(fullPrompt)
    if (ok) {
      setText('')
      setPills([])
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const showCancel = activeTurnId !== null
  const inputDisabled = disabled || showCancel

  return (
    <div className="border-t border-border bg-background/40 shrink-0">
      <SuggestionChips
        disabled={inputDisabled}
        onPick={(prompt) => {
          setText(prompt)
          taRef.current?.focus()
        }}
      />
      <ReferencePillPicker
        pills={pills}
        disabled={inputDisabled}
        onAdd={(pill) => setPills((prev) => [...prev, pill])}
        onRemove={(index) => setPills((prev) => prev.filter((_, i) => i !== index))}
      />
      <div className="flex items-end gap-1.5 px-2 pt-1 pb-2">
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            disabled
              ? 'Connect the agent server to chat…'
              : showCancel
                ? 'Waiting for the agent…'
                : 'Type a message — Enter to send, Shift+Enter for newline'
          }
          rows={1}
          disabled={inputDisabled}
          className="flex-1 min-h-[36px] max-h-[140px] resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
        />
        {showCancel ? (
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-9 w-9"
            onClick={() => onCancel()}
            aria-label="Cancel turn"
            data-tooltip="Cancel"
            data-tooltip-side="top"
          >
            <X className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon"
            variant="default"
            className="h-9 w-9"
            disabled={inputDisabled || !text.trim()}
            onClick={handleSend}
            aria-label="Send message"
            data-tooltip="Send"
            data-tooltip-side="top"
          >
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  )
}
