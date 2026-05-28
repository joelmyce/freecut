import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { BrowserActionBridge, ProvidersBundle } from '../providers/index.ts'
import { pickGifSearchProvider } from '../providers/gif/index.ts'
import type {
  GifSearchCandidate,
  GifSearchRating,
  GifSearchStrategy,
} from '../providers/gif/index.ts'

export interface CreateAddGifToolOptions {
  bridge: BrowserActionBridge
  providers: ProvidersBundle
  abortSignal: AbortSignal
}

interface InsertPlaceholderResult {
  placeholderId: string
  trackId: string
  from: number
  durationInFrames: number
}

interface SwapPlaceholderResult {
  clipId: string
  mediaId: string
  trackId: string
  from: number
  durationInFrames: number
}

/**
 * Default duration (seconds) for the gif on the timeline when the caller
 * doesn't pass `end_seconds`. Most reaction gifs loop in 1.5-3s; 3s lets
 * the loop play through once on a typical 30fps timeline.
 */
const DEFAULT_GIF_DURATION_SEC = 3

const inputSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      'Free-text search query passed to Giphy. Best results come from short, specific reaction phrases — "excited high five", "facepalm", "thumbs up dog", "mind blown" — rather than long sentences.',
    ),
  start_seconds: z
    .number()
    .min(0)
    .describe('Start of the gif clip on the project timeline, in seconds from project zero.'),
  end_seconds: z
    .number()
    .optional()
    .describe(
      `End of the gif clip on the timeline, in seconds. Optional — defaults to start_seconds + ${DEFAULT_GIF_DURATION_SEC}s when omitted. Must exceed start_seconds.`,
    ),
  rating: z
    .enum(['g', 'pg', 'pg-13', 'r'])
    .optional()
    .describe(
      'Giphy content-rating filter. Defaults to "g" — safest for general-audience editing.',
    ),
  candidate_index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Zero-based index into Giphy\'s top results when the user wants a specific candidate (e.g. "use the second one"). Defaults to 0 (top relevance result).',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe(
      'How many candidates to fetch from Giphy. Defaults to 5. Higher values cost nothing extra but bloat the tool result; bump this when offering the user a wider pick.',
    ),
  track_id: z
    .string()
    .optional()
    .describe(
      'Optional explicit timeline track id. Omit to drop the gif on a new track above existing media (matches generate_image / generate_broll).',
    ),
  provider: z
    .enum(['auto', 'giphy'])
    .optional()
    .describe(
      'Which gif provider to use. "auto" (default) picks Giphy — the only available source today.',
    ),
}

/**
 * `add_gif` — Giphy search + insert (M4.8 — see PHASE-1-PLAN.md §6.10).
 *
 * Calls Giphy's `/v1/gifs/search` endpoint, downloads the chosen GIF via
 * the M3 placeholder→swap pattern, and drops it on the timeline as an
 * image clip (FreeCut renders GIFs through the `image` timeline-item type
 * with the existing animated-frame cache). Single Ctrl+Z removes the
 * final clip.
 *
 * The default insertion duration is 3s when `end_seconds` is omitted —
 * matches a typical reaction-gif loop length. The caller can override
 * with `end_seconds` for longer holds (info-graphic gifs) or shorter
 * ones (split-second reactions).
 */
export function createAddGifTool(options: CreateAddGifToolOptions) {
  return tool(
    'add_gif',
    'Search Giphy for a reaction / illustrative GIF and drop it on the timeline at the requested time. Use for "react gif at the punchline", "excited reaction at 0:42", "facepalm here" — any moment where a short animated reaction beats a still image or full b-roll clip. Inserts a placeholder immediately; the chosen Giphy GIF swaps in once the download lands (typically 1-3s). Single Ctrl+Z removes the final clip.',
    inputSchema,
    async (args) => {
      const startSeconds = args.start_seconds
      const endSeconds = args.end_seconds ?? startSeconds + DEFAULT_GIF_DURATION_SEC
      if (endSeconds <= startSeconds) {
        throw new Error('end_seconds must be greater than start_seconds')
      }

      const strategy: GifSearchStrategy = args.provider ?? 'auto'
      const { provider, reason: routingReason } = pickGifSearchProvider(
        options.providers.gifSearch,
        strategy,
      )

      const limit = args.limit ?? 5
      const candidateIndex = args.candidate_index ?? 0
      const rating: GifSearchRating = args.rating ?? 'g'

      // 1) Insert placeholder before searching — the user gets immediate
      //    feedback that something is happening at the requested window.
      const placeholder = await options.bridge.invokeBrowserAction<InsertPlaceholderResult>(
        'insert-generation-placeholder',
        {
          startSeconds,
          endSeconds,
          prompt: args.query,
          trackId: args.track_id,
          providerId: provider.id,
          modelId: undefined,
        },
        options.abortSignal,
      )

      try {
        const searchResult = await provider.search(
          { query: args.query, limit, rating },
          { bridge: options.bridge, signal: options.abortSignal },
        )

        if (candidateIndex >= searchResult.candidates.length) {
          throw new Error(
            `candidate_index ${candidateIndex} is out of range — Giphy returned ${searchResult.candidates.length} result(s) for "${args.query}"`,
          )
        }

        const picked = searchResult.candidates[candidateIndex] as GifSearchCandidate

        const swap = await options.bridge.invokeBrowserAction<SwapPlaceholderResult>(
          'swap-generation-placeholder-with-url',
          {
            placeholderId: placeholder.placeholderId,
            sourceUrl: picked.sourceUrl,
            providerId: provider.id,
            modelId: searchResult.modelUsed,
            prompt: args.query,
            providerInputs: { rating, candidateIndex, giphyId: picked.id },
            mediaKind: 'image',
          },
          options.abortSignal,
        )

        const result = {
          clipId: swap.clipId,
          mediaId: swap.mediaId,
          trackId: swap.trackId,
          providerUsed: provider.id,
          modelUsed: searchResult.modelUsed,
          routingReason,
          mediaKind: 'image' as const,
          gif: {
            giphyId: picked.id,
            title: picked.title,
            sourceUrl: picked.sourceUrl,
            width: picked.width,
            height: picked.height,
          },
          candidates: searchResult.candidates.map((c) => ({
            giphyId: c.id,
            title: c.title,
            stillPreviewUrl: c.stillPreviewUrl,
          })),
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        }
      } catch (err) {
        const aborted = options.abortSignal.aborted || (err as Error)?.name === 'AbortError'
        if (aborted) {
          await safeInvoke(options.bridge, 'remove-generation-placeholder', {
            placeholderId: placeholder.placeholderId,
          })
          throw err
        }
        const errorMessage = err instanceof Error ? err.message : String(err)
        await safeInvoke(options.bridge, 'mark-generation-placeholder-error', {
          placeholderId: placeholder.placeholderId,
          errorMessage,
        })
        throw err
      }
    },
  )
}

async function safeInvoke(
  bridge: BrowserActionBridge,
  action: string,
  args: unknown,
): Promise<void> {
  try {
    const controller = new AbortController()
    await bridge.invokeBrowserAction(action, args, controller.signal)
  } catch {
    // ignore
  }
}
