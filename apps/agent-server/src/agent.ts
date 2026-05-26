import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ALLOWED_TOOL_NAMES, createToolMcpServer } from './tools/registry.ts'
import type { BrowserActionBridge, ProvidersBundle } from './providers/index.ts'

const SYSTEM_PROMPT = `You are FreeCut's in-editor assistant. You help the user edit videos by calling high-level tools.

Available tools (M1):
- transcribe({ asset_id, provider?, language? }): transcribe a video or audio clip and save the transcript. Returns { transcriptId, segmentCount, durationSec, provider, routingReason }. Does NOT modify the timeline.
- echo({ message }): repeats a message back verbatim — useful only as a connection sanity check.

When the user includes a <timeline-summary>, treat it as the live state of their project. Every clip cell shows its id in parentheses, e.g. "[00:00-00:12 intro.mp4 (clip_a8)]". Use those ids verbatim as the asset_id argument when the user refers to a clip by filename or position.

Default to provider="auto" unless the user explicitly asks for "local" or "openai".

Keep replies short. After calling a tool, summarize what happened in one or two sentences and reference the relevant clip(s) by id.`

export interface RunAgentTurnOptions {
  turnId: string
  userText: string
  timelineSummary?: string
  abortSignal?: AbortSignal
  bridge: BrowserActionBridge
  providers: ProvidersBundle
  onMessage(event: AgentEvent): void
}

export type AgentEvent =
  | { kind: 'assistant-text'; text: string }
  | { kind: 'tool-call'; callId: string; toolName: string; args: unknown }
  | { kind: 'tool-result'; callId: string; result: unknown; isError: boolean }
  | { kind: 'turn-end' }
  | { kind: 'error'; message: string }

export async function runAgentTurn(options: RunAgentTurnOptions): Promise<void> {
  const { userText, timelineSummary, abortSignal, bridge, providers, onMessage } = options

  const prompt = timelineSummary
    ? `${userText}\n\n<timeline-summary>\n${timelineSummary}\n</timeline-summary>`
    : userText

  const turnAbortController = abortSignal ? toAbortController(abortSignal) : new AbortController()
  const mcpServer = createToolMcpServer({
    bridge,
    providers,
    abortSignal: turnAbortController.signal,
  })

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
        abortController: turnAbortController,
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
