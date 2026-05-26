import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ALLOWED_TOOL_NAMES, createToolMcpServer } from './tools/registry.ts'

const SYSTEM_PROMPT = `You are FreeCut's in-editor assistant. You help the user edit videos by calling high-level tools.

For this milestone (M0) you have one tool available:
- echo({ message }): repeats a message back verbatim.

When the user asks you to say or echo something, call the echo tool with the exact message they want repeated, then briefly confirm. Keep replies short.`

export interface RunAgentTurnOptions {
  turnId: string
  userText: string
  timelineSummary?: string
  abortSignal?: AbortSignal
  onMessage(event: AgentEvent): void
}

export type AgentEvent =
  | { kind: 'assistant-text'; text: string }
  | { kind: 'tool-call'; callId: string; toolName: string; args: unknown }
  | { kind: 'tool-result'; callId: string; result: unknown; isError: boolean }
  | { kind: 'turn-end' }
  | { kind: 'error'; message: string }

export async function runAgentTurn(options: RunAgentTurnOptions): Promise<void> {
  const { userText, timelineSummary, abortSignal, onMessage } = options

  const prompt = timelineSummary
    ? `${userText}\n\n<timeline-summary>\n${timelineSummary}\n</timeline-summary>`
    : userText

  const mcpServer = createToolMcpServer()

  try {
    for await (const msg of query({
      prompt,
      options: {
        mcpServers: { freecut: mcpServer },
        allowedTools: ALLOWED_TOOL_NAMES,
        // Disable all built-in tools (Bash, Read, Edit, ToolSearch, Skill, etc).
        // The editor agent only operates via MCP-registered tools — anything
        // else would be both unnecessary and a way for the model to escape
        // the editor surface. Without this, the M0 trace showed the agent
        // calling ToolSearch to discover our MCP tool before invoking it.
        tools: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        systemPrompt: SYSTEM_PROMPT,
        abortController: abortSignal ? toAbortController(abortSignal) : undefined,
      },
    })) {
      forwardSdkMessage(msg, onMessage)
      if (abortSignal?.aborted) break
    }
    onMessage({ kind: 'turn-end' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    onMessage({ kind: 'error', message })
    onMessage({ kind: 'turn-end' })
  }
}

function forwardSdkMessage(msg: SDKMessage, emit: (event: AgentEvent) => void): void {
  if (msg.type === 'assistant') {
    for (const block of msg.message.content) {
      if (block.type === 'text') {
        emit({ kind: 'assistant-text', text: block.text })
      } else if (block.type === 'tool_use') {
        emit({
          kind: 'tool-call',
          callId: block.id,
          toolName: block.name,
          args: block.input,
        })
      }
    }
    return
  }

  if (msg.type === 'user') {
    const content = msg.message.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      if ((block as { type?: string }).type !== 'tool_result') continue
      const toolResult = block as {
        type: 'tool_result'
        tool_use_id: string
        content?: unknown
        is_error?: boolean
      }
      emit({
        kind: 'tool-result',
        callId: toolResult.tool_use_id,
        result: toolResult.content,
        isError: toolResult.is_error === true,
      })
    }
  }
}

function toAbortController(signal: AbortSignal): AbortController {
  const controller = new AbortController()
  if (signal.aborted) {
    controller.abort()
  } else {
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller
}
