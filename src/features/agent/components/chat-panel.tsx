import { memo } from 'react'
import { Trash2 } from 'lucide-react'
import { FloatingPanel } from '@/components/ui/floating-panel'
import { useAgentChat } from '../hooks/use-agent-chat'
import { ChatInput } from './chat-input'
import { MessageList } from './message-list'

interface ChatPanelProps {
  onClose(): void
}

export const ChatPanel = memo(function ChatPanel({ onClose }: ChatPanelProps) {
  const { messages, activeTurnId, isConnected, send, cancel, clear, respondToConfirmation } =
    useAgentChat()

  return (
    <FloatingPanel
      title="AGENT"
      storageKey="editor:chatPanelBounds"
      defaultBounds={{
        x: typeof window === 'undefined' ? 400 : Math.max(20, window.innerWidth - 420),
        y: typeof window === 'undefined' ? 80 : 80,
        width: 400,
        height: 520,
      }}
      minWidth={300}
      minHeight={300}
      onClose={onClose}
      headerExtra={
        <>
          <div
            className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground"
            title={isConnected ? 'Bridge connected' : 'Bridge disconnected'}
          >
            <span
              className={
                isConnected
                  ? 'h-1.5 w-1.5 rounded-full bg-emerald-500'
                  : 'h-1.5 w-1.5 rounded-full bg-destructive'
              }
            />
            {isConnected ? 'live' : 'offline'}
          </div>
          {messages.length > 0 && (
            <button
              type="button"
              className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50 transition-colors"
              onClick={clear}
              aria-label="Clear chat"
              title="Clear chat"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </>
      }
    >
      <div className="flex flex-col h-full min-h-0">
        <MessageList
          messages={messages}
          isLoading={activeTurnId !== null}
          onConfirm={respondToConfirmation}
        />
        <ChatInput
          disabled={!isConnected}
          activeTurnId={activeTurnId}
          onSend={send}
          onCancel={cancel}
        />
      </div>
    </FloatingPanel>
  )
})
