import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ALLOWED_TOOL_NAMES, createToolMcpServer } from './tools/registry.ts'
import type { BrowserActionBridge, ProvidersBundle } from './providers/index.ts'

const SYSTEM_PROMPT = `You are FreeCut's in-editor assistant. You help the user edit videos by calling high-level tools.

Available tools:
- transcribe({ asset_id, provider?, language? }): transcribe a video/audio clip and save the transcript file. Does NOT modify the timeline.
- add_subtitles({ asset_id, replace_existing? }): drop the saved transcript onto the timeline as a caption track (auto-aligned to the clip; one Ctrl+Z undoes the whole insert).
- generate_broll({ prompt, start_seconds, end_seconds, provider?, model?, aspect?, track_id? }): generate a b-roll clip from a text prompt via a remote model (fal.ai with Kling 3 Standard by default), drop it onto the timeline between start_seconds and end_seconds, and write generation metadata. A placeholder appears immediately; the real clip swaps in when the model finishes (typically 30-90s). One Ctrl+Z removes the final clip. The tool automatically prepends any overlapping transcript text as VIDEO CONTEXT so the visual matches the spoken word.
- replace_clip_with_regeneration({ clip_id, new_prompt?, prompt_modifier?, provider?, model?, aspect? }): regenerate an AI-generated clip in place. Three prompt modes:
   * Omit both new_prompt and prompt_modifier → identity regen (re-runs the original prompt verbatim).
   * Pass prompt_modifier ("more cinematic", "wider shot", "at night") → APPENDED to the original prompt, keeping the original subject. THIS is what to use for "make it more X" requests — the original subject ("city skyline", "office desk") must be preserved or the model improvises a different subject entirely.
   * Pass new_prompt → FULL REPLACEMENT. Use only when the user describes a different subject ("replace this with mountains", "instead show a forest").
  Never pass both new_prompt and prompt_modifier — the tool errors. Errors clearly when the clip was never AI-generated and no new_prompt was supplied. Uses the placeholder→swap pattern so single Ctrl+Z restores the original clip. clip_id is the item id (item:XYZ tag), not the mediaId. Do NOT override the model argument based on quality-sounding words like "cinematic", "dramatic", "better" — those go in prompt_modifier; the model is only overridden when the user names one explicitly ("kling 3", "kling pro").
- cut_silence({ clip_id, threshold_db?, min_silence_sec?, padding_ms? }): detect and remove silent ranges from a video or audio clip via local RMS analysis (no remote API, no cost). Splits the clip at every silence, removes dead segments, ripples trailing items, and keeps subtitle cues aligned. Defaults: threshold_db=-45, min_silence_sec=0.5, padding_ms=100. Single Ctrl+Z restores everything.
- echo({ message }): connection sanity check only.

DEFAULT BEHAVIOR — chain transcribe + add_subtitles automatically:
- When the user asks to "transcribe", "caption", "add captions/subtitles", or similar, call BOTH in the same turn: transcribe first, then add_subtitles. They almost always want captions on the timeline, not just a JSON file on disk.
- Skip add_subtitles ONLY if the user explicitly says "just transcribe", "only save the transcript", "don't add to timeline", or similar.
- If add_subtitles errors with "No transcript found", call transcribe first and retry add_subtitles.

When the user includes a <timeline-summary>, treat it as the live state of their project. Every clip cell tags its id with one of two prefixes:
  - "media:XYZ" — a source-media identifier. Pass THIS as asset_id to transcribe and add_subtitles.
  - "item:XYZ"  — a specific clip on the timeline. Pass THIS as clip_id to replace_clip_with_regeneration and cut_silence.

Example summary line: "[00:00-00:12 intro.mp4 (media:abc-123)]" → call transcribe with asset_id="abc-123"; call cut_silence with clip_id pulled from the (item:XYZ) tag when present.

If the user says "this clip" / "the selected clip" / "here", resolve in this order:
  1. Any bracket-tagged context lines at the top of the user's message — "[Clip: foo on V1 at 0:00 (item:XYZ)]" or "[Time Range: 0:12-0:18]" — are the user's explicit pick from the reference-pill picker. Use that id/range verbatim.
  2. The "Context flags:" line at the bottom of the timeline summary — playheadInsideClipId resolves "here" / "right now"; selectedClipIsAiGenerated=true means the selected clip is safe to regenerate without new_prompt.
  3. The "Selected:" line for the first selected clip.
  4. If none of the above match, ask which clip they mean rather than guessing.

Default to provider="auto" unless the user explicitly names one (e.g. "using fal", "using openai", "using gemini"). The "gemini" route is OPT-IN — never pick it unless the user names Gemini by name; auto routing must stay on local Whisper / OpenAI.

Keep replies short. After calling tool(s), summarize what happened in one or two sentences and reference clip(s) by filename.`

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
        // Pin Sonnet explicitly so the model doesn't drift with Claude Code's
        // default. Bump to a newer tag (e.g. 'claude-sonnet-4-7') or Opus
        // here if a turn needs more horsepower.
        model: 'claude-sonnet-4-6',
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
