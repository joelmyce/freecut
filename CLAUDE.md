# FreeCut Web

## Commands

```bash
npm run dev          # Vite dev server on port 5173
npm run build        # Production build
npm run lint         # Oxlint
npm run format       # Oxfmt
npm run format:check # Check formatting with Oxfmt
npm run test         # Vitest (watch mode)
npm run test:run     # Vitest (single run)
npm run routes       # Regenerate TanStack Router tree (tsr generate)
```

## Architecture

Browser-based multi-track video editor. React 19 + TypeScript + Vite.

```text
src/
├── features/              # User-facing UI modules
│   ├── editor/            # Editor shell, toolbar, panels, stores
│   ├── timeline/          # Multi-track timeline, actions, services
│   ├── preview/           # Preview canvas, transform gizmo, scrub renderer
│   ├── export/            # WebCodecs export pipeline (Web Worker)
│   ├── effects/           # GPU effect UI panels and registry
│   ├── keyframes/         # Keyframe animation, Bezier editor, easing
│   ├── media-library/     # Media import, metadata, OPFS proxies, transcription
│   ├── project-bundle/    # Project ZIP export/import
│   ├── projects/          # Project management
│   ├── scene-browser/     # Caption and scene search UI
│   ├── settings/          # App settings
│   └── workspace-gate/    # Workspace picker / permission gate
├── runtime/               # Playback and rendering engines (not user-facing UI features)
│   ├── composition-runtime/ # Composition rendering (sequences, items, audio, transitions)
│   └── player/            # Clock, video source pools, composition playback
├── infrastructure/        # Platform adapters — browser, storage, GPU, ML, audio
│   ├── gpu-effects/       # WebGPU effect pipeline + shader definitions
│   ├── gpu-transitions/   # WebGPU transition pipeline + shaders
│   ├── gpu-compositor/    # WebGPU blend-mode compositor
│   ├── gpu-masks/         # Mask combine pipeline + texture manager
│   ├── gpu-media/         # Media render/blend pipelines
│   ├── gpu-scopes/        # Waveform/vectorscope/histogram renderers
│   ├── gpu-shapes/        # Shape render pipeline
│   ├── gpu-text/          # Glyph-atlas text pipeline
│   ├── gpu-shared/        # WGSL fragments shared across GPU modules
│   ├── analysis/          # Scene detection, captioning, embeddings, optical flow
│   ├── audio/             # SoundTouch-based time-stretch
│   ├── browser/           # Blob URLs, OPFS, mediabunny adapter
│   ├── storage/           # Workspace FS persistence + legacy IDB migration
│   └── thumbnails/        # GPU thumbnail renderer + sampling strategy
├── shared/                # Framework-agnostic primitives + cross-feature state
│   ├── timeline/          # Transition engine/registry/renderers, defaults
│   ├── projects/          # Schema migrations and normalization
│   ├── state/             # Zustand stores (playback, selection, dialogs, editor)
│   ├── marquee/           # Marquee-selection hook + overlay (paired unit)
│   ├── logging/           # Structured logger, frame jitter monitor
│   ├── ui/                # cn helper, property controls
│   ├── typography/        # Font loading, text style presets
│   ├── graphics/          # Shape generators and path helpers
│   └── utils/             # Managed workers, color/curve math, easing, async, etc.
├── components/            # shadcn/ui components + brand assets
├── app/                   # App bootstrap, error boundary, PWA prompt, debug
├── config/                # Hotkeys + editor layout config
├── i18n/                  # i18next setup, supported languages, locale JSON + per-feature partials
├── routes/                # TanStack Router (file-based, auto-generated routeTree)
└── types/                 # Shared TypeScript types
```

**Dual-package layout (Phase 1 AI agent):** alongside `src/`, the repo
ships `apps/agent-server/` — a Node + TypeScript npm-workspace package
that hosts the Claude Agent SDK and exposes editing tools to the browser
over a WebSocket bridge on `ws://localhost:5174`. The browser-side client
lives at `src/features/agent/`. Run with `npm run dev:agent` (server only)
or `npm run dev:all` (Vite + server in parallel). The bridge protocol is
manually duplicated at `apps/agent-server/src/bridge/protocol.ts` and
`src/features/agent/bridge/protocol.ts` — keep them in sync. See
`docs/PHASE-1-PLAN.md` for the milestone plan.

## Key Patterns

- **State**: Zustand stores + Zundo for undo/redo
- **Timeline store split**: `useTimelineStore` (from `timeline-store.ts`) is a **facade** over domain stores (`items-store`, `transitions-store`, `keyframes-store`, `markers-store`, `timeline-settings-store`, `timeline-command-store`). Components use the facade with selectors; action code accesses domain stores via `.getState()` directly
- **Timeline mutations**: Action modules in `features/timeline/stores/actions/*.ts` use `execute()` wrapper from `shared.ts` for undo/redo integration. Never mutate timeline stores directly — use these actions
- **Timeline item types**: `TimelineItem` is a discriminated union on `type`: `video | audio | text | image | shape | adjustment | composition` — GIFs use `image` type, no separate gif type. Types in `src/types/timeline.ts`
- **Item positioning**: Remotion convention — `from` (start frame in project FPS) + `durationInFrames`
- **Compositions**: Pre-compositions (sub-comps) have dedicated stores (`compositions-store.ts`, `composition-navigation-store.ts`). 1-level nesting only. Actions in `composition-actions.ts`
- **Migrations**: `src/shared/projects/migrations/` — versioned migrations + normalization run on every project load. Increment `CURRENT_SCHEMA_VERSION` in `types.ts` when adding new migrations
- **Routing**: TanStack Router — run `npm run routes` after adding/changing route files
- **Path alias**: `@/*` → `src/*`
- **i18n**: i18next + react-i18next, initialized in `src/i18n/index.ts` (imported once from `main.tsx`). 9 languages (`en`, `es`, `fr`, `de`, `pt-BR`, `tr`, `ja`, `ko`, `zh`) in `src/i18n/languages.ts`. Base strings in `src/i18n/locales/<lang>.json`; per-feature strings live in `src/i18n/locales/partials/<name>.json` (shape `{ "<lang>": { ...tree slice... } }`, deep-merged over base at startup). In components use `const { t } = useTranslation()`; outside React use `import { i18n } from '@/i18n'` then `i18n.t()` (`@/i18n` is allowed by the boundary checks — it's not `@/features/*`). For strings with inline markup use `<Trans i18nKey=... components={{ strong: <strong/> }} />`. Resources are deliberately untyped (`i18next.d.ts`) so `t()` accepts any key. Language selector lives in the editor Settings dialog (General); persisted to `localStorage` key `freecut-language` by the language detector. When adding new partials, translate all 9 languages and keep identical key structure; never put a bare ASCII `"` inside a JSON string value.
- **Styling**: Tailwind CSS 4 + shadcn/ui (Radix primitives)
- **Media processing**: Mediabunny for decode, WebCodecs for export, Web Workers for heavy ops
- **Storage**: Workspace folder via File System Access API (see `infrastructure/storage/workspace-fs/`). Source of truth is a user-picked directory on disk — projects, media metadata, thumbnails, waveforms, gif frames, decoded audio, transcripts all live as plain files. `WorkspaceGate` (`src/features/workspace-gate/`) blocks app render until a workspace is granted. IndexedDB is only used for a tiny handle registry (`freecut-handles-db` v1, at `infrastructure/storage/handles-db.ts`) that stores non-serializable `FileSystem*Handle` references. Legacy `video-editor-db` is read only by the one-time migration path under `infrastructure/storage/legacy-idb/` (reader.ts + migrate.ts); consumers import from the barrel `@/infrastructure/storage` which routes everything to workspace-fs

## Code Style

- Strict TypeScript (`noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`)
- `no-console` rule — always use `createLogger` from `src/shared/logging/logger.ts`, never raw `console.*` calls
- **Logging**: Use wide event pattern for multi-step operations (export, import, save): `log.startEvent(name, opId)` accumulates context, emits one structured event via `.success()` / `.failure()`. Use `createOperationId()` for correlation. Include business context (project ID, item counts, codec, resolution) in events
- `typescript/no-explicit-any` warned by Oxlint

## Testing

- Vitest + jsdom + @testing-library/react
- `src/test/setup.ts` mocks ImageData, WebGPU APIs (`navigator.gpu`), and GPU constants
- Tests live next to source files: `*.test.ts` / `*.test.tsx`

## Environment

- `VITE_SHOW_DEBUG_PANEL=false` — set to hide debug panel in dev mode (shown by default)

## Git

- `main` — production, `develop` — active development
- PR target: `main`
- Commit messages: conventional commits — `type(scope): description` (e.g. `fix(timeline):`, `feat(export):`)

## Gotchas

- Track groups are 1-level only (no nested groups). Gate behavior (mute/visible/locked) propagates from group to children via `resolveEffectiveTrackStates()` in `group-utils.ts`
- Browser shortcut conflicts (e.g. Ctrl+E) need `eventListenerOptions: { capture: true }` on the hotkey to override Chrome's default behavior
- Feature modules use `index.ts` barrel files to define public API surface — follow this convention when adding new features
- `routeTree.gen.ts` is auto-generated — don't edit manually
- `*.mp4` files are gitignored
- Vite pre-bundles `lucide-react` to avoid analyzing 1500+ icons — don't remove from `optimizeDeps`
- WebGPU tests need mocks from `src/test/setup.ts` — tests will fail without jsdom environment
- Build uses manual chunk splitting — check `vite.config.ts` when adding large dependencies
- `HOTKEY_OPTIONS` has `preventDefault: true` — the library consumes keys before the callback. For panel-scoped shortcuts, use `onKeyDown` on the element with `tabIndex={-1}` + focus-on-hover + `stopPropagation()`, not global `useHotkeys` with guards
- `sourceStart`/`sourceEnd`/`sourceDuration` on timeline items are in **source-native FPS** frames, not project FPS. Use media's `fps` from media library store when converting to seconds
- Track `order` convention: lower value = visually higher (top of timeline). New tracks go at `minOrder - 1`. When creating pre-comps, place the comp item on the bottom-most (highest order) selected track; dissolve expands upward
- Group tracks (`isGroup: true`) are headers only — never place items on them. Filter them out when searching for candidate tracks
- Inline edit cancel (Escape) triggers blur on unmount — use a ref guard to prevent `onBlur` from committing the cancelled value
- `_splitItem()` returns `{ leftItem, rightItem } | null` — capture the return for correct IDs; the original item ID is stale after split
- Timeline has its own `keydown` listener in `timeline.tsx` — new keyboard handlers on child panels must `stopPropagation()` and timeline checks `e.defaultPrevented`
- **Effects are GPU-only** — all visual effects use WebGPU shaders (`type: 'gpu-effect'`). Legacy CSS filter, glitch, halftone, vignette, LUT types were removed in v6 migration. Effect definitions in `src/infrastructure/gpu-effects/effects/`, pipeline in `effects-pipeline.ts`. Specialized UI panels exist for `gpu-curves` and `gpu-color-wheels`; all others use the generic `GpuEffectPanel`
- **Transitions are GPU-only** — all 13 transitions (fade, wipe, slide, flip, clockWipe, iris, dissolve, sparkles, glitch, lightLeak, pixelate, chromatic, radialBlur) render via WebGPU shaders in `infrastructure/gpu-transitions/`. Each renderer in `shared/timeline/transitions/renderers/` has `gpuTransitionId` linking to its shader, plus a `renderCanvas()` Canvas 2D fallback for non-WebGPU environments. `calculateStyles()` is dead code (CSS/DOM transition rendering was removed). Canvas `drawImage` offsets must use `Math.round()` to avoid sub-pixel interpolation artifacts
- After clip edits that change position/duration, call `applyTransitionRepairs(changedClipIds)` from `shared.ts` — transitions auto-heal or report breakages
- `shared/logging/logger.ts` uses only `function` declarations (no `class`/`const` at module scope) to avoid temporal dead zone errors in production chunk ordering — maintain this pattern
- Fast scrub render loop: prewarm frames use WASM decode (40-80ms) and block the loop from processing priority frames. During playback, skip prewarm entirely (`isPlaying` check) — priority frames render fast via DOM video zero-copy (~1ms) and the loop must stay responsive. Background worker preseek (`backgroundPreseek` in `decoder-prewarm.ts`) also fires on large timeline jumps (>3s) for all visible clips — the worker decodes off-thread and the render engine picks up the cached bitmap
- **Render loop concurrency** — `pumpRenderLoop` uses a single-mutex (`scrubRenderInFlightRef`) to prevent concurrent pump iterations during scrubbing. A `scrubRenderGenerationRef` counter is bumped ONLY on playback-start force-clear (not during scrub). The `finally` block releases the lock and triggers follow-up work only when the generation matches; stale pumps (from a superseded playback-start) leave the lock for the new owner. Never bump generation or force-clear the lock on sequential scrub frames — this causes unbounded concurrent pumps. The `data-transition-hold` attribute on DOM video elements coordinates with `video-content.tsx` premount logic and `clearTransitionPlaybackSession` cleanup
- **Transition participant video hold** — during transitions, the incoming clip's DOM video element is paused by `video-content.tsx` premount logic. The transition provider marks it with `data-transition-hold="1"` and calls `.play()` so the canvas renderer gets advancing frames. The mark is removed in `clearTransitionPlaybackSession`. Without this, the incoming clip shows a frozen frame during the transition
- When updating multiple GPU effect params atomically (e.g. color wheel hue + amount), use `onParamsBatchChange`/`onParamsBatchLiveChange` — calling `onParamChange` twice reads stale state on the second call and overwrites the first
- **Reuse rendered frames** — the preview scrub renderer already has fully composited frames with effects/masks/blend modes. Features needing the current frame (thumbnails, scopes, snapshots) should use `usePlaybackStore.getState().captureCanvasSource()` first, falling back to `renderSingleFrame()` only when the preview is unavailable. Never spin up a new render pipeline when an existing one already has the frame
- **Progressive downscaling** — when scaling high-res canvases to small sizes (e.g. 1920→320 thumbnails), halve dimensions repeatedly instead of one large jump. Single-step downscaling causes moire/aliasing with high-frequency GPU effects (halftone, pixelate, etc.)
- `StableVideoSequence`'s `areGroupPropsEqual` in `stable-video-sequence.tsx` whitelists item properties for React.memo comparison. When adding new visual properties to `TimelineItem`, add them to this comparison — missing properties cause stale renders during playback
- **GPU pipeline caching** — `EffectsPipeline.requestCachedDevice()` caches the WebGPU adapter + device globally. Subsequent `EffectsPipeline.create()` calls reuse the device (~50-100ms saved). The device-loss handler checks identity before clearing to avoid discarding a freshly acquired device. The preview component eagerly warms the GPU pipeline on mount (parallel with media resolution)
- **`__DEBUG__` API** — `window.__DEBUG__` (DEV-only, tree-shaken in prod) provides console debugging: `stores()`, `getTransitions()`, `getTransitionWindows()`, `getPlaybackState()`, `getTracks()`, `getMediaLibrary()`, `jitter()` (frame timing), `previewPerf()`, `transitionTrace()`, `prewarmCache()`, `filmstripMetrics()`, plus playback control (`seekTo`, `play`, `pause`). All use lazy `await import()` to avoid pulling in stores eagerly
- **Transition prearm covers all types** — the `forceFastScrubOverlay` subscription uses `getPlayingAnyTransitionPrewarmStartFrame` (not complex-only) so all transitions get their session pinned and DOM video elements playing before entry. Also checks `getTransitionWindowForFrame` for playback starting inside an active transition
- **Feature boundary rules** — cross-feature imports must go through `deps/` adapter modules. The pre-push hook enforces this via `check:boundaries`. (A `check:legacy-lib-imports` tripwire also catches any reintroduction of `@/lib/*` imports — the `src/lib/` layer was removed and merged into `infrastructure/`.)
- **AI generation placeholders** — a `ShapeItem` whose `aiPlaceholder` field is set is a *transient placeholder* for an in-flight AI generation tool (e.g. `generate_broll`), not a user-authored shape. The placeholder is inserted via `insertGenerationPlaceholder` in [ai-generation-actions.ts](src/features/timeline/stores/actions/ai-generation-actions.ts), which **bypasses the undo stack** and stashes a pre-generation snapshot. `swapPlaceholderWithMedia` then does `_removeItems + _addItem` and calls `useTimelineCommandStore.getState().addUndoEntry` with the stashed snapshot, so a single Ctrl+Z rewinds past the placeholder altogether (second Ctrl+Z is a no-op for the generation flow). Cancel/error paths (`removeGenerationPlaceholder`, `markGenerationPlaceholderError`) likewise skip the undo stack. Code that iterates shapes for editing affordances should check `aiPlaceholder` and skip these items
- **AI-generated media** — `MediaMetadata` carries an optional `aiGenerated: { provider, model, prompt, generatedAt }` field set by `useMediaLibraryStore.getState().markMediaAiGenerated` after a successful AI import. The media-library card renders an indigo `Wand2` chip when present; conventionally the in-memory flip happens first (so the UI updates instantly), then `updateMedia(id, { aiGenerated })` from `@/infrastructure/storage` persists it to disk. Mirrors the same in-memory + disk split used by `aiCaptions`
- **fal video provider request body is model-aware** — `apps/agent-server/src/providers/video/fal.ts` branches on the model id when building the POST body: legacy Kling family (`/v1`, `/v1.5`, `/v2.x`) sends `{duration: "5" | "10"}` (snap point 7.5s); Kling v3 family sends `{duration: "3"-"15", generate_audio: false}`. Adding a new fal model that needs a different shape means updating `buildRequestBody` — sending `duration: "6"` to a legacy Kling endpoint 400s
- **AI regen reuses the placeholder→swap pattern** — `replaceClipWithPlaceholder()` in [ai-generation-actions.ts](src/features/timeline/stores/actions/ai-generation-actions.ts) is M3's `insertGenerationPlaceholder` for *existing* clips. Captures snapshot → `_removeItems([clipId])` → `_addItem(placeholder)` → strips the original clip's transitions/keyframes inline. Snapshot stays in `pendingSnapshots`, so the eventual `swapPlaceholderWithMedia` pushes ONE undo entry that rewinds past the whole regen back to the original clip. Same undo semantics as M3's generate_broll
- **`cut_silence` is browser-orchestrated** — the chat agent's `cut_silence` tool does NOT pull audio bytes through the WS bridge for server-side RMS analysis. The browser already owns the whole pipeline (`analyzeSilenceForItems()` + `removeSilenceFromItems()` from [silence-removal-preview.ts](src/features/timeline/utils/silence-removal-preview.ts) and [range-removal-actions.ts](src/features/timeline/stores/actions/edit/range-removal-actions.ts)). The browser handler at [cut-silence.ts](src/features/agent/handlers/cut-silence.ts) is a thin orchestrator that runs both steps and returns a summary. Pattern to repeat for other "local processing" tools — if a primitive already exists in-browser, don't relay it
- **Transcript-grounded prompts** — when a transcript is saved for the time range a generation tool is operating on, the server prepends `VIDEO CONTEXT (from the transcript): "..."` to the model prompt. Shared helper at [prompt-grounding.ts](apps/agent-server/src/tools/prompt-grounding.ts). Two browser action paths: [`read-transcript-context-for-range`](src/features/agent/handlers/transcript-context.ts) for `generate_broll` (window-based, scans timeline clips); the in-clip version is bundled into [`read-clip-for-regen`](src/features/agent/handlers/regenerate-clip.ts) for `replace_clip_with_regeneration`. Best-effort — silent fallback to plain prompt when no transcript overlaps. Tool result exposes `usedTranscriptContext: boolean` for the agent to quote
- **Gemini Flash is opt-in only** — `apps/agent-server/src/providers/transcription/gemini.ts` ships as a third `TranscriptionProvider`, but the router at [router.ts](apps/agent-server/src/providers/transcription/router.ts) **hard-bars** Gemini from `auto` routing. Only explicit `provider: 'gemini'` invocations succeed. `GEMINI_API_KEY` presence in `.env` activates availability but does NOT switch the default. Same pattern when adding future opt-in providers — never let `isAvailable() === true` quietly change auto behavior. Audio is sent inline-base64; the ~20MB inline cap means long-form clips will need a File API upload path (deferred)
- **Chat panel pill context** — the reference-pill picker in [reference-pill-picker.tsx](src/features/agent/components/reference-pill-picker.tsx) compiles attached pills into bracket-tagged context lines (`[Clip: foo on V1 at 0:00 (item:XYZ)]` / `[Time Range: 0:12–0:18]`) prepended to the user's message by `chat-input.tsx`. The compile helper lives in a separate [reference-pill-utils.ts](src/features/agent/components/reference-pill-utils.ts) (not the picker component) so the picker module stays "components-only" — required to avoid the lint `only-export-components` Fast Refresh warning. Apply this split whenever a picker/menu component needs to export utility helpers
- **System prompt teaches "this clip" resolution order** — for clip-scoped requests the agent prioritizes: (1) bracket-tagged context lines from the pill picker, (2) `Context flags:` line in the timeline summary, (3) `Selected:` line, (4) ask. Order set in [agent.ts](apps/agent-server/src/agent.ts). If you add a new context surface, fit it into this hierarchy or document the override explicitly
- **Hyperframe — not Remotion — is the AI talking-head/avatar/lower-third renderer** — when the user asks for an AI-generated talking head, avatar clip, or lower third, the M6 tools (`add_lower_third`, `generate_avatar_clip`, etc.) call Hyperframe's API, and the rendered output drops onto FreeCut's timeline as ordinary media via the M3 placeholder→swap pattern. We do NOT pull in Remotion, even though sibling projects use it for this niche — FreeCut's GPU compositor + Hyperframe cover the same ground without a CLI render farm. Don't propose Remotion in design discussions; the rejection is settled in [PHASE-1-PLAN.md §1](docs/PHASE-1-PLAN.md) and [AI-EDITOR-VISION.md §9](docs/AI-EDITOR-VISION.md)
- **One Claude orchestrator, many tools — never sibling agents** — the user shouldn't pick which "agent" handles their request. Specialized providers (Gemini for analysis, fal for video gen, ElevenLabs for TTS, Hyperframe for avatars) are MCP **tools** the single Sonnet 4.6 orchestrator reaches for. HyperEdit's tabbed Director/Picasso/DiCaprio UI is an anti-pattern we deliberately rejected (forces the user to know which agent does what). The planning layer over those tools is the **creative director** (plan-and-execute over an existing timeline — the Phase-1 capstone, generalizing `suggest_trims`), NOT a separate agent. The §6.5.5 per-turn **intent router was DROPPED 2026-06-01** (one orchestrator makes routing moot at 16 tools — revisit only if the count explodes). Later (M7+), stable multi-tool workflows — including the whole convergence pipeline — graduate into Claude Agent SDK **skills** that hide the multi-call dance from the orchestrator (see [CONVERGENCE-ANALYSIS.md](docs/CONVERGENCE-ANALYSIS.md), [PHASE-1-PLAN.md §6.15](docs/PHASE-1-PLAN.md))
- **Tool design for future skill graduation** — when adding a new MCP tool, two constraints keep it composable into a future skill: (a) **side-effect-honest** — read-only tools must never mutate; write tools must declare what they touch. Add `sideEffects: 'read' | 'mutate'` to the tool metadata when convenient. (b) **separate read from write across the bridge** — never bundle "fetch state" and "mutate state" in one browser action. M4.1's split between `read-clip-for-regen` (read-only) and `replace-clip-with-placeholder` (mutating) is the canonical pattern. The reserved skills location is `apps/agent-server/src/skills/` (empty until M7)
- **Gemini auto-routing rule scope** — the "never auto-route to Gemini" invariant from §6.5.4 applies to **transcription only** (where local Whisper is the sane default). For **video analysis** (`analyze_clip`, M4.6+) there is no local alternative with temporal+audio+visual joint understanding, so Gemini IS the default for the analysis capability. Documented in [AI-EDITOR-VISION.md §4](docs/AI-EDITOR-VISION.md)
