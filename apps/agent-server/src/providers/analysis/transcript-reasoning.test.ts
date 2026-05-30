import { describe, expect, it, vi } from 'vitest'
import type { BrowserActionBridge, ProviderContext } from '../types.ts'
import {
  GeminiTranscriptReasoningProvider,
  pickTranscriptReasoningProvider,
  type ReasoningTranscript,
  type TranscriptReasoningProvider,
} from './transcript-reasoning.ts'

const TRANSCRIPT: ReasoningTranscript = {
  segments: [
    { text: 'Welcome to the show.', start: 0, end: 2 },
    { text: 'Today we talk about pricing.', start: 2, end: 5 },
    { text: 'Our plans start at ten dollars a month.', start: 5, end: 8 },
  ],
  language: 'en',
  durationSec: 8,
}

function dummyBridge(): BrowserActionBridge {
  return { invokeBrowserAction: async <T = unknown>() => ({}) as T }
}

function ctx(signal: AbortSignal): ProviderContext {
  return { bridge: dummyBridge(), signal }
}

/** A fetch impl that returns a Gemini generateContent envelope wrapping `modelOutput` as JSON text. */
function successFetch(modelOutput: unknown): typeof fetch {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: JSON.stringify(modelOutput) }] }, finishReason: 'STOP' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  ) as unknown as typeof fetch
}

function provider(fetchImpl: typeof fetch): GeminiTranscriptReasoningProvider {
  return new GeminiTranscriptReasoningProvider({
    apiKey: 'test-key',
    fetchImpl,
    generateUrlTemplate: 'https://mock.local/{model}:generateContent',
  })
}

describe('GeminiTranscriptReasoningProvider', () => {
  it('reports unavailable without an API key, available with one', () => {
    expect(new GeminiTranscriptReasoningProvider({ apiKey: undefined }).isAvailable()).toBe(false)
    expect(new GeminiTranscriptReasoningProvider({ apiKey: '   ' }).isAvailable()).toBe(false)
    expect(new GeminiTranscriptReasoningProvider({ apiKey: 'k' }).isAvailable()).toBe(true)
  })

  it('happy path: parses best match + alternatives (best-first)', async () => {
    const fetchImpl = successFetch({
      moments: [
        {
          sourceTimestampSec: 2,
          quote: 'Today we talk about pricing.',
          reason: 'directly introduces pricing',
          confidence: 0.95,
        },
        {
          sourceTimestampSec: 5,
          quote: 'Our plans start at ten dollars a month.',
          reason: 'gives a concrete price',
          confidence: 0.6,
        },
      ],
    })
    const result = await provider(fetchImpl).findMoment(
      { query: 'when do they mention pricing', transcript: TRANSCRIPT },
      ctx(new AbortController().signal),
    )

    expect(result.found).toBe(true)
    expect(result.best?.sourceTimestampSec).toBe(2)
    expect(result.best?.quote).toBe('Today we talk about pricing.')
    expect(result.alternatives).toHaveLength(1)
    expect(result.alternatives[0]?.sourceTimestampSec).toBe(5)
  })

  it('short-circuits an empty transcript without calling the API', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const result = await provider(fetchImpl).findMoment(
      { query: 'pricing', transcript: { segments: [], durationSec: 0 } },
      ctx(new AbortController().signal),
    )
    expect(result.found).toBe(false)
    expect(result.best).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns found=false for an empty moments array', async () => {
    const result = await provider(successFetch({ moments: [] })).findMoment(
      { query: 'unicorns', transcript: TRANSCRIPT },
      ctx(new AbortController().signal),
    )
    expect(result.found).toBe(false)
    expect(result.best).toBeNull()
    expect(result.alternatives).toEqual([])
  })

  it('coerces: clamps confidence and drops malformed moments', async () => {
    const result = await provider(
      successFetch({
        moments: [
          { sourceTimestampSec: 2, quote: 'valid', reason: 'r', confidence: 5 }, // confidence clamps to 1
          { sourceTimestampSec: 'bad', quote: 'x', reason: 'r', confidence: 0.5 }, // non-number ts → dropped
          { quote: 'no timestamp', reason: 'r', confidence: 0.5 }, // missing ts → dropped
          { sourceTimestampSec: 3, quote: '   ', reason: 'r', confidence: 0.5 }, // blank quote → dropped
        ],
      }),
    ).findMoment({ query: 'q', transcript: TRANSCRIPT }, ctx(new AbortController().signal))

    expect(result.found).toBe(true)
    expect(result.best?.quote).toBe('valid')
    expect(result.best?.confidence).toBe(1)
    expect(result.alternatives).toHaveLength(0)
  })

  it('throws on a non-OK response', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('upstream boom', { status: 500, statusText: 'Server Error' }),
    ) as unknown as typeof fetch
    await expect(
      provider(fetchImpl).findMoment(
        { query: 'q', transcript: TRANSCRIPT },
        ctx(new AbortController().signal),
      ),
    ).rejects.toThrow(/Gemini find_moment failed: 500/)
  })

  it('throws with the block reason when Gemini returns no text', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    ) as unknown as typeof fetch
    await expect(
      provider(fetchImpl).findMoment(
        { query: 'q', transcript: TRANSCRIPT },
        ctx(new AbortController().signal),
      ),
    ).rejects.toThrow(/blocked the find_moment request: SAFETY/)
  })

  it('throws when the response text is not valid JSON', async () => {
    await expect(
      provider(successFetchRaw('definitely not json')).findMoment(
        { query: 'q', transcript: TRANSCRIPT },
        ctx(new AbortController().signal),
      ),
    ).rejects.toThrow(/was not valid JSON/)
  })
})

/** Like `successFetch` but injects a raw (already-stringified) text body. */
function successFetchRaw(rawText: string): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: rawText }] } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch
}

/** A fetch impl that records the request body so tests can assert on the prompt. */
function capturingFetch(modelOutput: unknown, sink: { body: string }): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    sink.body = typeof init?.body === 'string' ? init.body : ''
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(modelOutput) }] } }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
}

describe('GeminiTranscriptReasoningProvider.detectChapters', () => {
  it('parses and sorts chapters by startSec', async () => {
    const result = await provider(
      successFetch({
        chapters: [
          { startSec: 120, title: 'Pricing' },
          { startSec: 0, title: 'Intro' },
        ],
      }),
    ).detectChapters({ transcript: TRANSCRIPT }, ctx(new AbortController().signal))

    expect(result.chapters.map((c) => c.startSec)).toEqual([0, 120])
    expect(result.chapters[0]?.title).toBe('Intro')
  })

  it('short-circuits an empty transcript without calling the API', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const result = await provider(fetchImpl).detectChapters(
      { transcript: { segments: [], durationSec: 0 } },
      ctx(new AbortController().signal),
    )
    expect(result.chapters).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('drops malformed chapters (bad startSec / blank title)', async () => {
    const result = await provider(
      successFetch({
        chapters: [
          { startSec: 0, title: 'Valid' },
          { startSec: 'bad', title: 'x' },
          { startSec: 30, title: '   ' },
          { title: 'no start' },
        ],
      }),
    ).detectChapters({ transcript: TRANSCRIPT }, ctx(new AbortController().signal))
    expect(result.chapters).toHaveLength(1)
    expect(result.chapters[0]?.title).toBe('Valid')
  })

  it('reflects granularity in the prompt', async () => {
    const fineSink = { body: '' }
    await provider(capturingFetch({ chapters: [] }, fineSink)).detectChapters(
      { transcript: TRANSCRIPT, granularity: 'fine' },
      ctx(new AbortController().signal),
    )
    expect(fineSink.body).toContain('granularly')

    const coarseSink = { body: '' }
    await provider(capturingFetch({ chapters: [] }, coarseSink)).detectChapters(
      { transcript: TRANSCRIPT, granularity: 'coarse' },
      ctx(new AbortController().signal),
    )
    expect(coarseSink.body).toContain('broad chapters')
  })

  it('uses the detect_chapters task label in errors', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('boom', { status: 500, statusText: 'Server Error' }),
    ) as unknown as typeof fetch
    await expect(
      provider(fetchImpl).detectChapters(
        { transcript: TRANSCRIPT },
        ctx(new AbortController().signal),
      ),
    ).rejects.toThrow(/Gemini detect_chapters failed: 500/)
  })
})

describe('GeminiTranscriptReasoningProvider.suggestTrims', () => {
  it('parses, sorts by startSec, and caps at maxTrims', async () => {
    const result = await provider(
      successFetch({
        trims: [
          { startSec: 30, endSec: 35, reason: 'long pause' },
          { startSec: 5, endSec: 9, reason: 'rambling' },
          { startSec: 50, endSec: 52, reason: 'repeat' },
        ],
      }),
    ).suggestTrims({ transcript: TRANSCRIPT, maxTrims: 2 }, ctx(new AbortController().signal))

    expect(result.trims.map((t) => t.startSec)).toEqual([5, 30])
    expect(result.trims[0]?.reason).toBe('rambling')
  })

  it('short-circuits an empty transcript without calling the API', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const result = await provider(fetchImpl).suggestTrims(
      { transcript: { segments: [], durationSec: 0 } },
      ctx(new AbortController().signal),
    )
    expect(result.trims).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('drops invalid trims (end <= start, non-numeric bounds)', async () => {
    const result = await provider(
      successFetch({
        trims: [
          { startSec: 5, endSec: 9, reason: 'ok' },
          { startSec: 9, endSec: 9, reason: 'zero-length' },
          { startSec: 20, endSec: 10, reason: 'inverted' },
          { startSec: 'x', endSec: 5, reason: 'bad type' },
        ],
      }),
    ).suggestTrims({ transcript: TRANSCRIPT }, ctx(new AbortController().signal))
    expect(result.trims).toHaveLength(1)
    expect(result.trims[0]?.reason).toBe('ok')
  })

  it('passes the goal into the prompt', async () => {
    const sink = { body: '' }
    await provider(capturingFetch({ trims: [] }, sink)).suggestTrims(
      { transcript: TRANSCRIPT, goal: 'remove the rambling intro' },
      ctx(new AbortController().signal),
    )
    expect(sink.body).toContain('remove the rambling intro')
  })

  it('uses the suggest_trims task label in errors', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('boom', { status: 500, statusText: 'Server Error' }),
    ) as unknown as typeof fetch
    await expect(
      provider(fetchImpl).suggestTrims(
        { transcript: TRANSCRIPT },
        ctx(new AbortController().signal),
      ),
    ).rejects.toThrow(/Gemini suggest_trims failed: 500/)
  })
})

describe('pickTranscriptReasoningProvider', () => {
  const available: TranscriptReasoningProvider = new GeminiTranscriptReasoningProvider({
    apiKey: 'k',
  })
  const unavailable: TranscriptReasoningProvider = new GeminiTranscriptReasoningProvider({
    apiKey: undefined,
  })

  it('auto resolves to an available gemini provider', () => {
    const { provider: picked, reason } = pickTranscriptReasoningProvider([available], 'auto')
    expect(picked.id).toBe('gemini-flash-transcript')
    expect(reason).toMatch(/auto: defaulting to gemini/)
  })

  it('explicit gemini throws when unavailable', () => {
    expect(() => pickTranscriptReasoningProvider([unavailable], 'gemini')).toThrow(
      /not available \(missing GEMINI_API_KEY/,
    )
  })

  it('throws when no provider is available', () => {
    expect(() => pickTranscriptReasoningProvider([], 'auto')).toThrow(
      /No transcript-reasoning provider is available/,
    )
    expect(() => pickTranscriptReasoningProvider([unavailable], 'auto')).toThrow(
      /No transcript-reasoning provider is available/,
    )
  })
})
