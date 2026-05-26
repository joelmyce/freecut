import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { echoTool } from './_stub.ts'

export const TOOL_MCP_SERVER_NAME = 'freecut'

export function createToolMcpServer() {
  return createSdkMcpServer({
    name: TOOL_MCP_SERVER_NAME,
    version: '0.0.0',
    tools: [echoTool],
  })
}

/**
 * Tool names the agent is allowed to call. Must use the MCP-prefixed form
 * `mcp__<server>__<tool>` for SDK-registered tools.
 */
export const ALLOWED_TOOL_NAMES = [`mcp__${TOOL_MCP_SERVER_NAME}__echo`]
