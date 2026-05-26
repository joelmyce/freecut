import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * M0 stub tool. Used only to verify the end-to-end bridge round-trips —
 * delete once real tools (`transcribe`, `add_subtitles`, ...) replace it.
 */
export const echoTool = tool(
  'echo',
  'Echo a message back to the user. Use this when the user asks you to repeat, echo, or say something verbatim.',
  {
    message: z.string().describe('The exact message to echo back'),
  },
  async ({ message }) => ({
    content: [{ type: 'text', text: message }],
  }),
)
