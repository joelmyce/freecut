# Phase 1 — Implementation Plan

**Status:** In progress. **M0 + M1 + M2 + M3 complete and user-verified
(2026-05-26)** — agent server, WS bridge, chat panel UI, `transcribe`
(local Whisper + OpenAI), `add_subtitles` (with auto-chain from
`transcribe`), and `generate_broll` (fal video provider with placeholder
→ swap pattern) all working end-to-end on `feat/ai-agent`. **M4
(`replace_clip_with_regeneration` + `cut_silence`) is next.** See
`~/.claude/projects/-Users-joelm-Documents-Antigravity-FreeCut/memory/ai-video-editor-status.md`
for the live commit log and bookkeeping debts.

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
- Multi-agent / parallel tool execution
- Settings UI for provider selection (use `.env` for v1)
- Production packaging / single-binary distribution
- Tool failure recovery beyond "report error to chat and stop"
- **LLM-generated FFmpeg command strings.** High-level tools call
  FreeCut actions internally; the LLM never writes shell or FFmpeg
  invocations directly. Documented here because at least one sibling
  AI editor (HyperEdit) does exactly this and it's an RCE surface we
  decline.

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

### 6.1 `replace_clip_with_regeneration`

**Signature:**
```
replace_clip_with_regeneration(clip_id, new_prompt?, options?) → { clipId, providerUsed, cost }
```

**Reuses:** generate_broll's placeholder→insert pattern.

**New bit:** reads `GenerationOutput` from
`media/{originalMediaId}/cache/ai/generation.json` for original prompt/model
context. If `new_prompt` is omitted, regenerates with the original. If the
clip wasn't generated (no metadata file), error with a clear message.

**Design decision: placeholder→swap (default) vs in-place file overwrite.**
HyperEdit (`scripts/local-ffmpeg-server.js:handleEditAnimation`) ships an
in-place overwrite — same `assetId`, same on-disk filename, browser
cache-busts via `?v=Date.now()`. Tempting because no timeline plumbing
changes. We're sticking with the **placeholder→swap** pattern for v1
because it (a) matches M3 so the undo semantics stay consistent (single
Ctrl+Z rewinds past the placeholder), (b) avoids cache-invalidation
surface area on `sourceFps`/`sourceDuration`/waveform/reverse-conform
caches, and (c) lets the user keep seeing the existing clip while the
new one is rendering. Revisit if M4 verification shows the swap UX
feels heavy for in-place replacement.

**Transcript grounding (port from HyperEdit):** when the original clip
has a transcript saved (or when the regen target overlaps a transcript
on the timeline), the tool prepends the transcript segment for the
target time range to the model prompt as `VIDEO CONTEXT`. Best-effort —
not a precondition, fallback to plain prompt if no transcript exists.
Same retrofit lands on `generate_broll` (§5).

**Acceptance:** user selects a generated clip → says `"replace this with a
more dramatic version"` → placeholder swaps with new generation in place;
transcript context (if any) is visible in the agent-server log; single
Ctrl+Z restores the original clip.

### 6.2 `cut_silence`

**Signature:**
```
cut_silence(clip_id, threshold_db?: number = -40, min_silence_sec?: number = 0.5)
  → { silenceRegionCount, removedDurationSec }
```

**Pure local — no external API.** Tests the "local processing tool" pattern.

**Server-side flow:**

1. Request decoded audio samples from browser (browser already has decoded
   preview audio cached at `media/{id}/cache/preview-audio.wav` for
   non-native codecs)
2. RMS analysis on the server (or in a browser Worker if simpler) → list
   of silence regions in seconds
3. Convert to frame splits + removals
4. Send `mutate-timeline: 'cut-silence-regions'` with the split plan
5. Browser executes all splits + removes in one `execute()` for clean undo
6. Subtitle/caption clips on the same clip get cue-rebased automatically
   (existing `_splitItem` for subtitles already partitions cues — confirmed
   in items-store.ts)

**Acceptance:** user says `"cut silences over 0.5s in clip foo"` → clip is
split into N segments with silences removed; transcription/captions
remain aligned; one `Ctrl+Z` restores everything.

### 6.3 `add_lower_third` *(deferred — Hyperframe-dependent)*

Blocked on Hyperframe API specifics (Q9). Placeholder in the plan so we
remember to come back. When we know the Hyperframe endpoints, this tool
likely splits into `add_lower_third`, `add_title_card`, possibly
`generate_avatar_clip` — all reusing the generate_broll async pattern.

### 6.4 `generate_voiceover`

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

### 6.5 Cross-pollinated patterns (HyperEdit analysis, 2026-05-26)

After M3 shipped we did a deep read of the sibling HyperEdit / Mocha
project. Five patterns are worth porting; they land alongside M4 rather
than as a standalone milestone because each is small and the bundle is
synergistic.

**6.5.1 Transcript-grounded prompts** *(retrofit to §5, integral to §6.1)*

When a transcript exists for the requested time range, generation
tools prepend the segment to the model prompt as:

```
VIDEO CONTEXT (from the transcript):
"{segment_text}"
This segment is from {start}s to {end}s.
IMPORTANT: Use specific terms, concepts, and themes from this context.
```

If the user didn't give a time range, the analysis provider (Whisper
default, or Gemini when explicitly requested — see 6.5.4) is asked to
*pick* the most relevant segment from the transcript first.

*Effort:* trivial. ~30 lines in `generate-broll.ts` and the new
`replace-clip-with-regeneration.ts`. Best-effort — skip silently if no
transcript exists. *Acceptance:* agent-server log shows the
`VIDEO CONTEXT` block in the outbound prompt when a transcript is
saved for the clip.

**6.5.2 Chat panel UX additions**

Three small additions to `src/features/agent/chat-panel/`:

1. **Suggestion chips above the input.** ~12 starter prompts seeded
   from our actual tool set: "Add captions", "Cut silences over 0.5s",
   "Add B-roll between 0:12 and 0:18", "Regenerate this clip". Click
   to populate the textarea. Lowers cold-start cost.

2. **Reference / range pill picker below the input.** Tiny popover to
   attach a `[Clip: foo.mp4 on V1 at 0:00]` reference or a `[Time
   Range: 0:12-0:18]` scope. Pills compile to bracket-tagged context
   lines prepended to the user's prompt. Data already lives in our
   selection + timeline stores; only UI work.

3. **UI-state flags appended to `summarizeTimelineForAgent()`.** A
   small block at the bottom of the summary carrying
   `selectedClipIsAiGenerated`, `playheadInsideClipId`,
   `editTabFocusedItemId` (when we add an edit tab). Lets Claude infer
   "this clip" / "right here" without a separate tool call.

*Effort:* one to two days total, can ship incrementally before or
alongside M4. *Acceptance:* chip click populates the input; reference
pill makes "regenerate this clip" route deterministically; summary
shows the new flags.

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

**6.5.4 Opt-in Gemini Flash analysis provider**

Adds `gemini-3.5-flash` (released 2026-05-19, GA stable — 1M token
input context, multimodal text/image/video/audio/PDF, 65k token
output, supports function calling + grounding + structured output)
as a **third** transcription provider and opens the door for a
`VideoAnalysisProvider` capability (a new shape inside
`ProvidersBundle`). Default behavior is unchanged — local Whisper
for transcription, local LFM for visual captioning, RMS for silence
detection. Gemini is engaged only when the user says so
("…using gemini").

The native video-input support is the real reason this is worth
wiring up — it means a single `gemini-3.5-flash` call can accept a
short clip and a question, returning structured analysis. That
collapses what would otherwise be a transcribe → analyze
chain for use cases like chapter detection, content summarization,
and "find the moment where X happens."

Concrete wiring:

- `apps/agent-server/src/providers/transcription/gemini.ts` —
  implements `TranscriptionProvider` against `gemini-3.5-flash`'s
  multimodal API. Sends container bytes (same path as the OpenAI
  provider) and asks Gemini for verbose-JSON-equivalent output.
- `apps/agent-server/src/providers/analysis/` — new capability with
  one provider (`GeminiAnalysisProvider`) implementing methods like
  `pickRelevantSegment(transcript, prompt)` (used by 6.5.1 when the
  user didn't specify a time range) and `describeFrameAt(mediaId,
  seconds)` (future visual-captioning hook). The router throws unless
  the user explicitly requests `gemini`.
- `transcribe` tool gains `provider: 'auto' | 'local' | 'openai' | 'gemini'`
  and threads through to the router.
- `.env`: `GEMINI_API_KEY`.

The key design constraint, stated in scope above: **never route to
Gemini by default**. The existing local Whisper / OpenAI / LFM paths
keep being the defaults. Gemini is an opt-in tool the user can reach
for when they want it. *Effort:* small for the transcription
provider (mirror OpenAI's); medium when we start using `analysis`
methods for prompt expansion in 6.5.1. *Acceptance:* `transcribe
clip_x using gemini` succeeds; `transcribe clip_x` still routes to
local Whisper.

**6.5.5 Director / intent router** *(deferred — revisit at Phase 2)*

Client-side preflight that restricts the tool set per turn based on
the user's prompt + selection state, instead of sending all tools
every time. Cuts context bloat and ambiguity once we have 8–10+
tools. Not worth the complexity at our current 4-tool scale —
revisit when M6 or Phase 2 storyboard pushes the count up.

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
| **M4** | `replace_clip_with_regeneration` + `cut_silence` working, with the cross-pollinated patterns from §6.5 (transcript-grounded prompts retrofit, chat UX upgrades, opt-in Gemini provider) | Regen swaps in place via the placeholder pattern with transcript context visible in logs; silence-cut preserves captions; undo restores; `transcribe clip using gemini` succeeds while plain `transcribe` still routes to Whisper; reference-pill picker in chat resolves "this clip" deterministically | next |
| **M5** | `generate_voiceover` working | Both Kokoro and ElevenLabs paths; inserts at playhead; correct duration | pending |
| **M6** | *(deferred)* Hyperframe tools — `add_lower_third`, `add_title_card`, `generate_avatar_clip`, etc. — all reuse M3's generate_broll async pattern with the same transcript-grounding from §6.5.1 | When Hyperframe API docs available; placeholder→swap flow stays identical; lower-thirds compose from FreeCut's GPU text + shapes (no Remotion) | blocked |

---

## 8. Still-Pending Decisions

These will be settled during planning of individual milestones, not now:

- **Hyperframe tool surface** — Q9 of `ARCHITECTURE.md`; revisit when API
  docs in hand
- **Tool failure recovery** — currently "report and stop"; refine when we
  see actual failure modes in the wild
- **Provider auto-routing thresholds** — 30 min for transcription is a
  guess; tune from real usage
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
  `FAL_API_KEY` etc. live there with no `VITE_` prefix (M1, M3).
- *Placeholder TimelineItem mechanism*: flagged `ShapeItem` with
  `aiPlaceholder` meta (M3 — see §5).

---

## 9. Reference

- Build brief: top of conversation (not in repo yet — consider adding as
  `docs/BUILD-BRIEF.md` for future reference)
- Architecture: `docs/ARCHITECTURE.md`
- Phase 0 decisions: `docs/ARCHITECTURE.md` §5
- Reuse inventory: `docs/ARCHITECTURE.md` §4.6
- Gotchas to remember: `docs/ARCHITECTURE.md` Appendix A
