# Phase 1 — Implementation Plan

**Status:** In progress. **M0 + M1 + M2 + M3 complete and user-verified
(2026-05-26)** — agent server, WS bridge, chat panel UI, `transcribe`
(local Whisper + OpenAI), `add_subtitles` (with auto-chain from
`transcribe`), and `generate_broll` (fal video provider with placeholder
→ swap pattern) all working end-to-end on `feat/ai-agent`. **M4
code shipped 2026-05-26 — `replace_clip_with_regeneration`,
`cut_silence`, transcript-grounded prompts retrofit, chat-panel UX
upgrades (chips + pill picker + UI flags), opt-in Gemini Flash
transcription provider. Uncommitted pending end-to-end verification
(workspace-gate blocks headless visual tests).** **M5 (`generate_voiceover`)
is next once M4 verification lands.** See
`~/.claude/projects/-Users-joelm-Documents-Antigravity-FreeCut/memory/ai-video-editor-status.md`
for the live commit log, bookkeeping debts, and the M4 verification
checklist.

Generated from the build brief + `docs/ARCHITECTURE.md` §5–§6 after Phase 0
reconnaissance.

**Premise:** Phase 1 builds **Workflow 2 first** — AI-assisted timeline editing
via a chat agent. Workflow 1 (storyboard view) is Phase 2. Per the brief's
discipline rule, each tool we build should be one the user actually needs for
the next video on their desk.

---

## 1. Goal & Scope

### What "Phase 1 done" means

A working **chat panel** inside the FreeCut editor, connected to a **local
Node agent server** that runs the Claude Agent SDK using the user's Claude
Code / Max subscription. The agent exposes ~7 high-level tools and can,
on request, mutate the timeline of a real project.

End-state demo: open FreeCut → open a project with an existing video clip →
type `"transcribe this and add subtitles, then drop a B-roll of a city skyline
between 00:12 and 00:18"` into the chat panel → watch transcription run,
captions appear, a generation placeholder land on the timeline, and the real
B-roll replace the placeholder ~30s later.

### Explicitly in scope

- Local agent server (Node, separate process) with WebSocket bridge to browser
- Chat panel UI as a new resizable panel in `editor.tsx`
- Tool registry holding ~7 tools (per the brief): `transcribe`,
  `add_subtitles`, `generate_broll`, `replace_clip_with_regeneration`,
  `cut_silence`, `generate_voiceover` + the deferred `add_lower_third`
  (Hyperframe-dependent)
- Provider abstraction for transcription (local + OpenAI) and video
  generation (fal + kie). TTS provider (Kokoro + ElevenLabs)
- **Opt-in Gemini Flash analysis provider (`gemini-3.5-flash`)** — used
  only when the user explicitly asks ("…using gemini"). Default routing
  is unchanged (Whisper for transcription, local LFM for visual
  captioning, RMS for silence). Wired via the existing capability/
  router pattern (see §6.5 for the cross-cutting work).
- Generation metadata persisted to disk via the existing AI-output envelope
- `summarizeTimelineForAgent()` helper sent in every system prompt
- Cancellation, basic error surfacing, undo-friendly mutations

### Explicitly out of scope

- Storyboard view, scene cards, "send to timeline" (Phase 2)
- Hyperframe tool surface (`add_lower_third`, `add_avatar_clip`, etc.)
  — deferred to M6 once Hyperframe API docs are in hand. **Reaffirmed
  2026-05-26:** Hyperframe is the path for AI-generated talking-head /
  avatar / lower-third content. We will not adopt Remotion as an
  alternative — FreeCut's existing GPU compositor (text, shapes,
  transitions, keyframes) renders everything on-timeline. Sibling
  projects that wire Remotion + a CLI render farm are solving a
  problem we don't have.
- Multi-agent / parallel tool execution. **Architecture commitment:**
  one Claude Sonnet orchestrator with all tools; specialized providers
  (Gemini, fal, ElevenLabs, Hyperframe) are *capabilities* the
  orchestrator reaches for as MCP tools, never co-agents the user
  routes to. HyperEdit's sibling-agents-in-tabs pattern (Director /
  Picasso / DiCaprio) is rejected — forcing the user to know which
  agent does what is the wrong abstraction. See
  [AI-EDITOR-VISION.md](AI-EDITOR-VISION.md) §2.
- Settings UI for provider selection (use `.env` for v1)
- Production packaging / single-binary distribution
- Tool failure recovery beyond "report error to chat and stop"
- **LLM-generated FFmpeg command strings.** High-level tools call
  FreeCut actions internally; the LLM never writes shell or FFmpeg
  invocations directly. Documented here because at least one sibling
  AI editor (HyperEdit) does exactly this and it's an RCE surface we
  decline.
- **Skills (Claude Agent SDK skill registration)** — deferred to
  M7+ once workflows are stable. Architecture today already supports
  it: the agent server uses the Claude Agent SDK which loads skills
  via the same MCP machinery as tools. Tools we ship now must remain
  composable into future skills — see [AI-EDITOR-VISION.md
  §13](AI-EDITOR-VISION.md) for the two architectural constraints
  (side-effect annotation, separate read/write across the bridge).

---

## 2. Pre-Phase-1 Prerequisites

Five items, in build order. Nothing else starts until 2.1 is real.

### 2.1 Local agent-server scaffold *(gated by Q1 — must come first)* ✅ **DONE (M0)**

**Location:** `apps/agent-server/` — new top-level directory, sibling to `src/`.

**Why a sibling instead of a `src/server/` folder:** the server is its own
process with its own `package.json` (Agent SDK, `ws`, `dotenv`, no React/Vite
deps). Keeping it physically separate makes the boundary obvious and lets us
ship it independently later.

**Files to create:**

| Path | Purpose |
|---|---|
| `apps/agent-server/package.json` | Server deps + scripts |
| `apps/agent-server/tsconfig.json` | Node-targeted TS config |
| `apps/agent-server/src/index.ts` | Entry — boots WS server on port 5174 |
| `apps/agent-server/src/agent.ts` | Agent SDK setup, system prompt assembly |
| `apps/agent-server/src/bridge/server.ts` | WebSocket protocol implementation |
| `apps/agent-server/src/bridge/protocol.ts` | Shared message types |
| `apps/agent-server/src/tools/registry.ts` | Tool registration + dispatch |
| `apps/agent-server/src/tools/_stub.ts` | One stub tool for end-to-end test |

**Bridge protocol (sketch — final shape settled during 2.1):**

```
Browser → Server:
  { type: 'user-message', text, timelineSummary, selection }
  { type: 'browser-action-result', requestId, result | error }
  { type: 'state-changed', changedKeys: [...] }

Server → Browser:
  { type: 'agent-message', text }
  { type: 'tool-call', toolName, args, callId }
  { type: 'tool-progress', callId, stage, fraction? }
  { type: 'tool-result', callId, result | error }
  { type: 'invoke-browser-action', requestId, action, args }
  { type: 'mutate-timeline', requestId, action, args }   // shorthand for common case
```

**Browser-side mounting:** new file `src/features/agent/bridge/client.ts` opens
a WebSocket to `ws://localhost:5174`, dispatches `invoke-browser-action`
requests against a small action registry, and emits state events.

**npm scripts (added to root `package.json`):**

- `dev:agent` — runs the agent server in watch mode (probably `tsx watch`)
- `dev:all` — runs `dev` and `dev:agent` in parallel (use `npm-run-all` or
  the existing `scripts/run-dev-and-perf.mjs` pattern)

**Acceptance:**

- `npm run dev:agent` starts on port 5174 and logs `agent server ready`
- `npm run dev:all` starts both processes; browser console shows
  `[agent] connected`
- A stub tool (`echo`) round-trips: user types `say hi`, agent calls
  `echo("hi")`, agent message echoes back
- Disconnecting/reconnecting the WebSocket recovers cleanly (no infinite loop)

### 2.2 Provider abstraction layer *(gated by Q7 + Q12)*

**Location:** `apps/agent-server/src/providers/` (server-side, since most
providers are remote API calls). Browser-delegated providers live there too
but their implementations send a `invoke-browser-action` request.

**Interfaces (Phase 1 only — narrow to what we need):**

```ts
interface TranscriptionProvider {
  id: string  // 'local-whisper' | 'openai-whisper'
  isAvailable(): boolean  // checks env / browser capability
  transcribe(input: TranscriptionInput, ctx: ProviderContext): Promise<Transcript>
}

interface VideoGenerationProvider {
  id: string  // 'fal' | 'kie'
  isAvailable(): boolean
  generate(input: VideoGenInput, ctx: ProviderContext): Promise<VideoGenResult>
}

interface TtsProvider {
  id: string  // 'kokoro' | 'elevenlabs'
  isAvailable(): boolean
  synthesize(input: TtsInput, ctx: ProviderContext): Promise<TtsResult>
}
```

`ProviderContext` carries the bridge handle (for browser-delegated providers),
the workspace path resolver, an `AbortSignal`, and a progress callback.

**Concrete Phase 1 implementations:**

- `LocalWhisperBrowserProxy` — `id: 'local-whisper'`, delegates to
  `invoke-browser-action: 'transcribe-local'`
- `OpenAIWhisperProvider` — `id: 'openai-whisper'`, fetches audio bytes from
  browser, POSTs to OpenAI, writes transcript to workspace via browser
- `FalVideoProvider` — `id: 'fal'`, calls fal API directly
- `KieVideoProvider` — `id: 'kie'`, calls kie API directly
- `KokoroBrowserProxy` — `id: 'kokoro'`, delegates to browser's existing
  `kokoroTtsService`
- `ElevenLabsProvider` — `id: 'elevenlabs'`, calls ElevenLabs API directly

**Routing:** each capability has an `auto` strategy. Default rules:

- Transcription: duration < 30 min and clip is short-form → local; else
  cloud (if available)
- Video gen: `auto` picks the cheapest available model that meets duration
  and aspect requirements
- TTS: local by default; cloud if a specific voice ID is requested

**Acceptance:**

- Each provider has a unit test stub (`isAvailable()` returns truthy when
  expected, `transcribe()` honors the abort signal, etc.)
- The routing helper has tests for the auto strategies

### 2.3 `summarizeTimelineForAgent()` *(gated by Q8)*

**Location:** `src/shared/state/agent/summarize-timeline.ts`.

**Signature:** `summarizeTimelineForAgent(): string` — reads from the timeline
stores directly via `.getState()`. Returns a compact human-readable summary
under ~500 tokens.

**Reference output:**

```
Timeline — 30 fps, 1920x1080, 4:32 total
  V2  [00:00–00:12 intro.mp4 (clip_a8)] [00:18–00:45 scene1.mp4 (clip_b3)]
  V1  [00:00–04:32 background.mp4 (clip_c1, muted)]
  A1  [00:00–04:32 voiceover.wav (clip_d2)]
  Captions  [12 segments, 00:18–04:30 (clip_e7)]
Selected: clip_b3 "scene1.mp4"
Playhead: 00:34   In:00:18  Out:04:30
Pending generations: 0
```

**Tests (next to source):** empty timeline, single track, multi-track with
gaps, gaps before selection, with sub-composition active (notes it as
`[in composition "X"]`), with in/out points only.

**Used by:** browser injects this into every `user-message` payload. Server
includes it verbatim in the system prompt for the agent turn.

### 2.4 Generation-metadata `AiOutputKind`

**Location:** `src/infrastructure/storage/workspace-fs/ai-outputs/` — add
`'generation'` to the kind enum and type its payload.

```ts
type GenerationOutput = {
  kind: 'generation'
  schemaVersion: 1
  provider: 'fal' | 'kie' | 'elevenlabs' | 'hyperframe' | 'openai-tts' | string
  model: string
  prompt: string
  cost?: { amount: number; currency: 'USD' }
  sourceUrl?: string
  generatedAt: number
  durationSec?: number
  inputs?: Record<string, unknown>
}
```

**Stored at:** `media/{id}/cache/ai/generation.json`.

**Used by:** `replace_clip_with_regeneration` for original-prompt recovery;
chat panel for cost display; future cost-tracking dashboard.

**Acceptance:** read/write roundtrip via existing `readAiOutput` /
`writeAiOutput` helpers.

### 2.5 Schema-version bump

**Skipped in Phase 1** — no project-schema changes needed. Phase 2 will bump
when `Project.storyboard` lands. Mentioned here only so the plan is honest
about why this prereq is a no-op.

---

## 3. Tool 1 — `transcribe`

**Signature:**
```
transcribe(asset_id: string, provider?: 'auto' | 'local' | 'openai') → {
  transcriptId, segmentCount, durationSec, provider
}
```

**No timeline writes.** First end-to-end test of the full stack:
agent → server tool → provider → browser delegation → disk write → response.

**Server-side flow:**

1. Resolve `asset_id` to a `MediaMetadata` (ask browser for it)
2. Pick provider via routing (`auto` checks duration + key availability)
3. If `local-whisper`: send `invoke-browser-action: 'transcribe-local'`;
   browser calls existing `mediaTranscriptionService.transcribeMedia()`;
   transcript is saved by the browser to its existing path
4. If `openai-whisper`: request audio bytes from browser (the browser
   already conforms unsupported codecs to WAV — reuse that); POST to
   `/v1/audio/transcriptions`; send transcript back to browser to write via
   `saveTranscript(transcript)`
5. Either way, return `{ transcriptId: mediaId, segmentCount, durationSec, provider }`

**Progress:** local-whisper streams segment-by-segment (existing pattern);
forward as `tool-progress` events. OpenAI is single-shot — report
`uploading`, `transcribing`, `saving`.

**Cancellation:** abort signal cancels in-flight provider work. Local
Whisper uses the existing `cancelTranscription`; OpenAI uses `fetch` with
abort signal.

**Acceptance criteria:**

- User types `"transcribe clip foo"` in chat → transcript file appears at
  `{workspace}/media/{id}/cache/ai/transcript.json`
- Both providers selectable (`provider: 'local'` and `provider: 'openai'`)
- Existing FreeCut transcribe dialog continues to work unchanged
- Long video (>30 min) auto-routes to OpenAI when key is set
- Cancellation cleanly stops the in-flight job

---

## 4. Tool 2 — `add_subtitles`

**Signature:**
```
add_subtitles(asset_id: string, options?: {
  style?: string         // TextStylePresetId
  replaceExisting?: boolean
}) → { trackId, insertedItemCount, removedItemCount }
```

**First real timeline write.** Tests the `mutate-timeline` bridge path.

**Server-side flow:**

1. Check if transcript exists at `media/{id}/cache/ai/transcript.json`. If
   not, call `transcribe` first (composed tool call, agent-visible)
2. Send `mutate-timeline: 'add-subtitles'` to browser
3. Browser calls existing `mediaTranscriptionService.insertTranscriptAsCaptions(mediaId, options)`
4. Return inserted item count + caption track ID

**Why this is easy:** the existing `insertTranscriptAsCaptions` already
handles caption-track auto-creation, cue alignment to clip ranges, source
mapping (`SubtitleSegmentItem` with `source: { type: 'transcript', clipId }`),
and undo integration. The tool is barely more than a wrapper.

**Acceptance criteria:**

- User types `"add subtitles to clip foo"` → caption track appears with
  aligned cues
- If transcript missing, the agent transparently calls `transcribe` first
- `Ctrl+Z` removes the caption insertions in a single undo step
- `replaceExisting: true` overwrites previous auto-generated captions for
  the same clip

---

## 5. Tool 3 — `generate_broll`

**Status: shipped + user-verified 2026-05-26.** Implementation choices made
during the build:

- **Default model:** `fal-ai/kling-video/v1.5/standard/text-to-video` —
  picked for speed, cost, and stability. Override via the tool's `model`
  arg (e.g. `fal-ai/kling-video/v3/standard/text-to-video` for Kling 3.0).
- **Model-aware request body:** legacy Kling family (v1 / v1.5 / v2.x) gets
  `{prompt, aspect_ratio, duration: "5"|"10"}` with a 7.5s snap point;
  Kling v3 gets `{prompt, aspect_ratio, duration: "3"-"15", generate_audio:
  false}`. Detection via regex on `/kling-video/v3` in the model id.
- **Placeholder:** flagged `ShapeItem` with an `aiPlaceholder` meta field
  (chosen over a new TimelineItem `type` to keep the surface small —
  v1 ships, ergonomics can promote later).
- **Atomic swap:** `_removeItems` + `_addItem` inside a custom undo entry
  whose `beforeSnapshot` is the *pre-generation* state (captured at
  placeholder insert). Single Ctrl+Z rewinds past the placeholder; second
  Ctrl+Z is a no-op. Insert/error/remove paths bypass the undo stack
  entirely (they're not user actions).
- **Track placement:** always creates a fresh "AI Generated" video track
  above existing tracks unless `track_id` is supplied. Earlier "reuse
  topmost track" behavior was a bug — fixed in the same session.
- **Media library integration:** swap handler uses the *store action*
  `useMediaLibraryStore.getState().importMediaFromUrl(url)` (not the
  bare service) so the clip appears in the library UI. Imported media
  gets `aiGenerated: {provider, model, prompt, generatedAt}` on its
  `MediaMetadata`, which the card UI surfaces as an indigo Wand2 badge.
- **Tool-progress streaming:** not wired in v1. Placeholder visibility +
  the final swap are the user-facing progress feedback. Wire later if
  needed for long-running models.

**M4-era retrofit (planned, see §6.5):** transcript-grounded prompt
expansion. When a transcript exists for the requested time range, the
tool prepends the segment to the model prompt as a `VIDEO CONTEXT`
block with explicit instructions to use specific terms from it. Pure
quality lift, no schema change, free given M1 already produces
transcripts. Same retrofit lands on `replace_clip_with_regeneration`
(§6.1).

**Signature:**
```
generate_broll(
  prompt: string,
  start_seconds: number,
  end_seconds: number,
  options?: {
    provider?: 'auto' | 'fal' | 'kie'
    model?: string
    aspect?: '16:9' | '9:16' | '1:1'
    track_id?: string  // defaults to a new video track above current
  }
) → { clipId, providerUsed, modelUsed, cost, durationSec }
```

**This is the keystone tool.** It establishes the **placeholder → insert
pattern** that every later async generation reuses (`replace_clip_with_regeneration`,
`generate_voiceover`, eventually all Hyperframe tools).

**The pattern (this is what we're really designing here):**

1. **Plan:** validate the time range fits the timeline; resolve target
   `trackId` (find or create); compute `from`/`durationInFrames`
2. **Insert placeholder:** browser calls a new `_insertGenerationPlaceholder`
   action that adds a special ghost TimelineItem at the chosen range. Visual:
   thin animated dotted border, prompt text inside, "generating…" label. The
   placeholder is an ordinary `TimelineItem` with `type: 'shape'` (or a new
   `'placeholder'` discriminant if shape doesn't fit cleanly) and a flag
   marking it as generated-and-replaceable
3. **Call provider:** `videoGenerationProvider.generate({prompt, aspect, …})`;
   poll for completion; forward progress as `tool-progress` events
4. **Download:** stream the result to a temporary blob in OPFS
5. **Register:** call `useMediaLibraryStore.getState().importMediaFromUrl(blobUrl)`
   (via browser-action) which writes to `media/{id}/`
6. **Write generation metadata:** save `GenerationOutput` to
   `media/{id}/cache/ai/generation.json`
7. **Atomic swap:** browser calls a new `_swapPlaceholderWithMedia` action
   that removes the placeholder and inserts the real `VideoItem` at the
   same `from`/`durationInFrames` — wrapped in one `execute()` so it's a
   single undo entry. The new item's ID can either reuse the placeholder ID
   (keeps any references stable) or be new (simpler — placeholder had no
   references)
8. **Return** `{ clipId, providerUsed, modelUsed, cost, durationSec }`

**Cancellation:** chat panel shows a "cancel" button while the placeholder
is on the timeline. Cancel removes the placeholder and aborts the provider
call.

**Failure:** placeholder transitions to error visual; chat shows error
message; user can either remove the placeholder or retry via the chat.

**Settled during M3 build:**

- *Placeholder shape:* flagged `'shape'` with `aiPlaceholder` meta. New
  TimelineItem `type` deferred — would have rippled into schema migrations,
  renderer branches, and every action's validators for negligible UX gain.
- *Atomic swap mechanism:* `_removeItems` + `_addItem` inside a custom
  undo entry constructed via `useTimelineCommandStore.getState().addUndoEntry`
  with a pre-generation snapshot. More honest than `updateItem` (the new
  item really is new) and lets the placeholder skip the undo stack entirely.

**Acceptance criteria:**

- User says `"add B-roll of a city night skyline between 00:12 and 00:18 using fal"`
  → placeholder appears immediately at 00:12–00:18 on a new video track
- Chat shows progress; ~30s later, the placeholder is replaced with a real clip
- Cancel during generation removes placeholder, no orphan media on disk
- Failure leaves a visible error placeholder; one-click retry from chat
- `media/{id}/cache/ai/generation.json` records prompt, model, cost
- Single `Ctrl+Z` removes the final clip; a second `Ctrl+Z` is a no-op
  (because the placeholder was an internal state, not a user action)

---

## 6. Tools 4–7

Shorter — reuse patterns from §3–§5.

### 6.1 `replace_clip_with_regeneration` ✅ **shipped 2026-05-26**

**Signature (as shipped):**
```
replace_clip_with_regeneration(clip_id, new_prompt?, provider?, model?, aspect?)
  → { clipId, mediaId, trackId, providerUsed, modelUsed, cost,
      durationSec, routingReason, usedTranscriptContext,
      reusedOriginalPrompt }
```

**Built at:**
- Server tool: [`apps/agent-server/src/tools/replace-clip-with-regeneration.ts`](../apps/agent-server/src/tools/replace-clip-with-regeneration.ts)
- Browser handlers: [`src/features/agent/handlers/regenerate-clip.ts`](../src/features/agent/handlers/regenerate-clip.ts)
  (`read-clip-for-regen` + `replace-clip-with-placeholder`)
- Browser action: `replaceClipWithPlaceholder()` in
  [`src/features/timeline/stores/actions/ai-generation-actions.ts`](../src/features/timeline/stores/actions/ai-generation-actions.ts)

**Reuses:** generate_broll's placeholder→insert pattern verbatim — the
swap step calls the *same* `swap-generation-placeholder-with-url`
handler M3 ships. Only the "insert placeholder" half differs (it
removes an existing clip first instead of creating a new track).

**New bits:**
1. Reads the clip's `media/{id}/cache/ai/generation.json` envelope via
   `readAiOutput()`. If `new_prompt` is omitted, regenerates with the
   recovered original prompt + model. If the clip wasn't AI-generated
   (no envelope file) **and** no `new_prompt` was supplied, errors
   *before* any timeline mutation: `"Clip <id> was not AI-generated …
   Pass new_prompt explicitly to regenerate it from scratch."`.
2. Provider preference: explicit `provider:` arg > original
   `generation.service` (when still available) > 'auto' routing. Model:
   explicit > original (only when provider matches) > provider default.
3. `replaceClipWithPlaceholder` captures a pre-mutation snapshot, removes
   the original clip + its transitions/keyframes, inserts the
   placeholder in the same track/from/duration. The snapshot lives in
   the same `pendingSnapshots` map M3 introduced, so the eventual
   `swapPlaceholderWithMedia` pushes ONE undo entry rewinding past the
   whole regen.

**Design decision (reaffirmed at ship): placeholder→swap, not in-place
file overwrite.** HyperEdit
(`scripts/local-ffmpeg-server.js:handleEditAnimation`) ships an in-place
overwrite — same `assetId`, same on-disk filename, browser cache-busts
via `?v=Date.now()`. We stuck with **placeholder→swap** because it
(a) matches M3 so the undo semantics stay consistent (single Ctrl+Z
rewinds past the placeholder), (b) avoids cache-invalidation surface
area on `sourceFps`/`sourceDuration`/waveform/reverse-conform caches,
and (c) lets the user keep seeing the existing clip while the new one
is rendering. Verified path-of-implementation: the regen clip lands in
the media library as a *new* MediaMetadata with its own `aiGenerated`
badge + `generation.json` — the original is untouched on disk so Ctrl+Z
restores it without re-import.

**Transcript grounding:** built in by default. The
`read-clip-for-regen` handler reads the clip's own transcript via
`getTranscript(mediaId)`, slices segments overlapping the clip's
source-time window (translating via `sourceFps`), and the server
prepends them to the prompt via `buildTranscriptContextBlock()` (shared
helper at [`prompt-grounding.ts`](../apps/agent-server/src/tools/prompt-grounding.ts)).
Best-effort — `transcriptContext: null` flows through unchanged. Result
exposes `usedTranscriptContext: boolean` for the agent to quote.

**Tests:** 6 cases at
[`replace-clip-with-regeneration.test.ts`](../apps/agent-server/src/tools/replace-clip-with-regeneration.test.ts)
covering: reuse original prompt, non-AI clip error, non-AI clip with
new_prompt success, transcript grounding, provider failure cleanup,
abort cleanup.

### 6.2 `cut_silence` ✅ **shipped 2026-05-26**

**Signature (as shipped):**
```
cut_silence(clip_id, threshold_db?=-45, min_silence_sec?=0.5, padding_ms?=100)
  → { clipId, silenceRangeCount, removedDurationSec, splitCount,
      removedItemCount, thresholdDb, minSilenceSec }
```

**Pure local — no external API.** First "local processing tool" in the
agent surface.

**Built at:**
- Server tool: [`apps/agent-server/src/tools/cut-silence.ts`](../apps/agent-server/src/tools/cut-silence.ts)
- Browser handler: [`src/features/agent/handlers/cut-silence.ts`](../src/features/agent/handlers/cut-silence.ts)

**Implementation deviation from the original plan:** the original §6.2
proposed pulling decoded audio samples *through* the bridge to the
server for RMS analysis. We did NOT do that. The browser already ships
the full pipeline as `analyzeSilenceForItems()` (decode + RMS + window)
and `removeSilenceFromItems()` (multi-split + ripple removal + subtitle
cue partitioning, all inside one `execute()` undo entry). The bridge
call would have added a pointless ~tens-of-MB base64 round-trip for
work the browser was already doing. The shipped handler is a 50-line
orchestrator that:

1. Validates the clip is video/audio with a `mediaId`
2. Maps `threshold_db` / `min_silence_sec` / `padding_ms` into
   `SilenceRemovalSettings` (using `DEFAULT_SILENCE_REMOVAL_SETTINGS` as
   the baseline)
3. `await analyzeSilenceForItems([clipId], settings)` → ranges
4. `removeSilenceFromItems([clipId], rangesByMediaId)` → split + remove
5. Returns the summary the tool quotes back

Subtitle/caption clips on the same clip auto-rebase because the
existing `_splitItem` already partitions cues at the cut point — no new
code needed.

**Defaults shipped at:** `-45 dB` / `500 ms` / `100 ms padding` — pulled
from `DEFAULT_SILENCE_REMOVAL_SETTINGS` so chat-driven `cut_silence`
behaves identically to the existing right-click → "Remove silence"
menu.

**Acceptance:** user says `"cut silences over 0.5s in clip foo"` → clip
is split into N segments with silences removed; transcription/captions
remain aligned; one `Ctrl+Z` restores everything.

### 6.3 `add_lower_third` *(deferred — Hyperframe-dependent)*

Blocked on Hyperframe API specifics (Q9). Placeholder in the plan so we
remember to come back. When we know the Hyperframe endpoints, this tool
likely splits into `add_lower_third`, `add_title_card`, possibly
`generate_avatar_clip` — all reusing the generate_broll async pattern.
**Hyperframe is the renderer** for any AI-generated talking-head /
avatar / lower-third content; we do NOT pull in Remotion or a CLI
farm. Hyperframe renders, the output drops onto FreeCut's timeline as
ordinary media (M3 placeholder→swap reused).

### 6.4 `generate_voiceover` *(M5)*

**Signature:**
```
generate_voiceover(text, options?: {
  voice_id?: string
  provider?: 'auto' | 'kokoro' | 'elevenlabs'
  insert_at_seconds?: number  // defaults to playhead
  track_id?: string           // defaults to a new audio track
}) → { audioId, durationSec, providerUsed }
```

**Reuses:** TTS provider abstraction (§2.2) + media-library import +
audio-item insertion.

**Acceptance:** user says `"add a voiceover saying 'welcome to the show'
at the start"` → audio clip appears at 00:00 on an audio track.

### 6.7 `analyze_clip` — Gemini video analysis *(M4.6)* ✅ **shipped 2026-05-27**

> Verified end-to-end: 21MB clip → File API upload + poll-until-ACTIVE →
> generateContent returned structured analysis → generate_broll composed
> a matching b-roll. fal v1.5/standard 404'd mid-day → bumped default to
> v3/standard. Detail in [status memory](../../.claude/projects/-Users-joelm-Documents-Antigravity-FreeCut/memory/ai-video-editor-status.md).

**Signature:**
```
analyze_clip(clip_id, focus?: 'visual' | 'mood' | 'audio' | 'all') →
  {
    visualDescription: string  // setting, subject, framing
    mood: string               // emotional tone
    lighting: string           // golden hour, harsh studio, etc.
    colorPalette: string[]     // dominant colors
    cameraMovement: string     // handheld, locked, drift, push-in
    subject: string            // primary focal subject
    audioSummary: string       // music, speech, ambience
    pace: string               // slow contemplative, energetic, etc.
    suggestedBrollPrompts: string[]  // 3 candidate prompts ready to feed generate_broll
  }
```

**Why this is the most important M5+ tool:** transcript-grounded
prompts ([§6.5.1](#)) tell us what's *said* but not what's *shown*.
Most b-roll mishaps happen because the model has no idea what the
surrounding footage looks like (see
[ai-regen-prompt-modifier-fix.md](../../.claude/projects/-Users-joelm-Documents-Antigravity-FreeCut/memory/ai-regen-prompt-modifier-fix.md)
for one such mishap). Visual analysis closes that gap.

**Architecture:**

- New capability: `apps/agent-server/src/providers/analysis/`.
- New provider class: `GeminiVideoAnalysisProvider` mirroring the
  `GeminiTranscriptionProvider` shape. Multimodal generate API,
  inline-base64 video bytes (~20MB cap; File API upload deferred
  until a long-form clip needs it), structured-JSON response schema.
- New browser handler: `read-clip-video-bytes(clip_id_or_range)` —
  pulls bytes from the workspace, optionally downsamples / clips to
  the requested sub-range to fit Gemini's inline cap. Returns base64
  + `mimeType` + `durationSec`.
- New MCP tool: `analyze_clip` (server-side), wired into the
  orchestrator agent. Agent calls this BEFORE `generate_broll` when
  the user request implies matching existing content ("match the
  vibe", "fits the music", "feels like what's playing").
- Update `ProvidersBundle` to include `analysis: ReadonlyArray<VideoAnalysisProvider>`.
- System prompt update: teach the agent the "match the vibe" routing
  ("if user asks for b-roll matching content on the timeline → call
  analyze_clip first → then construct a generate_broll prompt").

**Cost / latency:** ~1-3s per call, fractions of a cent. Cheap enough
that the agent calls it freely; not so cheap we'd call it on every
turn.

**Routing exception to §6.5.4:** the §6.5.4 "never auto-route to
Gemini" rule applies to **transcription only**. For *video analysis*
there is no local alternative that does temporal + audio + visual
joint understanding, so Gemini is the de-facto default for the
analysis capability. This is documented explicitly so future-us
doesn't relitigate it.

**Acceptance:** user says `"add b-roll between 0:10 and 0:18 that
matches the vibe"` → agent-server stdout shows `tool-call analyze_clip`
followed by `tool-call generate_broll` with a rich prompt that
incorporates the analysis. The rendered b-roll visually matches the
source clip's mood/lighting/pace.

### 6.8 Hybrid silence detection upgrade *(M4.2-bis)* ✅ **shipped 2026-05-27**

Pure-RMS silence detection occasionally clips trailing sibilants and
leading consonants because it cuts at energy threshold without
knowing where words actually end. HyperEdit pairs `silencedetect`
with Whisper word boundaries and gets cleaner cuts; we ported.

**Implementation pivot.** The original plan called for tolerance-snap
(±150ms to nearest Whisper word edge). That landed first, but live
testing showed the RMS detector regularly fires INSIDE words at vowel
↔ consonant transitions — the RMS edge sits 200-400ms deep, well
outside the 150ms window. Result was mid-word cuts: "lo sigu" instead
of "lo siguiente", "archi" instead of "archivos".

**Final algorithm — word-span subtraction.** Treat each Whisper word
as an authoritative "speech here" marker and SUBTRACT padded word
spans (±50ms) from every raw silence range. Sub-spans shorter than
`min_silence_sec` get dropped so we don't introduce micro-cuts. Falls
back to raw RMS edges when no transcript or no per-word timestamps
exist. Lives in
[`refineSilenceRangesUsingWords`](../src/features/timeline/utils/silence-removal-preview.ts).

**Verified end-to-end:** 76 raw silence ranges → 13 refined for a
5-min Spanish screen-recording (63 dropped as mid-word false
positives). Words intact; cuts only land in true word-gap silence.
Diagnostic emitted via `logger.warn` (Vite HMR only forwards warn/error
to the dev terminal — `console.info` is swallowed; cross-cutting
lesson baked into status memory).

### 6.9 Image-then-animate b-roll path *(M4.7)* ✅ **shipped 2026-05-27** + auto-chain enhancement

Both `generate_image` (fal `openai/gpt-image-2` at 2K default) and
`animate_image` (fal Kling v3 image-to-video) shipped + verified. A
follow-up commit (`32beb05c`) added an **auto-chain enhancement**:
`analyze_clip`'s response gained a deterministic
`hasOnScreenText: boolean` field, and the system prompt now branches
on it — text-heavy "match the vibe" requests auto-route to
`generate_image` → `animate_image` in the same turn (legible text
survives), while text-free requests fall through to `generate_broll`.

Second b-roll generation path alongside the existing text-to-video
pipeline. Generates a still first, lets the user (or the agent) iterate
on the still cheaply, then animates the approved still via image-to-
video.

**Two new tools:**

- `generate_image(prompt, aspect?, model?)` — fal `openai/gpt-image-2`
  by default; returns the image as a media-library asset. Used standalone
  (drop a still on the timeline) and as the first half of image-then-
  animate.
- `animate_image(media_id, prompt?, duration_sec?)` — fal Kling 1.5 pro
  image-to-video. Takes a previously generated still + an optional
  motion prompt, produces an animated clip via the M3 placeholder→swap
  pattern.

**Why two paths:**

- Text-to-video (current `generate_broll`): one call, fast, but the
  model picks the composition. Less consistency across multiple
  b-roll clips.
- Image-then-animate: see the still first, regenerate cheaply if
  composition is wrong, only spend on animation once the framing is
  approved. Better visual consistency, lower cost per accepted clip.

Naturally pairs with the **concept-card approval flow** (M5.2): the
still IS the concept card.

**Acceptance:** user says `"generate an image of a coffee shop and
animate it"` → image appears on the timeline → after approval, the
animated version swaps in.

### 6.10 GIF search + insert *(M4.8)* ✅ **shipped 2026-05-27**

`add_gif(query, start_seconds, end_seconds?, rating?, candidate_index?, limit?, track_id?, provider?)` —
searches Giphy `/v1/gifs/search`, drops the chosen GIF on the timeline
as an image clip (FreeCut's gif-frame-cache renders the animation)
via the M3 placeholder→swap pattern. Returns top-N candidates as
metadata so the agent can offer alternatives ("use the second one").

**Architecture mirrors `image/`:** new `apps/agent-server/src/providers/gif/`
with `types`, `giphy`, `router`, `index`. `ProvidersBundle` gained
`gifSearch: ReadonlyArray<GifSearchProvider>` (opt-in via
`GIPHY_API_KEY` in `.env`). System prompt teaches the "reaction gif /
facepalm / gif of X" route vs `generate_image` vs `generate_broll`.

**Verified end-to-end** — "add an excited reaction gif at 0:30" landed
a high-five GIF on a new track; Ctrl+Z restored. 21 new agent-server
tests (Giphy provider 9, router 4, tool 7).

### 6.11 Karaoke-style captions *(M5.1)*

Per-word caption highlighting that animates each word at the
millisecond it's spoken. HyperEdit does this with pure CSS color
transitions; we'll do the same via FreeCut's text spans + the word-
level timestamps Whisper already produces.

**Changes:**

- Extend `SubtitleSegmentItem.cues[]` to optionally carry `words:
  Array<{ text, start, end }>` (already in `MediaTranscript.segments`,
  just thread through `insertTranscriptAsCaptions`).
- Add a caption-style flag (`'karaoke' | 'standard'`) to the cue or
  the parent segment item.
- Renderer reads `currentFrame` → derives `currentTimeInCueSec` →
  picks the word whose `[start, end]` covers it → applies the
  highlight color (configurable, default `#FFD700`) to that word's
  span.
- New tool: `karaoke_captions(asset_id, highlight_color?, replace_existing?)`
  — runs the same `add_subtitles` flow but flips the style to karaoke.

**Effort:** ~half-day. No new models, no remote calls. All the data
we need is already in the transcript envelope.

**Acceptance:** captions appear with one word highlighted yellow at
any given playhead frame; the highlight advances word-by-word as
playback runs.

### 6.12 Concept-card approval flow *(M5.2)*

Spend-confirmation gate for expensive renders.

**Pattern:** tools that exceed a cost/time threshold (configurable
per-tool) return a `pending-confirmation` envelope instead of
executing. Chat panel renders a card with Approve / Reject / Edit
buttons. Approve triggers the actual render with the same inputs.

**Concrete consumers:**

- `animate_image` (M4.7) — the still IS the card.
- Future Hyperframe avatar / talking-head tools — show script preview
  + voice sample.
- Phase 2 storyboard scenes — each scene card IS a concept card.

**Reserved bridge message types** (add to `apps/agent-server/src/bridge/protocol.ts`):
- Server→Browser: `pending-confirmation { callId, title, summary, costEstimate, approveAction, rejectAction }`
- Browser→Server: `confirmation-response { callId, decision: 'approve' | 'reject' | 'edit', edits?: Record<string, unknown> }`

**Acceptance:** a tool flagged as expensive shows a card; clicking
Approve runs the render; clicking Reject cancels the operation
without timeline mutation.

### 6.13 Smart editing decisions *(M6 — multiple tools)*

Phase 1's last big push: tools that don't just *execute* user
instructions but *make editing decisions*. Each composes M4.6's
`analyze_clip` + the transcript + the timeline state.

- `detect_chapters(asset_id?, granularity?)` — Gemini segments the
  transcript/video into chapters; drops timeline markers. Composes
  `analyze_clip` + transcript.
- `find_moment(query)` — "when does the speaker mention pricing?" →
  returns a timestamp. Single Gemini call over the transcript +
  optional video frames.
- `suggest_trims(clip_id)` — "this clip is too long" → analyzes
  visually-redundant or low-content stretches, proposes 1-5 trim
  ranges with rationale. User approves before any cut.
- `add_motion_graphic(template, content, target_seconds)` — composes
  FreeCut text + shape primitives into pre-defined templates (lower
  third, title card, animated counter, etc.). NO Remotion; the
  templates are pure FreeCut composition definitions stored in
  `apps/agent-server/src/templates/`.

Each tool is itself a candidate to graduate into a skill (M7) once it
proves stable.

### 6.14 Skills graduation *(M7+ — ongoing)*

See [AI-EDITOR-VISION.md §13](AI-EDITOR-VISION.md) for the full
explanation. Quick summary:

- **Tools** are primitives (one operation, atomic).
- **Skills** are stable multi-tool workflows packaged behind a single
  entry point so the agent's tool list stays manageable.
- Reserved location: `apps/agent-server/src/skills/` (empty until
  M7).
- First candidates: `match_vibe_broll`, `karaoke_caption_pass`,
  `full_silence_cut`, `talking_head_intro`.

**Two architecture constraints we're applying NOW so M7 doesn't
require retrofitting:**

1. **Side-effect annotation on tools.** Add `sideEffects: 'read' |
   'mutate'` to every tool's metadata when convenient (next time a
   tool is touched). Skills need this to compose safely.
2. **Separate read from write across the bridge.** Don't combine
   "fetch state" + "mutate state" in a single browser action. The
   M4.1 split between `read-clip-for-regen` (read-only) and
   `replace-clip-with-placeholder` (mutating) is the pattern; keep
   it for future tools.

No code changes today; just constraints to apply going forward.

### 6.5 Cross-pollinated patterns (HyperEdit analysis, 2026-05-26)

After M3 shipped we did a deep read of the sibling HyperEdit / Mocha
project. Five patterns are worth porting; they land alongside M4 rather
than as a standalone milestone because each is small and the bundle is
synergistic.

**6.5.1 Transcript-grounded prompts** ✅ **shipped 2026-05-26** *(retrofit
to §5, integral to §6.1)*

Built at:
- Shared helper: [`apps/agent-server/src/tools/prompt-grounding.ts`](../apps/agent-server/src/tools/prompt-grounding.ts) — `buildTranscriptContextBlock(ctx)` returns the verbatim block.
- For `generate_broll`: new browser handler
  [`read-transcript-context-for-range.ts`](../src/features/agent/handlers/transcript-context.ts)
  iterates clips overlapping the requested window, translates each
  clip's source-time window via its `sourceFps`, slices overlapping
  segments, returns concatenated text. The tool prepends and exposes
  `usedTranscriptContext: boolean` in the result.
- For `replace_clip_with_regeneration`: bundled into
  `read-clip-for-regen` so the clip + its transcript come back in one
  round-trip.

When a transcript exists for the relevant range, generation tools
prepend the segment to the model prompt as:

```
VIDEO CONTEXT (from the transcript):
"{segment_text}"
This segment is from {start}s to {end}s.
IMPORTANT: Use specific terms, concepts, and themes from this context.
```

Best-effort: silent fallback to plain prompt when nothing overlaps; non-
fatal even if the bridge call fails (logged to stderr, generation
continues).

*Deferred:* "ask analysis provider to *pick* the most relevant segment
when the user didn't give a time range" — currently `generate_broll`
requires `start_seconds`/`end_seconds`, so no time-range-free path
exists yet. Wire when a real consumer needs it (probably alongside an
"add b-roll wherever it fits" tool in Phase 2 or M6).

**6.5.2 Chat panel UX additions** ✅ **shipped 2026-05-26**

Three additions to `src/features/agent/components/`:

1. **Suggestion chips above the input.** Built at
   [`suggestion-chips.tsx`](../src/features/agent/components/suggestion-chips.tsx).
   8 starter prompts seeded from the live tool set ("Add captions",
   "Cut silences", "B-roll 0:12–0:18", "Regenerate this clip",
   "Transcribe", "Transcribe (Gemini)", "B-roll under this", "More
   dramatic regen"). Click populates the textarea without auto-sending
   so the user can tweak.

2. **Reference / range pill picker below the input.** Built at
   [`reference-pill-picker.tsx`](../src/features/agent/components/reference-pill-picker.tsx)
   with shared compile helper at
   [`reference-pill-utils.ts`](../src/features/agent/components/reference-pill-utils.ts).
   Radix popover with three sources: **Selected clip** (reads
   `useSelectionStore` + `useItemsStore` + `useTimelineSettingsStore`),
   **In/Out range** (reads `useMarkersStore`), and **±N seconds around
   playhead** (`±2s` / `±5s` / `±10s` buttons reading
   `usePlaybackStore`). Pills compile via `compilePillContext()` to
   `[Clip: foo on V1 at 0:00 (item:XYZ)]` or `[Time Range: 0:12–0:18]`
   bracket lines prepended to the user's text by `chat-input.tsx`.
   *Note:* `compilePillContext` and friends live in a separate
   `reference-pill-utils.ts` so the picker module stays
   "components-only" for React Fast Refresh.

3. **UI-state flags appended to `summarizeTimelineForAgent()`.**
   Snapshot type extended in
   [`summarize-timeline.ts`](../src/shared/state/agent/summarize-timeline.ts)
   with optional `uiFlags: { playheadInsideClipId, selectedClipIsAiGenerated }`.
   Computed in
   [`timeline-snapshot.ts`](../src/features/agent/timeline-snapshot.ts):
   `playheadInsideClipId` finds the first non-shape/non-adjustment item
   covering the current frame; `selectedClipIsAiGenerated` checks the
   first selected item's media for an `aiGenerated` envelope. Renders
   as a `Context flags: …` line at the bottom of the summary.

System prompt at
[`agent.ts`](../apps/agent-server/src/agent.ts) updated with the
disambiguation order: bracket-tagged context lines (from the pill
picker) > Context flags line > Selected: line > ask.

*Tests:* 3 new cases in
[`summarize-timeline.test.ts`](../src/shared/state/agent/summarize-timeline.test.ts)
covering flag render / empty omit / undefined omit.

**6.5.3 Concept-card approval flow** *(scoped for Phase 2 storyboard;
optional M4-era addition for `generate_broll`)*

HyperEdit splits expensive generations into two endpoints —
`analyze-for-animation` returns a JSON concept (no rendering) which
the chat shows as an Approve/Edit card; only on Approve does the
second call actually generate. Maps 1:1 to Phase 2 storyboard cards
and gives us an approval gate on spend before then. Optional add to
M3/M4 if we want a "I'll generate a 5s Kling 1.5 clip of '…' at
$0.18 — approve?" confirmation card. *Effort:* small for the
protocol (two tool calls + a `pending-confirmation` bridge message);
medium for the chat-card UI. *Carry into Phase 2 as the storyboard's
scene-card data model.*

**6.5.4 Opt-in Gemini Flash analysis provider** ✅ **shipped 2026-05-26
(transcription only)**

Adds `gemini-3.5-flash` (released 2026-05-19, GA stable — 1M token
input context, multimodal text/image/video/audio/PDF, 65k token
output, supports function calling + grounding + structured output)
as a **third** transcription provider. Default behavior is unchanged —
local Whisper for transcription, local LFM for visual captioning,
RMS for silence detection. Gemini is engaged only when the user
says so ("…using gemini").

What shipped:
- [`apps/agent-server/src/providers/transcription/gemini.ts`](../apps/agent-server/src/providers/transcription/gemini.ts)
  — implements `TranscriptionProvider` against
  `gemini-3.5-flash`'s multimodal generate API. Sends container bytes
  inline-base64 (same `read-transcribable-audio` browser action the
  OpenAI provider uses) and asks for verbose-JSON-equivalent output via
  `responseMimeType: 'application/json'` + a `responseSchema` matching
  Whisper's shape. Temperature pinned to `0` so it doesn't paraphrase.
  Surfaces blocked requests via `promptFeedback.blockReason`.
- Router update at
  [`router.ts`](../apps/agent-server/src/providers/transcription/router.ts)
  — adds `gemini` to `TranscriptionStrategy`; routes it explicitly only;
  hard-bars Gemini from `auto`, even when it's the only available
  provider for a long clip (tested).
- [`transcribe`](../apps/agent-server/src/tools/transcribe.ts) tool now
  accepts `provider: 'auto' | 'local' | 'openai' | 'gemini'`.
- Wired into
  [`apps/agent-server/src/index.ts`](../apps/agent-server/src/index.ts)
  reading `GEMINI_API_KEY` from `.env`. Provider reports
  `isAvailable()=false` when the key is missing, which the router uses
  to error with a `GEMINI_API_KEY`-mentioning hint.
- System prompt at
  [`agent.ts`](../apps/agent-server/src/agent.ts) tells the agent the
  "gemini" route is OPT-IN and auto must stay on local/openai.
- 5 provider tests + 4 router cases at
  [`gemini.test.ts`](../apps/agent-server/src/providers/transcription/gemini.test.ts)
  and
  [`router.test.ts`](../apps/agent-server/src/providers/transcription/router.test.ts).

**Audio handling:** sends inline base64 bytes in the request body. Per
Google's docs, inline audio is capped at ~20MB total request size. For
longer clips we'd need the File API uploading flow; deferred until we
see a long-form clip in the wild.

What was **deliberately deferred** (originally listed in this section
but no consumer needs it yet):
- `apps/agent-server/src/providers/analysis/` capability with
  `pickRelevantSegment(transcript, prompt)` and `describeFrameAt(...)`.
  `generate_broll` always receives an explicit time range
  (`start_seconds` + `end_seconds` are required), so "pick the best
  segment" has no live caller. Per CLAUDE.md's "don't design for
  hypothetical future requirements" rule we'll add this only when a
  tool actually needs it — likely alongside a future
  "add b-roll wherever it fits" or `find_moment_where(prompt)` tool.

The key design constraint, stated in scope above: **never route to
Gemini by default**. The existing local Whisper / OpenAI / LFM paths
keep being the defaults. Gemini is an opt-in tool the user can reach
for when they want it.

**6.5.5 Director / intent router** *(deferred — revisit between M5 and M6)*

Client-side or server-side preflight that restricts the tool set the
agent sees per turn based on the user's prompt + selection state,
instead of sending all tools every time. Cuts context bloat and
ambiguity once we have 8–10+ tools.

**Current tool count:** 5 (echo, transcribe, add_subtitles,
generate_broll, replace_clip_with_regeneration, cut_silence — count
excludes echo since it's a sanity-check stub).

**After M4.6 + M4.7 + M4.8 + M5 + M5.1 we'll have:** ~12 tools. That's
the threshold where the intent router stops being premature
optimization and starts being load-bearing.

**Implementation sketch when we're ready (post-M5.1):**

- Keyword-match pre-filter first (cheap, deterministic; takes inspiration
  from HyperEdit's `intent-classifier.js` — runs in milliseconds, no LLM
  call needed for the common cases).
- Haiku-class LLM fallback for ambiguous prompts.
- Output: a subset of tool names the main agent is allowed to call
  this turn. The orchestrator never sees the others.
- Hosted in `apps/agent-server/src/agent/intent-router.ts`.

Until we hit the ~10-tool threshold this stays deferred. See
[AI-EDITOR-VISION.md §12.3](AI-EDITOR-VISION.md) for context on how
the intent router relates to skills (§12.4 / VISION §13).

### 6.6 Patterns reviewed and rejected

For completeness — these are documented so we don't re-evaluate them
in a future session:

- **Remotion as a rendering layer.** HyperEdit renders generated
  scenes via Remotion CLI server-side and re-imports the MP4. Total
  duplication of our GPU compositor — we have text, shapes,
  transitions, masks, keyframes already. Adopt scene *schemas* when
  Phase 2 happens, not the renderer.
- **LLM-generated FFmpeg command strings.** RCE surface. Our
  architecture (high-level tools backed by FreeCut actions) avoids
  this by construction.
- **Cloudflare Worker / Hono backend.** HyperEdit's "real backend"
  turns out to be a local Node server (7700 lines in
  `scripts/local-ffmpeg-server.js`); the worker is a 199-line
  vestige. We already have the right shape (`apps/agent-server/`).
- **Three.js / `@remotion/three` scenes.** Cool, huge, defer
  indefinitely.
- **Two parallel session systems** (HyperEdit's `useProject` +
  `useVideoSession`). They explicitly call this out as legacy in
  their CLAUDE.md. Our single-source-of-truth timeline avoids the
  problem.
- **Mocha platform glue** (`@getmocha/*`, `wrangler.json`). Not
  portable.

---

## 7. Milestones

Each milestone = a recordable demo + a manual smoke-test list. Roughly two
weeks per milestone target, faster if the prereqs go cleanly.

| ID | Demo | Manual smoke tests | Status |
|---|---|---|---|
| **M0** | Pre-prereqs done — agent server runs, browser connects, dummy tool roundtrip works | `npm run dev:all` boots both; chat panel shows "connected"; `say hi` echoes | ✅ done |
| **M1** | Agent transcribes a clip via chat (both providers) | Short clip → local; long clip → openai; cancellation; transcript file at expected path | ✅ local path verified; OpenAI/cancel paths owed |
| **M2** | Agent adds subtitles via chat | Captions appear on new track; single undo removes them; replaceExisting works | ✅ done |
| **M3** | Agent generates and inserts B-roll via chat | Placeholder appears; real clip swaps in; clip lands in Media Library with AI badge; single Ctrl+Z removes the final clip; `generation.json` written | ✅ happy path verified; cancel + failure visuals owed |
| **M4** | `replace_clip_with_regeneration` + `cut_silence` working, with the cross-pollinated patterns from §6.5 (transcript-grounded prompts retrofit, chat UX upgrades, opt-in Gemini provider) | Regen swaps in place via the placeholder pattern with transcript context visible in logs; silence-cut preserves captions; undo restores; `transcribe clip using gemini` succeeds while plain `transcribe` still routes to Whisper; reference-pill picker in chat resolves "this clip" deterministically | ✅ shipped + verified 2026-05-27 |
| **M4.6** | Gemini frame+audio video analysis — "match the vibe" b-roll works without explicit camera/mood prompts | `analyze_clip` returns structured analysis JSON; agent composes a rich prompt from analysis + intent; generated b-roll visually matches the source clip's mood/lighting/pace; cost <$0.05/analysis | ✅ shipped + verified 2026-05-27 |
| **M4.2-bis** | Hybrid silence detection — refine RMS edges with Whisper word timestamps | Word-span subtraction (not tolerance-snap — algorithm pivoted mid-implementation). Cuts only land in true word-gap silence; no mid-word amputation. Pure quality upgrade inside `analyzeSilenceForItems`. | ✅ shipped + verified 2026-05-27 |
| **M4.7** | Image-then-animate b-roll path (fal `gpt-image-2` for stills → fal Kling image-to-video for motion) + auto-chain | Still preview before animation; cheaper to iterate. Auto-chain: `hasOnScreenText` on analyze_clip routes match-the-vibe requests to generate_image + animate_image in one turn (legible text survives). | ✅ shipped + verified 2026-05-27 |
| **M4.8** | GIF search + insert (Giphy) | `add_gif("excited reaction")` searches Giphy, drops the gif on the timeline as an animated image clip; one Ctrl+Z removes; returns top-N candidates so agent can offer alternatives | ✅ shipped + verified 2026-05-27 |
| **M5** | `generate_voiceover` working — Kokoro (local) + ElevenLabs (cloud) | Both paths; inserts at playhead on a new audio track; correct duration; voice selection via chat | **NEXT** |
| **M5.1** | Karaoke-style captions — per-word highlight at the millisecond it's spoken | New `karaoke_captions(asset_id, style?)` tool extends `SubtitleSegmentItem` with word-level highlight rendering; uses Whisper word timestamps we already cache; ~half-day of work | bundle with M5 |
| **M5.2** | Concept-card approval flow for expensive generations | Tools that exceed a cost/time threshold return a `pending-confirmation` envelope instead of executing; chat renders Approve / Reject / Edit; the still image from M4.7 is the natural concept card | M5+ |
| **M6** | Smart editing decisions — chapter detection, find-the-moment, "this clip is too long" trim suggestions, motion-graphic template insertion | Each tool composes M4.6's `analyze_clip` + transcript + timeline state; all renders use FreeCut primitives (no Remotion); the chat starts to feel like a video editor *deciding*, not just executing | after M5 |
| **M7** | Skills graduation — package stable multi-tool workflows as Claude Agent SDK skills (see VISION §13) | A workflow becomes a skill when (a) the agent has run it ≥3 times, (b) the composition is deterministic, (c) it can be described in one sentence. First candidates: `match_vibe_broll`, `karaoke_caption_pass`, `full_silence_cut` | after M6, ongoing |
| **Hyperframe** | *(separate track, blocked)* Hyperframe tools — `add_lower_third`, `add_title_card`, `generate_avatar_clip`, etc. — all reuse the M3 placeholder→swap pattern + M4.6 analysis grounding | When Hyperframe API docs available; placeholder→swap flow stays identical; **for AI-generated talking-head / avatar / lower-third content, Hyperframe is THE renderer** (not Remotion, not a CLI farm). Output drops onto FreeCut's timeline as ordinary media | blocked on API docs |

---

## 8. Still-Pending Decisions

These will be settled during planning of individual milestones, not now:

- **Hyperframe tool surface** — Q9 of `ARCHITECTURE.md`; revisit when API
  docs in hand. Reaffirmed: Hyperframe IS the renderer for AI-generated
  talking-head / avatar / lower-third content (not Remotion, not a CLI
  farm). Output drops onto FreeCut's timeline as ordinary media via
  the M3 placeholder→swap pattern.
- **Tool failure recovery** — currently "report and stop"; refine when we
  see actual failure modes in the wild
- **Provider auto-routing thresholds** — 30 min for transcription is a
  guess; tune from real usage
- **Cost threshold for concept-card approval (M5.2)** — at what
  dollar/time cost should a generation tool require a confirmation
  card vs. running straight through? Likely `cost > $0.50` OR
  `expected duration > 30s`, but tune from real usage.
- **Intent-router activation threshold** — when does §6.5.5 become
  load-bearing? Currently set to "at ~10 tools", which lands around
  M5.1. Revisit then.
- **Should the chat panel persist conversation history per project?** —
  probably yes (`projects/{id}/chat.json`), but how much context to replay
  on reload is open

**Phase 2 carryovers from the HyperEdit analysis (revisit when storyboard work starts):**

- *`Scene[]` schema as the universal generative output shape.* HyperEdit
  expresses every AI-generated segment as one of ~15 discriminated
  scene types (`title | steps | features | stats | text | media | chart
  | countdown | comparison | shapes | emoji | gif | lottie | 3d` plus
  transitions) with uniform `content`, `camera`, `transition`,
  `mediaAnimation` fields. Worth adopting as Phase 2's
  `Project.storyboard` shape — we render via FreeCut's GPU primitives
  + keyframes rather than Remotion, but the schema itself is gold.
  Decision needed when storyboard work begins.
- *Concept-card approval flow as the storyboard UI.* §6.5.3's
  analyze→approve→render pattern is exactly the Phase 2 scene-card
  flow. Build the protocol in Phase 1 if we want spend-confirmation
  on `generate_broll`/`replace_clip_with_regeneration`; reuse it
  wholesale for Phase 2.
- *Director / intent router on agent-server.* §6.5.5. Defer until
  tool count justifies the routing layer (~8–10+ tools, i.e. once
  Hyperframe's M6 surface lands or Phase 2 storyboard tools ship).

**Settled during M0–M3 build (recorded here for the audit trail):**

- *WebSocket transport library*: `ws` (M0).
- *`dev:all` runner*: `scripts/run-dev-and-agent.mjs` — custom Node spawn,
  prefixes both child processes' stdio (M0).
- *API-key location*: single `.env` at repo root, loaded by the agent
  server via `dotenv` from `apps/agent-server` cwd — `OPENAI_API_KEY`,
  `FAL_API_KEY`, `GEMINI_API_KEY` etc. live there with no `VITE_` prefix
  (M1, M3, M4).
- *Placeholder TimelineItem mechanism*: flagged `ShapeItem` with
  `aiPlaceholder` meta (M3 — see §5).

**Settled during M4 build (recorded here for the audit trail):**

- *cut_silence routing*: orchestrate in browser, not server-side RMS.
  Original §6.2 plan called for the server to pull audio bytes and run
  analysis. We don't — the browser already has
  `analyzeSilenceForItems()` + `removeSilenceFromItems()` and the bridge
  trip would just relay base64. The handler is now a 50-line
  orchestrator.
- *replace_clip_with_regeneration "no prompt" failure*: validate
  *before* mutating. `read-clip-for-regen` is read-only; the server
  errors out before calling `replace-clip-with-placeholder` so a bad
  request leaves the timeline untouched. Decision: nicer than relying
  on the snapshot+undo to clean up after a half-applied regen.
- *Pre-mutation cleanup of transitions/keyframes*: `replaceClipWithPlaceholder`
  strips the original clip's transitions + keyframes inline so the
  placeholder doesn't inherit them; the snapshot captured *before* the
  mutation still contains them, so Ctrl+Z restores everything.
- *AnalysisProvider scaffolding*: deferred. Originally §6.5.4 proposed
  a `pickRelevantSegment` / `describeFrameAt` capability, but
  `generate_broll` requires explicit `start_seconds`/`end_seconds`, so
  there's no live caller yet. Wire it when a future tool needs fuzzy
  segment picking (e.g. an "add b-roll wherever it fits" tool, or a
  Hyperframe lower-third tool that wants to know what the speaker is
  saying at the playhead).
- *Pill seconds vs frames*: the `ReferencePill` shape carries clip
  position as `fromSeconds`, not the raw item.from (which is in project
  frames). The picker converts via `useTimelineSettingsStore.fps` at
  construction time. Why: the compiled bracket-context line embeds an
  `mm:ss` timestamp, and bundling fps into every pill would have made
  the compile helper stateful for no benefit.
- *Reference pill utils file*: `compilePillContext()` + `formatSec()` +
  `formatRange()` live in `reference-pill-utils.ts` (not in the picker
  component), so the picker module stays "components-only" — required
  for React Fast Refresh to HMR cleanly. Tripped by the lint
  `only-export-components` rule mid-build.

---

## 9. Reference

- Build brief: top of conversation (not in repo yet — consider adding as
  `docs/BUILD-BRIEF.md` for future reference)
- Architecture: `docs/ARCHITECTURE.md`
- Phase 0 decisions: `docs/ARCHITECTURE.md` §5
- Reuse inventory: `docs/ARCHITECTURE.md` §4.6
- Gotchas to remember: `docs/ARCHITECTURE.md` Appendix A
