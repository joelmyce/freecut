# FreeCut Architecture — Phase 0 Reconnaissance

**Purpose:** Inform the design of an AI Video Editor built on a FreeCut fork.
This document is the output of Phase 0 of the build brief. It describes what
FreeCut **is today** so we can decide what to **reuse, extend, or avoid touching**
in Phases 1 and 2. No new feature work has been done at this point.

**Reading order:** §1–§3 are the mental model. §4 answers the eight Phase 0
questions from the brief directly. §5 answers the open questions. §6 lists
recommended next steps for Phase 1.

---

## 1. What FreeCut Is

FreeCut is a **browser-native, fully-local, multi-track video editor** that
ships at [freecut.net](https://freecut.net). MIT-licensed. ~1,500 source files.

**It runs entirely in the browser.** Everything — decode, effects, compositing,
transcription, captioning, voice synthesis, music generation, scene detection,
export — happens client-side. There is no backend. Media never leaves the
user's machine.

**Storage is a user-picked folder.** FreeCut uses the File System Access API to
write projects, media metadata, thumbnails, waveforms, transcripts, captions,
proxies, decoded audio, and AI outputs as **plain files on disk**. IndexedDB is
used only to hold the non-serializable `FileSystemDirectoryHandle` objects
(because handles can't be JSON-encoded). A one-time migration path reads from
the old `video-editor-db` IndexedDB instance.

**It's GPU-first.** All visual effects (~40), all 13 transitions, blend
compositing, masks, color scopes, glyph atlases, and shape rendering are
WebGPU. Canvas 2D is only a transition fallback for non-WebGPU browsers.

**Export is in-browser WebCodecs.** Containers: MP4, WebM, MOV, MKV. Codecs:
H.264, H.265, VP8, VP9, AV1, ProRes (where supported by the user's browser).

---

## 2. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| UI | React 19 + TypeScript 5.9 | Strict mode (`noUncheckedIndexedAccess`), no `console.*` |
| Build | `vite-plus` (`vp`) | Wraps Vite, Oxlint, Oxfmt, Vitest |
| Router | TanStack Router 1.168 | File-based; `npm run routes` regenerates `routeTree.gen.ts` |
| State | Zustand 5 + Zundo 2.3 | Domain stores + a facade for the timeline; manual snapshot caching for `useSyncExternalStore` |
| Styling | Tailwind 4 + Radix + shadcn | `cn()` helper in `shared/ui` |
| Forms / dialogs | react-hook-form, Sonner toasts | |
| Media decode | mediabunny 1.40 | Off-main-thread via Web Workers |
| Export | WebCodecs in a Web Worker | `features/export/workers/export-render.worker.ts` |
| AI runtimes | `@huggingface/transformers` 4.1, `kokoro-js` 1.2, `onnxruntime-web` | Local-only today |
| Storage | File System Access API + tiny IDB | OPFS used as a fallback when the user dropped a file without granting a handle |
| Hotkeys | react-hotkeys-hook 5.2 | |
| i18n | i18next 25 + react-i18next 16 | 9 locales |

---

## 3. Six-Layer Architecture

FreeCut is divided into six layers. Cross-layer imports are policed by
node-based check scripts in `scripts/`; the pre-push hook runs the full battery
(see §3.7).

```
src/
├── app/             # bootstrap, error boundary, PWA install, service-worker update
├── routes/          # TanStack file routes (/projects, /editor/$projectId)
├── features/        # user-facing UI modules — must use deps/ adapters for cross-feature imports
│   ├── editor/         # shell + toolbar + dialogs + panels orchestration
│   ├── timeline/       # multi-track timeline UI + stores + actions + services + workers
│   ├── preview/        # program / source monitors, overlays, gizmos, scopes
│   ├── export/         # WebCodecs export dialog + render worker
│   ├── effects/        # GPU effect registry + UI panels
│   ├── keyframes/      # bezier graph editor + dopesheet
│   ├── media-library/  # import, metadata, proxies, transcription, captioning, drag-drop
│   ├── projects/       # project list, templates, trash, migration UI
│   ├── scene-browser/  # caption / scene search UI
│   ├── settings/       # settings store, hotkey editor, local-inference cache controls
│   ├── workspace-gate/ # folder picker, permission gate (blocks routing)
│   └── project-bundle/ # ZIP import/export
├── runtime/         # frame-driven engines (not user-facing UI)
│   ├── player/         # Clock, Player, VideoSourcePool — Remotion-style: from + durationInFrames
│   └── composition-runtime/  # composes sequences, items, audio, masks, transitions; AudioWorklets
├── infrastructure/  # platform adapters
│   ├── gpu-effects, gpu-transitions, gpu-compositor, gpu-masks, gpu-media,
│   │ gpu-scopes, gpu-shapes, gpu-text, gpu-shared
│   ├── analysis/       # scene detection, captioning, embeddings, optical flow
│   ├── audio/          # SoundTouch time-stretch
│   ├── storage/        # workspace-fs/* + handles-db + legacy-idb migration
│   ├── thumbnails/     # GPU thumbnail renderer
│   └── browser/        # blob URLs, OPFS, mediabunny input adapters
└── shared/          # framework-agnostic primitives + cross-feature Zustand stores
    ├── timeline/       # transition engine + renderers + defaults
    ├── projects/       # schema migrations + normalization
    ├── state/          # playback, selection, editor, source-player, mixer, dialogs
    ├── marquee/        # selection hook + overlay (paired)
    ├── ui/             # cn helper, property controls
    ├── logging/        # structured logger with event accumulation
    ├── typography, graphics, utils/
```

### 3.7 Architecture is enforced by scripts, not just docs

`scripts/` contains six node scripts that policed by the pre-push hook:

- `check-feature-boundaries.mjs` — features import each other only through `deps/`
- `check-deps-contract-boundaries.mjs` — `deps/` files cannot pull in arbitrary code
- `check-legacy-lib-imports.mjs` — tripwire blocking any `@/lib/*` import (layer was removed; never come back)
- `check-deps-wrapper-health.mjs` — fail when a deps wrapper exists but is unused
- `check-feature-edge-budgets.mjs` — caps the number of cross-feature edges per module
- `report-feature-edges.mjs` — JSON/human-readable coupling reports

> **Practical implication for our work:** any new code (chat panel, agent
> tools, integration wrappers) should live in **new top-level feature
> directories**. Cross-feature imports go through new `deps/` adapters or
> through `@/shared/*` and `@/infrastructure/*`, never directly into another
> feature's internals. If we ever need to call into `features/timeline/` from
> `features/agent/`, we must add an adapter in `features/agent/deps/`.

---

## 4. Phase 0 Questions, Answered

### 4.1 Timeline data model — how are clips, tracks, transitions, effects represented?

**Frame-driven, Remotion-style.** All timing is in **frames at project FPS**,
not seconds: `from` (start frame) + `durationInFrames`.

**`TimelineItem`** (`src/types/timeline.ts:360`) is a discriminated union on `type`:

```ts
type TimelineItem =
  | VideoItem      // src, mediaId, sourceWidth/Height, optional audioSrc
  | AudioItem      // src, mediaId, waveformData, audio EQ + pitch fields
  | TextItem       // text + textSpans + typography + textStylePresetId
  | ImageItem      // src, mediaId — GIFs use this type, no separate gif type
  | ShapeItem      // shapeType + fill/stroke + optional mask flags
  | AdjustmentItem // effects apply to all tracks ABOVE
  | CompositionItem // wraps a pre-comp (1-level nesting)
  | SubtitleSegmentItem // owns a full cue list, replaces "one TextItem per cue"
```

Every item carries: `id`, `trackId`, `from`, `durationInFrames`, `label`,
optional `mediaId`, optional `linkedGroupId` (for synced A/V pairs),
`transform`, `crop`, `effects: ItemEffect[]`, `blendMode`,
`cornerPin`, plus a **deep** audio-mixing block (clip volume, fades with
shaped curves, pitch in semitones+cents, full 6-band parametric EQ).

**Subtle but important fields:**

- `sourceStart` / `sourceEnd` / `sourceDuration` / `sourceFps` — in
  **source-native FPS frames**, not project FPS. Must convert via `sourceFps`
  before treating as seconds.
- `originId` — survives splits; siblings of a split share the original id so
  `StableVideoSequence` keeps stable React keys and the decoder pool reuses
  warm sources.
- `linkedGroupId` — keeps video↔audio pairs (or any companion items) synced.
- `reverseConform*` — set of fields tracking that reversed-clip rendering has
  been precomputed and cached on disk. Reverse playback is non-trivial; we
  should not invent our own reverse pipeline.

**`TimelineTrack`** (`src/types/timeline.ts:370`):

```ts
interface TimelineTrack {
  id, name, kind?: 'video' | 'audio',
  height, locked, syncLock?, visible, muted, solo,
  volume?, audioEq?,             // per-track mixing
  order,                          // lower value = visually higher (top)
  items: TimelineItem[],
  parentTrackId?, isGroup?, isCollapsed?  // 1-level group tracks; groups hold no items
}
```

Track `order` is the **vertical ordering convention**: **lower = higher on
screen**. New tracks created above existing ones use `minOrder - 1`. Group
tracks are header-only and must be filtered out when looking for an items
target.

**`Transition`** (in `src/types/transition.ts`): cut-centered, bridges
`leftClipId`/`rightClipId`. Each transition has a `gpuTransitionId` linking to
a WebGPU pipeline; a Canvas 2D `renderCanvas()` fallback exists for non-WebGPU.
There are **13 transition kinds** (fade, wipe, slide, flip, clockWipe, iris,
dissolve, sparkles, glitch, lightLeak, pixelate, chromatic, radialBlur).

**`ItemEffect`** — every effect is **GPU-only** post-v6 migration. Definitions
in `src/infrastructure/gpu-effects/effects/{blur,color,distort,keying,stylize}.ts`.
Specialized UI panels exist for `gpu-curves` and `gpu-color-wheels`; all others
use the generic `GpuEffectPanel`.

**Keyframes** (`ItemKeyframes` in `src/types/keyframe.ts`) are stored in a
**separate domain store** keyed by `itemId`, with one bezier curve per
animated property. Easing presets: linear, ease-in/out, cubic-bezier, spring.

**Markers**, **in-point/out-point**, **compositions (pre-comps)**, **bus EQ**,
**master bus dB**: all stored per-project.

### 4.2 Timeline state architecture — stores, facade, mutations

The timeline is **not a single store**. It is **six domain stores plus a
facade plus action modules**:

```
Domain stores (Zustand)                      Public API
─────────────────────────                     ──────────────────────────────
items-store           (items + tracks)       timeline-actions.ts (re-exports
transitions-store     (transitions)          from actions/{item,track,
keyframes-store       (keyframes)            transition,keyframe,marker,
markers-store         (markers, in/out)      settings,source-edit,composition,
timeline-settings-    (fps, scroll, snap,    project-item,transform,effect}.ts)
  store                isDirty)              ──────────────────────────────
timeline-command-     (undo/redo stacks)     useTimelineStore   ← facade with
  store                                                            snapshot
+ ~30 transient UI stores (drag previews,                          caching for
  hover, drop zones, dialogs, marquee, etc.)                       useSyncExternal
                                                                   Store
```

**Facade** (`features/timeline/stores/timeline-store-facade.ts`): combines the
six domain stores into the legacy `useTimelineStore()` API. It manually caches
the combined snapshot using last-reference comparison to avoid `useSyncExternalStore`
infinite loops. Components subscribe to the facade with selectors.

**Action modules** (`features/timeline/stores/actions/*.ts`): the **public
mutation API**. Each cross-domain operation is a plain function that:

1. Reads current state via `useXStore.getState()`
2. Wraps the mutation in `execute(commandType, () => { ... })` from `shared.ts`
3. `execute()` (in `timeline-command-store.ts:82`) captures a snapshot,
   runs the action, captures the after-snapshot, and pushes a `CommandEntry`
   onto the undo stack only if state changed
4. Often calls `applyTransitionRepairs(changedClipIds)` afterward — transitions
   self-heal or report breakages via the `timeline.transitionBreakagesDetected`
   domain event

**Critical for AI integration:** these action functions have **zero React
dependencies** — `grep -rn "React|useEffect|useState|useRef|useMemo" actions/`
returns nothing. They can be called from anywhere: a button onClick, a worker
message, a hotkey handler, **or an LLM tool handler**.

### 4.3 How clips get added programmatically

There is a **clean, documented programmatic insertion path** that doesn't go
through drag-and-drop UI:

```ts
// 1. (Optional) import external media into the library
const [meta] = await useMediaLibraryStore.getState().importMediaFromUrl(url)

// 2. Get the playable blob URL for it
const blobUrl = await mediaLibraryService.getMediaFile(meta.id)

// 3. Build the TimelineItem
import { buildMediaTimelineItem } from '@/features/timeline/utils/media-timeline-item-builder'
const item = buildMediaTimelineItem({
  media: meta,
  mediaId: meta.id,
  mediaType: 'video',          // or 'audio' | 'image'
  label: meta.fileName,
  projectFps: useTimelineStore.getState().fps,
  blobUrl,
  canvasWidth, canvasHeight,
  placement: { trackId, from: fromFrame, durationInFrames },
})

// 4. Insert via the public action
import { addItem } from '@/features/timeline/stores/actions/item-actions'
addItem(item)
```

`addItem` internally calls `placeItemsWithoutTimelineOverlap([item])` so it
will **shift the requested `from` to avoid colliding with existing items on
the same track**. Bulk `addItems` exists for atomic batches.

**Public action functions worth knowing** (in `actions/item-actions.ts`):

```
addItem, addItems, updateItem, removeItems, rippleDeleteItems,
moveItem, moveItems, moveItemsWithTrackChanges, duplicateItems,
unlinkItems, linkItems, reverseItems, closeGapAtPosition,
closeAllGapsOnTrack, trackPushItems
```

Plus equivalent modules for tracks, transitions, keyframes, markers, source
edits, compositions, effects, transforms.

### 4.4 Async clip insertion — what happens during playback / export?

**Short version:** mutations during playback are safe; mutations during
export are gated by an `isExporting` flag in the export hook and should not be
attempted.

**Playback:**

- `usePlaybackStore` is a separate Zustand store tracking `currentFrame`,
  `isPlaying`, `previewFrame`, `frameUpdateEpoch`, `previewQuality`,
  `masterBusDb`, `busAudioEq`.
- The composition runtime subscribes to both the items store and the playback
  store. When `items` changes mid-playback, components re-render and the
  composition rebuilds. The render loop in `pumpRenderLoop` uses a
  single-mutex (`scrubRenderInFlightRef`) and a generation counter to
  serialize itself.
- DOM video elements during transitions are coordinated by `data-transition-hold`;
  `clearTransitionPlaybackSession` cleans this up.
- **Inserting a clip mid-playback is therefore safe**; the next render tick
  picks it up. Removing a currently-playing item is also safe — the renderer
  will fall back to the underlying track's next item or the background.

**Export:**

- `features/export/hooks/use-client-render.ts` manages an `isExporting` flag
  and a `cancelExport` callback (file lines 80, 509, 607).
- Export reads timeline state once into a serialized composition
  (`convertTimelineToComposition`), resolves media URLs, then hands it to
  `export-render.worker.ts` for off-main-thread frame rendering. Mutating
  the timeline mid-export changes the editor's state but **does not affect
  the in-flight render**, which is operating on its captured snapshot.
- **Recommendation:** when we add tool calls, gate timeline-mutating tools
  on `!isExporting` and either queue or reject with a clear error during
  export.

**Autosave (`features/editor/hooks/use-auto-save.ts`):** debounced
`saveTimeline(projectId)` writes the timeline + a project thumbnail to disk.
The save path navigates back to the root composition if a sub-comp was active,
saves, and restores the breadcrumb path — so it's safe to call at any time.

**Undo/redo:** every action wrapped in `execute()` snapshots before+after and
pushes to the undo stack. Snapshots are deep-cloned references to the items,
tracks, transitions, keyframes, markers arrays — bounded in memory by
`useSettingsStore.maxUndoHistory`.

### 4.5 UI ↔ editor-core coupling

**The action layer is fully decoupled from React.** Confirmed by grep:
`actions/*.ts` imports zero React APIs. Mutations work from any execution
context.

**The editor shell** (`features/editor/components/editor.tsx`) is a thick
component that wires together:

- Routing data (project metadata from the route loader)
- Resizable panel layout (`react-resizable-panels`)
- Toolbar, MediaSidebar, PreviewArea, PropertiesSidebar, Timeline, AudioMeterPanel
- Several dialog modules (export, bundle export, settings, shortcuts, TTS,
  bento layout, reverse-conform, silence/filler removal, project upgrade,
  embedded-subtitle picker, clear-keyframes, project-media-match)
- Hotkeys (`useEditorHotkeys`), autosave (`useAutoSave`),
  shortcuts (`useTimelineShortcuts`), transition-breakage notifications
- All dialogs are **lazy-loaded** via `React.lazy(() => importExportDialog(), ...)`
  so the initial editor bundle is small.

**Right place to inject a chat panel:** as a new resizable panel in
`editor.tsx`, alongside `PropertiesSidebar`. Or as a floating overlay if we
want to avoid touching the layout shell.

**Storyboard view** can be a sibling component to `Editor` selected by a top-level
view-switcher in the route, or a totally separate route (`/storyboard/$projectId`).
The route loader (`routes/editor/$projectId.tsx`) only validates the project
exists; it doesn't tie us to any particular UI.

### 4.6 What FreeCut already does (do not rebuild)

| Capability | Where it lives | Reuse strategy |
|---|---|---|
| Multi-track timeline with split/join/ripple/rolling/slip/slide/rate-stretch | `features/timeline/stores/actions/*` | Call directly from tool handlers |
| Transitions (13 GPU + Canvas 2D fallback) | `shared/timeline/transitions/`, `infrastructure/gpu-transitions/` | Use `addTransition` action; we get all 13 for free |
| Effects (~40 GPU effects across blur/color/distort/keying/stylize) | `infrastructure/gpu-effects/effects/` | Add via `addEffect` action with `gpuEffectId` |
| Blend modes (25), masks, corner-pin, keyframes | `infrastructure/gpu-compositor`, `infrastructure/gpu-masks`, `features/keyframes/` | Already on items via `blendMode`, `cornerPin`, separate keyframes store |
| Audio: EQ, fades with shaped curves, pitch (semitones+cents), master+monitor bus | per-item `audioEq*` fields, `infrastructure/audio` (SoundTouch worklet) | Set fields via `updateItem`; SoundTouch handles preview pitch in real-time |
| Color scopes (waveform/vectorscope/histogram) | `infrastructure/gpu-scopes` | Available in preview panel |
| Local Whisper transcription | `features/media-library/services/media-transcription-service.ts` | Wrap as `transcribe(asset_id)` tool — use `transcribeMedia()` then `insertTranscriptAsCaptions()` |
| Local Kokoro TTS | `features/editor/services/kokoro-tts-service.ts` | We're switching to ElevenLabs — keep Kokoro as a free fallback |
| Local MusicGen | `features/editor/services/musicgen-service.ts` | Already provides music generation; we may not need a new music tool |
| AI captioning (vision-language model on frames) | `infrastructure/analysis/captioning/lfm-captioning-provider.ts` | Already exists for captioning B-roll moments |
| Scene detection (histogram + optical flow + optional VLM verification) | `infrastructure/analysis/scene-detection.ts` | Wrap as `auto_split_at_scenes(clip_id)` tool if useful |
| Subtitle items (`SubtitleSegmentItem`) | `src/types/timeline.ts:302` and `services/media-transcription-service.ts:481` | Use existing primitive; `insertTranscriptAsCaptions` auto-creates a caption track and aligns cues |
| Project bundle (ZIP) export/import with Zod schemas | `features/project-bundle/` | Already exists; not needed for v1 |
| Reverse playback with disk-cached conforms | `features/timeline/services/reverse-conform-service.ts` | Don't reinvent |
| Media import (URL, file, drag-drop), proxy/thumbnail/waveform/filmstrip generation | `features/media-library/` | URL import works today — `useMediaLibraryStore.getState().importMediaFromUrl(url)` |
| GPU thumbnails sampled across the timeline | `infrastructure/thumbnails/` | Already wired into clip filmstrips |
| Workspace folder, project soft-delete + restore, orphan cleanup, schema migrations | `infrastructure/storage/workspace-fs/*`, `shared/projects/migrations/` | Treat as given |
| Export via WebCodecs in a worker | `features/export/` | Wrap as `export_project(filename, codec, quality)` tool when needed |
| Local-inference runtime registry (track loaded ML models, unload on demand) | `shared/state/local-inference/` | Register new external runtimes here too, for unified visibility |

### 4.7 What FreeCut does NOT do (gaps we may need to fill)

1. **No remote generation.** Every AI capability is a local model. There is
   no abstraction for fal/kie/ElevenLabs/Hyperframe calls; we'll add a new
   `features/integrations/` module.
2. **No chat / agent panel.** No LLM provider abstraction. No tool
   orchestrator. No "agent thinks → calls a tool → tool affects timeline" loop.
3. **No storyboard view.** Scene cards, per-card regenerate, "send to timeline"
   ordering — none of this exists.
4. **No external-URL → managed-clip lifecycle.** `importMediaFromUrl` exists,
   but there is no concept of "this clip was generated by an AI service with
   prompt P at cost C using model M and can be regenerated". We'll add a
   `generationMetadata` sidecar (probably one of the AI-output kinds — see §5).
5. **No tool-call observability.** Today there's a structured logger
   (`shared/logging/logger.ts` — the wide-event pattern) we should mirror for
   tool calls.
6. **No project-level snapshot/JSON dump suitable for an LLM prompt.** The
   timeline JSON shape is large and human-illegible (every audio EQ field is
   explicit, every transform optional). We'll need a **lossy summarizer** —
   see §5 "How should the agent reason about timeline state?".
7. **No queueing for long-running operations.** Each AI service has its own
   queue or generation lock; nothing unifies them. The local-inference registry
   tracks runtimes but not jobs.

---

## 5. Open Questions — Locked Decisions

> These are the decisions in force. They were the **Recommendation** entries on
> the first draft of this document; the user confirmed them with a "use your
> best judgement" instruction, and they are now locked unless explicitly
> reopened. Phase 1 work proceeds on these assumptions.

### Q1. LLM provider strategy

**Decision: Claude Agent SDK subprocess driven by the user's Claude Code /
Max subscription. No paid Anthropic API in v1.**

Reasoning and implications:

- This is a personal / local project. Subscription-based access matches the
  user's existing setup (the same approach as the gateway project mentioned
  in the brief). No per-token billing, no API key in `.env`.
- **Architectural cost — this requires a local Node process.** A browser tab
  cannot spawn a subprocess or authenticate against a Claude Code session, so
  the agent runtime lives outside the browser:

  ```
  Browser (FreeCut + chat panel)
    ↕ local WebSocket / HTTP
  Local Node server  (apps/agent-server/, runs the Agent SDK,
    │                  owns the tool registry, handles long-running jobs)
    ↕
  Claude Code subprocess  (auth via the user's subscription)
  ```

- **Tool handlers live on the Node side.** When a tool like `add_subtitles`
  fires, the Node handler does its work (API calls, file writes, etc.) and
  sends a structured "timeline mutation" message back to the browser, which
  invokes the matching `features/timeline/stores/actions/*` function. This
  keeps the timeline as the single source of truth and the browser as the
  only place that actually mutates editor state.
- **Tool exposure is "native Agent SDK tools" by default, MCP only where
  earned.** Per the brief's discipline rule. Most tools will be plain
  TypeScript functions registered with the Agent SDK. MCP servers may earn
  their place later (e.g. exposing FreeCut tools to *other* Claude clients).
- **LLM provider abstraction (`LlmProvider.chat(messages, tools)`) still
  wraps the choice** so a fall-back to the paid Anthropic API or another
  provider is a one-file change if the subscription path ever fails.
- Open details deferred to Phase 1 planning: exact transport (WebSocket vs
  SSE), how the Node server is launched (background daemon vs spawned on
  app open vs `npm run dev:agent`), how it shares secrets with the browser,
  and how it surfaces in the dev-server / production-build flow.

### Q2. Asset storage

**Decision: local filesystem only for v1, matching FreeCut's existing
model.**

FreeCut's workspace folder already handles everything — including AI-generated
audio (`importGeneratedAudio`) which lands in `media/<id>/`. Generated video
from fal/kie should follow the same path:

1. Tool downloads the URL → `Blob`
2. Calls `useMediaLibraryStore.getState().importMediaFromUrl(url)` (which
   writes to OPFS) **or** writes via `writeMediaSource` + `createMedia`
3. Resulting `MediaMetadata` flows through the normal media-library lifecycle

S3/R2 is unnecessary until we want sharing or web playback of the source URLs,
which isn't a v1 requirement.

### Q3. Project file format

**Already decided by FreeCut: JSON per project, on disk.**

Layout (from `infrastructure/storage/workspace-fs/paths.ts`):

```
{workspace}/
├── README.md
├── .freecut-workspace.json
├── index.json                       # workspace index of project IDs
├── projects/{id}/
│   ├── project.json                 # the full Project + ProjectTimeline JSON
│   ├── thumbnail.jpg
│   └── media-links.json             # media association for this project
├── media/{id}/
│   ├── metadata.json                # MediaMetadata
│   ├── {sanitizedName}.{ext}        # the source file (or source.link.json for handle-only)
│   ├── thumbnail.jpg
│   └── cache/
│       ├── filmstrip/, waveform/, gif-frames/, decoded-audio/,
│       │ preview-audio.wav, reverse-conform/
│       └── ai/
│           ├── transcript.json, captions.json, scenes.json,
│           │ captions-embeddings.bin, captions-image-embeddings.bin
│           └── {kind}.json          # generic AiOutput envelope — one file per kind
└── content/{hash[0:2]}/{hash}/      # content-addressable dedup for proxies
    └── proxies/{proxyKey}/proxy.mp4
```

The current schema is `WORKSPACE_SCHEMA_VERSION = '2.0'`. Project schema is
versioned independently (`CURRENT_SCHEMA_VERSION` in
`shared/projects/migrations/types.ts`); every load runs migrations and persists
back if needed.

**Where new state lives:**

- **Scene cards (Workflow 1)**: extend `Project` with a `storyboard?: Scene[]`
  field. Bump `CURRENT_SCHEMA_VERSION`. Add a migration that initializes empty
  arrays on existing projects (no schema change required for them).
- **Per-clip AI generation metadata**: use the generic AI-outputs envelope.
  Add a new `AiOutputKind` (e.g. `'generation'`) and write `generation.json`
  under `media/{id}/cache/ai/` recording prompt, model, cost, timestamp,
  source URL.
- **Chat history**: a new file under `projects/{id}/chat.json` — does not
  belong in `project.json` because we don't want chat events on the undo stack.

**No SQLite.** Plain JSON is git-friendly, debuggable, and matches the
existing pattern. We won't hit a scale problem here.

### Q4. API key management

**Decision: v1 uses `.env` with `VITE_*` prefixes.** Long-term: move to a settings UI that
writes to a tiny IDB record (parallel to the existing `freecut-handles-db`),
or to a file under the workspace (`{workspace}/.secrets.json` — but **add it
to `.gitignore`** if the workspace is ever checked in).

### Q5. Default model for `generate_broll`

**Decision: configurable per-project, default cost-optimized.** For
a personal/self-hosted tool the cost ceiling matters more than the marginal
quality jump. Make it a setting in the storyboard scene side panel, and
inherit it for timeline-tool calls.

### Q6. Browser or Electron?

**Decision: browser-only.** FreeCut already requires File System Access API (Chromium-only
anyway) and the workspace folder model is fully native to the file system.
Electron adds maintenance burden for no UX gain on Chromium-based browsers.
Defer to "later".

### Q7. Whisper hosting

**Decision: ship both local Whisper and OpenAI Whisper API as parallel
transcription providers; user-selectable per project / per call.**

- **Local Whisper** (FreeCut's existing path —
  `features/media-library/services/media-transcription-service.ts`) for short
  audio: free, private, fits the FreeCut ethos.
- **OpenAI Whisper API** for long-form audio (2–3 hr videos) where local
  Whisper is impractically slow on consumer hardware. This is the real reason
  we're adding it — a 3-hour interview at consumer GPU speeds can take longer
  than the source.
- Both implement a common `TranscriptionProvider` interface. The transcript
  output schema (`media/{id}/cache/ai/transcript.json`) is the same regardless
  of provider; we add a `source: 'local-whisper' | 'openai-whisper'` field so
  the UI can show which produced a given transcript.
- **Selection strategy:** default to local for clips under ~30 min, surface a
  per-call override in the transcribe dialog, and add an automatic-routing
  setting (`auto / always-local / always-cloud`) in app settings. `OPENAI_API_KEY`
  in `.env` enables the cloud path; missing key → cloud option grayed out.

### Q8. How should the agent reason about timeline state?

**This is the most important question. Decision: hybrid.**

The full `Project + ProjectTimeline` JSON is huge — see `src/types/project.ts`,
which has ~300 lines of optional fields per item alone. Sending it on every
turn would (a) blow context budget, (b) waste tokens on irrelevant audio EQ
fields, and (c) make the agent reason at the wrong level.

**Hybrid pattern:**

1. **Inject a compact, lossy timeline snapshot in the system prompt** at the
   start of each turn — *not* the raw JSON. Something like:

   ```
   Timeline (30 fps, 1920x1080, 4:32 duration):
     V2  [00:00-00:12 "intro.mp4"] [00:12-00:18 GAP] [00:18-00:45 "scene1.mp4"]
     V1  [00:00-04:32 background music ducking]
     A1  [00:00-04:32 voiceover.wav]
     Captions  [12 segments, 00:18-04:30]
   Selected: clip "scene1.mp4" (id: clip_a8f2)
   Playhead: 00:34
   ```

   Generate this from the existing stores via a new
   `summarizeTimelineForAgent()` helper. Keep it under ~500 tokens.

2. **Provide a `get_timeline_state(detail_level)` tool** for when the agent
   needs more detail than the snapshot. `detail_level` can be
   `summary | item_ids | full_item(id) | range(from, to)`. The agent calls
   it only when needed (rare in practice once the snapshot exists).

3. **Resolve ambiguity through IDs in the snapshot.** Every clip in the
   snapshot carries its ID. When the user says "replace this clip", the agent
   either resolves "this" via the selection store (which IS in the snapshot)
   or asks.

This avoids the worst case of either approach: not so heavy it bloats every
turn, not so thin the agent constantly tool-calls for context.

### Q9. HeyGen Hyperframe — scope and integration

**Decision: add a `features/integrations/hyperframe.ts` adapter alongside the
fal/kie/ElevenLabs ones; defer specific tool definitions until we have API
docs in hand.**

The original brief listed "Hyperframe API" for motion graphics / lower thirds.
The actual product we're integrating is **HeyGen Hyperframe**, whose capability
set (avatar generation, talking heads, motion graphics, or some combination)
will determine which high-level tools wrap it:

- If it's primarily motion graphics → `add_lower_third(text, style, …)`,
  `add_title_card(text, style, …)`.
- If it's talking-head / avatar generation → `generate_avatar_clip(script, avatar_id, …)`,
  `regenerate_talking_head(clip_id, new_script, …)`.
- If both → both sets of tools, dispatched off a `mode` parameter on the
  underlying adapter.

We treat Hyperframe as a **planned-but-undefined provider** in the integrations
layer for the duration of Phase 1 setup. The actual tool definitions land
when (a) the user provides HeyGen API credentials in `.env`, and (b) we read
the Hyperframe endpoint docs to know exactly what we can call. This keeps the
provider in scope without committing to incorrect tool signatures up front.

### Q10. First-video target (drives Phase 1 ordering)

**Decision (default, made under "use your best judgement"):** plan Phase 1
against an **existing-footage workflow** — auto-transcribe a screen recording
or interview, generate captions, cut silence, insert a few B-roll moments
from fal/kie at specific timestamps. This matches the brief's recommended
build order (`transcribe → add_subtitles → generate_broll →
replace_clip_with_regeneration → cut_silence → add_lower_third →
generate_voiceover`) and exercises every async pattern (local-only,
remote-async, in-place edit, placeholder→insert).

This default is overridable if the actual next video on the desk is
a faceless YouTube short — in that case we'd front-load Workflow 1 primitives
(`break_script_into_scenes`, `generate_scene_clip`, `send_to_timeline`)
before the timeline-editing tools. Flag this early in planning if needed.

### Q11. Vision / captioning provider strategy

**Decision: ship both the existing local vision model and Gemini Flash via
the Google AI API as parallel providers for frame analysis, scene
description, and captioning; user-selectable per call.**

- **Local** (FreeCut's existing LFM captioning path,
  `infrastructure/analysis/captioning/lfm-captioning-provider.ts`, plus the
  Gemma-based scene-detection verification path) — used for fast, private
  captioning of short clips.
- **Gemini Flash** via the Google AI API — used for complex scene analysis on
  long videos and for cases where local models are too small or too slow:
  richer multi-frame reasoning, OCR, on-screen-text extraction, sentiment.
- Both implement a common `VisionProvider` interface. Output schema
  (`MediaCaption[]` and friends, persisted via the existing AI-output
  envelope at `media/{id}/cache/ai/captions.json`) is shared.
- **Selection strategy:** mirrors transcription — default local, with a
  per-call override and an app-level auto-routing setting. Long clips and
  complex queries route to Gemini Flash when enabled. `GEMINI_API_KEY` in
  `.env` enables the cloud path.
- The exact Gemini model version (the user said "3.5 Flash" — interpret as
  whatever Google Flash variant is current when we wire this up) is a
  one-line config in the provider adapter.

### Q12. Provider abstraction layer

(Implicit from Q7 and Q11 — call it out so we don't re-derive it per
capability.) Every capability that has more than one runtime gets a thin
provider interface. Five exist or are now planned:

| Capability | Local provider | Cloud provider |
|---|---|---|
| Transcription | local Whisper (existing) | OpenAI Whisper API |
| Vision / captioning | LFM + Gemma (existing) | Gemini Flash API |
| Video generation | — | fal, kie (model arbitrage between them) |
| TTS | Kokoro (existing) | ElevenLabs |
| Music generation | MusicGen (existing) | — (no v1 cloud need) |
| Motion graphics / avatars | — | HeyGen Hyperframe |

All providers register against `shared/state/local-inference/registry.ts`
(which already conceptually supports both local and remote runtimes) so the
unified status panel can show what's available and what's running.

---

## 6. Suggested Plan for Phase 1

(Per the brief — building Workflow 2 first, before Workflow 1.)

1. **New top-level features:**
   - `src/features/agent/` — chat panel UI, LLM provider, tool orchestrator
   - `src/features/agent/tools/` — high-level tool definitions + handlers
   - `src/features/integrations/` — fal, kie, ElevenLabs, Hyperframe API wrappers
   - Each gets a `deps/` adapter for cross-feature imports (boundary checks
     will fail otherwise)

2. **Tool orchestrator skeleton** — define `Tool<Params, Result>` interface
   (name, JSON schema for params, handler, async progress callback). One dummy
   tool that returns "hello"; verify the agent can call it.

3. **Chat panel** — new resizable panel in `editor.tsx`. Lazy-load like the
   other dialogs. Subscribes to the timeline-summary helper from §5.Q8.

4. **First real tool: `transcribe(asset_id)`** — wraps
   `mediaTranscriptionService.transcribeMedia()`. Returns transcript JSON.
   No timeline writes yet — simplest async surface.

5. **Second tool: `add_subtitles(asset_id, style)`** — wraps
   `insertTranscriptAsCaptions(mediaId, options)`. First real timeline write.
   `SubtitleSegmentItem`, caption-track auto-creation, cue alignment — all
   already exist.

6. **Third tool: `generate_broll(prompt, start_time, end_time, model)`** —
   the first remote async generation. Solve the **progress + insertion
   pattern** here. Reuse will be:
   - Insert a placeholder TimelineItem at `(start, end)` with status "generating"
   - Subscribe to a progress channel; surface in chat panel and on the clip
   - On completion: download the URL, register via `importMediaFromUrl`,
     `buildMediaTimelineItem` with the same `from`/`durationInFrames`, then
     `updateItem(placeholderId, { ...newItem, id: placeholderId })` or remove
     + add atomically via `addItems` + `removeItems` in one undo entry
   - On failure: mark the placeholder errored, leave for user retry

7. **Fourth–seventh tools** per the brief: `replace_clip_with_regeneration`,
   `cut_silence`, `add_lower_third`, `generate_voiceover`. Each reuses the
   patterns above; none should need new low-level primitives once the first
   three are working.

### Pre-Phase-1 prerequisites worth doing first

- **Local agent-server scaffold** — a Node process at `apps/agent-server/`
  (or similar) that hosts the Claude Agent SDK, owns the tool registry, and
  exposes a WebSocket to the browser. Required by Q1's subscription-subprocess
  decision; nothing else can start without it. Probably needs a
  matching `npm run dev:agent` script and a way to launch it alongside `npm
  run dev`. **Open question for planning:** does it ship as part of FreeCut's
  dev tooling, or as a sibling repo / separate install?
- **Provider abstraction layer** — `features/integrations/providers/` with
  `TranscriptionProvider`, `VisionProvider`, `VideoGenerationProvider`,
  `TtsProvider` interfaces. Trivial to write; lets us register local + cloud
  providers symmetrically (Q12) and gates the multi-provider work in Q7/Q11.
- **`summarizeTimelineForAgent()` helper** in `shared/` — small, pure, tested
  in isolation. The agent design depends on it (see Q8). Half a day.
- **Decide AI-output schema for generation metadata** — add `'generation'` to
  `AiOutputKind` and define the payload shape. Trivial.
- **Bump `CURRENT_SCHEMA_VERSION`** if/when we add `Project.storyboard` —
  always paired with a migration that initializes the field.

---

## Appendix A — Notable Gotchas Discovered

These will bite us if we don't know them. All distilled from `CLAUDE.md` and
confirmed in code:

- `sourceStart/sourceEnd/sourceDuration` are in **source-native FPS**, not
  project FPS. Convert via `sourceFps`.
- Track `order`: lower = top of timeline. New tracks above use `minOrder - 1`.
- Group tracks (`isGroup: true`) are headers only; never place items on them.
- `_splitItem()` returns `{ leftItem, rightItem } | null` — capture the return
  for correct IDs; the original ID is stale on the right half after split.
- `addItem` may shift `from` to avoid collision; tool callers should not
  assume the requested frame is the final frame. Inspect the inserted item.
- After any clip edits that change position/duration, action code calls
  `applyTransitionRepairs(changedClipIds)` — transitions auto-heal or report
  breakages via the `timeline.transitionBreakagesDetected` domain event.
  Tool handlers should follow the same pattern.
- `_splitItem`, `removeItems`, etc. cascade to transitions and keyframes via
  the action wrappers, not the domain stores. **Always go through actions,
  never through `useItemsStore.getState()._addItem` directly.**
- `shared/logging/logger.ts` only uses `function` declarations to dodge TDZ
  errors in production chunk ordering — maintain this if we add new logging
  code there.
- Eagerly-warmed GPU pipeline is cached globally; don't dispose it.
- `__DEBUG__` is a DEV-only window object with `stores()`, `getTransitions()`,
  `seekTo`, `play`, `pause`, `transitionTrace()`, etc. — useful for
  prototyping tool calls in the console before wiring them to the agent.

## Appendix B — Quick Lookups

- Main entry: `src/main.tsx` → `src/app.tsx` → `WorkspaceGate` →
  `RouterProvider` → `/editor/$projectId` → `Editor`.
- Editor route loader: `src/routes/editor/$projectId.tsx` (validates project
  exists + flags schema upgrades).
- Editor shell: `src/features/editor/components/editor.tsx`.
- Timeline facade: `src/features/timeline/stores/timeline-store-facade.ts`.
- Action API barrel: `src/features/timeline/stores/timeline-actions.ts`.
- Playback store: `src/shared/state/playback/store.ts`.
- Local-inference registry: `src/shared/state/local-inference/registry.ts`.
- AI output envelope: `src/infrastructure/storage/workspace-fs/ai-outputs/`.
- Project type: `src/types/project.ts`. Timeline item: `src/types/timeline.ts`.
- Workspace paths: `src/infrastructure/storage/workspace-fs/paths.ts`.
- Migrations: `src/shared/projects/migrations/`.
- Debug utilities: `src/app/debug/`.

---

_End of Phase 0 reconnaissance. Do not begin Phase 1 implementation until
this document has been read end-to-end and the open-question recommendations
in §5 have been either accepted or revised._
