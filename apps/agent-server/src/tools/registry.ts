import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import { echoTool } from './_stub.ts'
import { createTranscribeTool } from './transcribe.ts'

export const TOOL_MCP_SERVER_NAME = 'freecut'

export interface ToolRegistryOptions {
  bridge: BrowserActionBridge
  providers: ProvidersBundle
  abortSignal: AbortSignal
}

export function createToolMcpServer(options: ToolRegistryOptions) {
  return createSdkMcpServer({
    name: TOOL_MCP_SERVER_NAME,
    version: '0.0.0',
    tools: [echoTool, createTranscribeTool(options)],
  })
}

/**
 * Tool names the agent is allowed to call. Must use the MCP-prefixed form
 * `mcp__<server>__<tool>` for SDK-registered tools.
 */
export const ALLOWED_TOOL_NAMES = [
  `mcp__${TOOL_MCP_SERVER_NAME}__echo`,
  `mcp__${TOOL_MCP_SERVER_NAME}__transcribe`,
]
