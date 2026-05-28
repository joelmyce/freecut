import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import { echoTool } from './_stub.ts'
import { createAddGifTool } from './add-gif.ts'
import { createAddSubtitlesTool } from './add-subtitles.ts'
import { createAnalyzeClipTool } from './analyze-clip.ts'
import { createAnimateImageTool } from './animate-image.ts'
import { createCutSilenceTool } from './cut-silence.ts'
import { createGenerateBrollTool } from './generate-broll.ts'
import { createGenerateImageTool } from './generate-image.ts'
import { createReplaceClipWithRegenerationTool } from './replace-clip-with-regeneration.ts'
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
    tools: [
      echoTool,
      createTranscribeTool(options),
      createAddSubtitlesTool({ bridge: options.bridge, abortSignal: options.abortSignal }),
      createGenerateBrollTool(options),
      createReplaceClipWithRegenerationTool(options),
      createCutSilenceTool({ bridge: options.bridge, abortSignal: options.abortSignal }),
      createAnalyzeClipTool(options),
      createGenerateImageTool(options),
      createAnimateImageTool(options),
      createAddGifTool(options),
    ],
  })
}

/**
 * Tool names the agent is allowed to call. Must use the MCP-prefixed form
 * `mcp__<server>__<tool>` for SDK-registered tools.
 */
export const ALLOWED_TOOL_NAMES = [
  `mcp__${TOOL_MCP_SERVER_NAME}__echo`,
  `mcp__${TOOL_MCP_SERVER_NAME}__transcribe`,
  `mcp__${TOOL_MCP_SERVER_NAME}__add_subtitles`,
  `mcp__${TOOL_MCP_SERVER_NAME}__generate_broll`,
  `mcp__${TOOL_MCP_SERVER_NAME}__replace_clip_with_regeneration`,
  `mcp__${TOOL_MCP_SERVER_NAME}__cut_silence`,
  `mcp__${TOOL_MCP_SERVER_NAME}__analyze_clip`,
  `mcp__${TOOL_MCP_SERVER_NAME}__generate_image`,
  `mcp__${TOOL_MCP_SERVER_NAME}__animate_image`,
  `mcp__${TOOL_MCP_SERVER_NAME}__add_gif`,
]
