import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import { echoTool } from './_stub.ts'
import { createAddGifTool } from './add-gif.ts'
import { createAddMotionGraphicTool } from './add-motion-graphic.ts'
import { createAddSubtitlesTool } from './add-subtitles.ts'
import { createAnalyzeClipTool } from './analyze-clip.ts'
import { createAnimateImageTool } from './animate-image.ts'
import { createCutSilenceTool } from './cut-silence.ts'
import { createDetectChaptersTool } from './detect-chapters.ts'
import { createFindMomentTool } from './find-moment.ts'
import { createGenerateBrollTool } from './generate-broll.ts'
import { createGenerateImageTool } from './generate-image.ts'
import { createGenerateVoiceoverTool } from './generate-voiceover.ts'
import { createReplaceClipWithRegenerationTool } from './replace-clip-with-regeneration.ts'
import { createSuggestTrimsTool } from './suggest-trims.ts'
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
      createFindMomentTool(options),
      createDetectChaptersTool(options),
      createSuggestTrimsTool(options),
      createGenerateImageTool(options),
      createAnimateImageTool(options),
      createAddGifTool(options),
      createGenerateVoiceoverTool(options),
      createAddMotionGraphicTool({ bridge: options.bridge, abortSignal: options.abortSignal }),
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
  `mcp__${TOOL_MCP_SERVER_NAME}__find_moment`,
  `mcp__${TOOL_MCP_SERVER_NAME}__detect_chapters`,
  `mcp__${TOOL_MCP_SERVER_NAME}__suggest_trims`,
  `mcp__${TOOL_MCP_SERVER_NAME}__generate_image`,
  `mcp__${TOOL_MCP_SERVER_NAME}__animate_image`,
  `mcp__${TOOL_MCP_SERVER_NAME}__add_gif`,
  `mcp__${TOOL_MCP_SERVER_NAME}__generate_voiceover`,
  `mcp__${TOOL_MCP_SERVER_NAME}__add_motion_graphic`,
]
