# HyperEdit Capability Inventory

Reference document — what the sibling project at
`/Users/joelm/Documents/Antigravity/hyperedit` actually does today.
Produced by a Gemini-powered codebase pass on 2026-05-26 and verified
against the source files. Used to drive
[AI-EDITOR-VISION.md](AI-EDITOR-VISION.md) — when designing future
FreeCut tools, check here first to see if HyperEdit has a tested
pattern worth porting (or worth avoiding).

The summary is grouped by the 15 capabilities asked of the gemini-agent.
Bullet-grade so you can scan; cite the source file when you need the
real implementation.

---

## 1. Agent architecture — *three sibling agents in tabs, no
director-with-subagents pattern*

- Three named agents in a tabbed UI: **Director**, **Picasso**,
  **DiCaprio**. They do not call each other; coordination is purely
  UI-routing — the user picks which tab they're talking to.
- Key files:
  - `src/react-app/pages/Home.tsx` — three tabs
  - `src/react-app/components/AIPromptPanel.tsx` — Director intent
    router (~3000 lines)
  - `scripts/providers/config.js` lines 24-66 — task→provider mapping
  - `scripts/providers/llm.js` lines 125-209 — `callClaude` via
    `claude -p` subprocess (Claude Code subscription auth, no API
    key); `callGemini` via `@google/genai` SDK
- Task→model assignment: `code-gen` → Claude Sonnet, `intent-classify`
  → Claude Haiku, `video-analysis` + `creative-write` →
  `gemini-3.5-flash`.
- **Pattern WE PORTED:** Claude via subprocess for subscription auth.
- **Pattern WE REJECTED:** three sibling agents in tabs — forces the
  user to know which agent handles what. We use one orchestrator with
  all tools.

## 2. Video analysis — *transcript-only; visual frame analysis is a
documented Phase 4 plan, not built*

- Reality: `handleAnalyzeForAnimation`
  (`scripts/local-ffmpeg-server.js` line 6478) sends the transcript +
  user query to `gemini-3.5-flash`. **No frame bytes are ever sent to
  a model.** The "video analysis" label is misleading.
- Returns structured concept JSON:
  `{ scenes, backgroundColor, totalDuration, contentSummary, keyTopics }`.
- Prompt skeleton: `You are a motion graphics designer. Analyze this
  video transcript and create a contextual ${type} animation concept.
  ... Return ONLY valid JSON ...`.
- **OUR M4.6 PATH GOES FURTHER:** we'll send actual video bytes
  (inline base64) to Gemini and ask for visual+audio+temporal analysis
  — exactly what HyperEdit lists as "Phase 4" but hasn't implemented.

## 3. B-roll image generation — *image-first, no animation step on the
b-roll path (still overlays only)*

- `handleGenerateBroll` in `scripts/local-ffmpeg-server.js`.
- Provider: `fal-ai/openai/gpt-image-2` (upgraded 2026-05-25 from
  `fal-nano-banana-pro`; previous Google
  `gemini-2.0-flash-exp-image-generation` retired).
- Flow: transcribe → Gemini picks b-roll opportunities (timestamps +
  prompts) → generate one still per opportunity → composite onto the
  timeline as **image overlays** (no animation).
- DiCaprio panel has a separate `animate` skill (image→video via
  `fal-ai/kling-video/v1.5/pro/image-to-video`), but it's user-
  initiated, NOT part of automated b-roll generation.
- **WORTH PORTING:** the image-then-animate pipeline. M4.7 will do
  it but actually wire it into b-roll generation (image as concept
  card → animate on approval).

## 4. GIF API — *GIPHY only, no Tenor*

- `searchGiphy`, `handleGiphyAdd`, `downloadGifAsAsset` in
  `scripts/local-ffmpeg-server.js`; UI at
  `src/react-app/components/GifSearchPanel.tsx`.
- Pattern: server proxies `api.giphy.com/v1/gifs/search` → user picks
  → downloads to session asset library → draggable.
- Also surfaces as scene type `'gif'` in the Remotion
  DynamicAnimation schema.
- **WORTH PORTING:** simple proxy + drop-on-timeline pattern. M4.8
  does this.

## 5. Motion graphics — *comprehensive but partly orphaned (Remotion
templates exist; FFmpeg drawtext fallback is wired)*

- Template registry: `src/remotion/templates/index.ts`
  `MOTION_TEMPLATES` — 11 templates (`AnimatedText`, `LowerThird`,
  `DataChart`, `LogoReveal`, `ProgressBar`, `ScreenFrame`,
  `Comparison`, `Counter`, `SocialProof`, `CallToAction`, `ZoomPan`).
- Scene discriminated union: `src/remotion/DynamicAnimation.tsx` line
  80 — 15 types.
- 3D scenes: `src/remotion/components/Scene3D.tsx` —
  react-three-fiber.
- `PLAN.md` admits `MotionGraphicsPanel.tsx` is dead code,
  `handleRenderMotionGraphic` falls back to FFmpeg `drawtext`
  instead of Remotion.
- **WE REJECT REMOTION** — FreeCut's GPU compositor + text + shapes
  + keyframes do everything Remotion does, on-timeline, without a
  render farm. M6 builds prefab compositions from FreeCut primitives.

## 6. Karaoke captions — *fully working, dirt-simple implementation*

- Word timings ingested by `getOrTranscribeVideo`
  (`scripts/local-ffmpeg-server.js` line 2905) via local Whisper or
  OpenAI Whisper.
- Stored as `CaptionWord[]` in `useProject.ts` line 55 (each has
  `start`, `end` in seconds).
- Rendered at `CaptionRenderer.tsx` lines 84-91:
  ```ts
  case 'karaoke':
    return {
      color: isActive ? style.highlightColor || '#FFD700' : style.color,
      transition: 'color 0.1s ease'
    };
  ```
- Active word index derived in a `useMemo` comparing `currentTime`
  against each word's `[start, end]`.
- **PORT VERBATIM** in M5.1 — no per-word keyframes, just CSS color
  transition driven by playback time. Cheap to render, trivial to
  copy.

## 7. Scene schema — *one discriminated union, 15 types*

Defined at `src/remotion/DynamicAnimation.tsx` line 80. Common fields:
`id: string`, `duration: number` (frames), `content: object`
(variant-specific). The 15 types:

| Type | Content |
|---|---|
| `title` | title, subtitle |
| `steps` | items[] (numbered) |
| `features` | items[] (icon + label + description) |
| `stats` | stats[] (animated counters) |
| `text` | animated text block |
| `transition` | between-scene effect |
| `media` | mediaAssetId (asset library ref) |
| `chart` | chartType, chartData (chart.js) |
| `countdown` | target/duration |
| `comparison` | left/right pair |
| `shapes` | animated primitives |
| `emoji` | `@remotion/animated-emoji` |
| `gif` | gif URL / asset ref |
| `lottie` | lottie JSON |
| `3d` | react-three-fiber scene |

- **PORT THE SCHEMA, NOT THE RENDERER.** Phase 2's storyboard workflow
  uses this discriminated-union shape for `Project.storyboard`. We
  render via FreeCut primitives, not Remotion.

## 8. Concept-card approval flow — *explicit two-step pattern*

- Endpoint pair (`scripts/local-ffmpeg-server.js`):
  - `POST /session/:id/analyze-for-animation` →
    `handleAnalyzeForAnimation` (line 6478): returns concept JSON,
    no render
  - `POST /session/:id/render-from-concept` →
    `handleRenderFromConcept` (line 6815): accepts concept, renders
- Client side: `AIPromptPanel.tsx` `handleContextualAnimationWorkflow`
  stores the concept in `pendingAnimationConcept` state, shows
  "Approve & Render" / "Cancel" buttons in the chat bubble.
- **WORTH PORTING for expensive renders.** M5.2 adds this for
  `animate_image` (the still IS the card) and for future Hyperframe
  avatar / talking-head tools.

## 9. Edit-existing-clip flow — *in-place modification (opposite of our
placeholder→swap)*

- `handleEditAnimation` in `scripts/local-ffmpeg-server.js` line 5077.
- Reuses the same `assetId`, writes `outputPath = originalAsset.path`,
  updates metadata on the existing asset. Response explicitly notes:
  `"assetId": assetId, // Same asset ID - no new asset created`.
- Documented rationale in `CHANGES.md`: "prevents asset creep".
- **WE REJECTED THIS.** Our M4.1 `replace_clip_with_regeneration`
  uses placeholder→swap because it keeps undo semantics consistent
  with M3 and avoids cache-invalidation surface area on
  `sourceFps`/`sourceDuration`/waveform caches. Tradeoff: their
  approach avoids asset library bloat; ours allows "revert to
  original" without separate versioning.

## 10. Transcription — *three-tier fallback, word-level timestamps
preserved end-to-end*

- `getOrTranscribeVideo` orchestrator at
  `scripts/local-ffmpeg-server.js` line 2905.
- Priority: local Whisper (`scripts/whisper-transcribe.py`) → OpenAI
  Whisper API → Gemini fallback (timestamps less reliable, noted in
  logs).
- Result `{ text, words }` cached on `session.transcriptCache`.
- Used in two places: caption rendering (karaoke per-word) and as
  prompt context for `handleGenerateAnimation` /
  `handleGenerateBroll`.
- **WE ALREADY DO THE SAME THREE-TIER**, with the addition that we
  hard-bar Gemini from `auto` routing (M4.5 invariant; HyperEdit
  doesn't).

## 11. TTS / voiceover — *absent (zero hits across the repo)*

- No providers, no endpoints, no UI. Confirmed by grep across `tts`,
  `voiceover`, `text-to-speech`, `elevenlabs`, `playht`.
- **M5 is greenfield for us** — Kokoro + ElevenLabs both new.

## 12. Multi-agent coordination — *none; agents are siblings sharing
the `useProject` hook via props*

- They never invoke each other directly. No shared context object
  passed between agents.
- `PLAN.md` admits "multi-agent orchestration" was deferred in favor
  of a Phase 4 "video editor brain" (single Claude tool-use loop,
  not implemented).
- **OUR ARCHITECTURE CHOSE WHAT THEIR PLAN.MD FORESAW:** single
  Claude orchestrator with all tools.

## 13. Rendering pipeline — *RCE-shaped Director path; safer
deterministic compilation elsewhere*

Three paths, only two of them safe:

- **AI-edit (Director, RCE-shaped):** Gemini emits FFmpeg command
  strings, server executes. Worker prompt at
  `src/worker/index.ts` `FFMPEG_SYSTEM_PROMPT`: model returns
  `{"command": "ffmpeg ...", "explanation": "..."}`. Input/output
  filenames hardcoded to `input.mp4` / `output.mp4` — the only
  sandbox. **THIS IS THE EXACT RCE WE EXPLICITLY REJECTED.**
- **Timeline render (safe):** `handleProjectRender` at line 2059.
  Builds a `filter_complex` chain from project data programmatically.
- **Motion graphics (safe):** Remotion renders deterministically
  from Scene schemas via `scripts/render/remotion.js`.

## 14. Storyboard / scene-list UI — *partial — list-format inside
chat panel, not a dedicated storyboard view*

- `AIPromptPanel.tsx` `handleContextualAnimationWorkflow` formats the
  concept JSON scene list as markdown inside an assistant chat
  bubble (lines ~1361-1399) with Approve / Cancel.
- No grid/card storyboard view; no per-scene thumbnails before
  render.
- **PHASE 2 WORK FOR US** — build a proper card grid UI on top of
  the Scene[] schema we adopt from §7.

## 15. Other surprises and capabilities

- **Chapter detection (yes):** `handleSessionChapters` line 1343.
  Gemini segments the transcript into chapters with timestamps.
- **Smart silence / dead-air removal (yes, clever):**
  `handleRemoveDeadAir` line 779. Hybrid algorithm:
  `silencedetect` (audio-energy truth) + Whisper word boundaries
  (clip silence borders so trailing sibilants / leading consonants
  aren't cut). Source comment at line 503: "silencedetect proposes
  silences, Whisper word boundaries clip". **THIS IS THE M4.2-bis
  UPGRADE WE'RE PORTING.**
- **Prompt rewriting (yes):** `PicassoPanel.tsx` and
  `DiCaprioPanel.tsx` both run user prompts through Gemini for
  enhancement before image/video generation. Endpoints around
  `local-ffmpeg-server.js` lines 5212 / 5418.
- **AI audio cleanup (yes, via RCE path):** Director can generate
  denoise/normalize FFmpeg commands. Not a first-class feature.
- **DiCaprio's three skills:** `animate`
  (`fal-ai/kling-video/v1.5/pro/image-to-video`), `restyle`
  (`fal-ltx2`), `remove-bg` (`fal-bria`).
- **Music generation:** no.
- **Talking head / avatar:** no.
- **"This clip is too long" trim suggestions:** no.
- **Summarization (indirect):** `analyze-for-animation` response
  includes `contentSummary` field + `keyTopics` array.
- **B-roll-without-time-range (yes):** `handleGenerateBroll`
  operates on the whole transcript; LLM picks where to insert.
- **Auto style matching across multiple generated clips:** no.

---

## Patterns we're porting (cross-references)

| HyperEdit pattern | FreeCut milestone | File ref to port from |
|---|---|---|
| Karaoke CSS color-transition captions | M5.1 | `CaptionRenderer.tsx` lines 84-91 |
| Hybrid silence (silencedetect + Whisper word boundaries) | M4.2-bis | `local-ffmpeg-server.js` line 779 |
| Image-then-animate b-roll | M4.7 | DiCaprio panel + `fal-ai/kling-video/v1.5/pro/image-to-video` |
| GIPHY proxy + drag-to-timeline | M4.8 | `searchGiphy` / `GifSearchPanel.tsx` |
| Concept-card approval flow | M5.2 | `analyze-for-animation` + `render-from-concept` endpoint pair |
| `Scene[]` discriminated union | Phase 2 | `DynamicAnimation.tsx` line 80 |
| Chapter detection via Gemini | M6 | `handleSessionChapters` line 1343 |
| Hybrid keyword + LLM intent router | §6.5.5 (post-M5.1) | `scripts/intent-classifier.js` |
| Claude via `claude -p` subprocess for subscription auth | already shipped (M0) | `scripts/providers/llm.js` lines 125-209 |

## Patterns we're explicitly rejecting

| HyperEdit pattern | Why rejected | FreeCut alternative |
|---|---|---|
| LLM-generated FFmpeg command strings | RCE surface | Scene schema + deterministic compilation |
| Three sibling agents in tabs | Forces user to know which agent does what | One Claude orchestrator with all tools |
| Remotion as renderer | We have GPU compositor + keyframes | FreeCut primitives + Hyperframe (M6, AI talking-head only) |
| Cloudflare Worker backend | Local-first dev tool | Agent server on localhost (M0) |
| In-place asset edit | Loses revert-to-original | Placeholder→swap (M3, M4.1) |
| Two parallel session systems (their `useProject` + `useVideoSession`) | Their own PLAN.md flags this as legacy | Single timeline source of truth |

## When to revisit this doc

- Before designing any new AI editor tool — check if HyperEdit
  already solved the problem (or shows what NOT to do).
- When the user references "the other codebase" — this is the
  inventory they're remembering.
- When `ARCHITECTURE.md` or `AI-EDITOR-VISION.md` references
  HyperEdit patterns — the file paths and line numbers cited here
  are the source of truth, not the summaries.
