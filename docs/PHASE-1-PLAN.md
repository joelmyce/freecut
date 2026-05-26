# Phase 1 — Implementation Plan

**Status:** In progress. **M0 complete (2026-05-26)** — agent server, WS
bridge, browser client, dev scripts, and end-to-end `echo` roundtrip all
verified. **M1 (transcribe) is next.** See `~/.claude/projects/-Users-joelm-Documents-Antigravity-FreeCut/memory/ai-video-editor-status.md`
for the live status and current-session caveats.

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
- Generation metadata persisted to disk via the existing AI-output envelope
- `summarizeTimelineForAgent()` helper sent in every system prompt
- Cancellation, basic error surfacing, undo-friendly mutations

### Explicitly out of scope

- Storyboard view, scene cards, "send to timeline" (Phase 2)
- Hyperframe tool surface (`add_lower_third`) — deferred until API docs in hand
- Vision/captioning provider abstraction (Q11 Gemini Flash) — wired in Phase
  2 when storyboard frame-prep needs it; existing local LFM path keeps working
- Multi-agent / parallel tool execution
- Settings UI for provider selection (use `.env` for v1)
- Production packaging / single-binary distribution
- Tool failure recovery beyond "report error to chat and stop"

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

**Open during planning (settle in 2.1 / before 5):**

- Should the placeholder be a new TimelineItem `type` (`'placeholder'`) or
  a special-cased `'shape'`? New type is cleaner but touches more files
  (schema, renderer, action validators). I'd lean toward a flagged shape
  for v1 unless that complicates rendering
- Atomic swap mechanism: replace-by-ID via `updateItem`, or
  `removeItems+addItems` in one `execute()`? The latter is more honest

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

**Acceptance:** user selects a generated clip → says `"replace this with a
more dramatic version"` → placeholder swaps with new generation in place.

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

---

## 7. Milestones

Each milestone = a recordable demo + a manual smoke-test list. Roughly two
weeks per milestone target, faster if the prereqs go cleanly.

| ID | Demo | Manual smoke tests |
|---|---|---|
| **M0** | Pre-prereqs done — agent server runs, browser connects, dummy tool roundtrip works | `npm run dev:all` boots both; chat panel shows "connected"; `say hi` echoes |
| **M1** | Agent transcribes a clip via chat (both providers) | Short clip → local; long clip → openai; cancellation; transcript file at expected path |
| **M2** | Agent adds subtitles via chat | Captions appear on new track; single undo removes them; replaceExisting works |
| **M3** | Agent generates and inserts B-roll via chat | Placeholder appears; progress streams; real clip swaps in; failure path; cancel path; metadata file written |
| **M4** | `replace_clip_with_regeneration` + `cut_silence` working | Regen swaps in place; silence-cut preserves captions; undo restores |
| **M5** | `generate_voiceover` working | Both Kokoro and ElevenLabs paths; inserts at playhead; correct duration |
| **M6** | *(deferred)* Hyperframe tools | When Hyperframe API docs available |

---

## 8. Still-Pending Decisions

These will be settled during planning of individual milestones, not now:

- **WebSocket transport library** — likely `ws`; consider SSE if streaming
  agent text output works better that way
- **`dev:all` runner** — `npm-run-all` package, custom Node script, or
  extend the existing `scripts/run-dev-and-perf.mjs` pattern
- **API-key location** — single `.env` at repo root shared by browser
  (`VITE_*`) and server, or split `.env.server`? Server keys (OPENAI,
  fal, kie, ElevenLabs) should NOT have `VITE_` prefix to avoid leaking
  into the client bundle
- **Hyperframe tool surface** — Q9 of `ARCHITECTURE.md`; revisit when API
  docs in hand
- **Placeholder TimelineItem mechanism** — new `type` discriminant vs flagged
  shape; see §5
- **Tool failure recovery** — currently "report and stop"; refine when we
  see actual failure modes in the wild
- **Provider auto-routing thresholds** — 30 min for transcription is a
  guess; tune from real usage
- **Should the chat panel persist conversation history per project?** —
  probably yes (`projects/{id}/chat.json`), but how much context to replay
  on reload is open

---

## 9. Reference

- Build brief: top of conversation (not in repo yet — consider adding as
  `docs/BUILD-BRIEF.md` for future reference)
- Architecture: `docs/ARCHITECTURE.md`
- Phase 0 decisions: `docs/ARCHITECTURE.md` §5
- Reuse inventory: `docs/ARCHITECTURE.md` §4.6
- Gotchas to remember: `docs/ARCHITECTURE.md` Appendix A
