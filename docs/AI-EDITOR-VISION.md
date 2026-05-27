# FreeCut AI Editor — Target Architecture

The north star for the AI-assisted editing surface. Updated 2026-05-26
after a deep-dive on the sibling HyperEdit codebase
(`/Users/joelm/Documents/Antigravity/hyperedit`) — a working Cloudflare
Worker + Node FFmpeg AI editor that has many of the workflows we want.
The detailed capability-by-capability inventory of HyperEdit (with
file paths + line numbers + verified findings) lives at
[HYPEREDIT-INVENTORY.md](HYPEREDIT-INVENTORY.md) — read that first if
you need to cite specifics. This doc is the synthesis.

This doc is what we converge toward. The detailed milestones live in
[PHASE-1-PLAN.md](PHASE-1-PLAN.md); this doc is the *destination* so
plan work doesn't drift.

---

## 1. The product feel we want

The user opens the editor, drops a clip on the timeline, opens chat,
types **"add some b-roll that matches the vibe"** — and gets it.

Not:
- "Add a b-roll of a city skyline looking out from a top-floor window
  with a slow drift from second 12 to second 18 in 16:9"
- Choosing between 3 different agent tabs ("Director", "Picasso",
  "DiCaprio") and remembering which does what
- Writing ffmpeg-shaped prompts

The agent is a *subject-matter expert at video editing* who knows the
toolbox. The user describes intent in natural language; the agent
breaks it down, calls analysis tools to fill in the gaps, then
composes generation + editing tools to land the result.

---

## 2. Architecture — one agent, many tools

**Reject:** HyperEdit's 3-sibling-agents-in-tabs pattern. The user
shouldn't pick which "agent" handles their request — that's our
problem.

**Adopt:** single Claude Sonnet 4.6 orchestrator with all tools
available, system prompt teaching it which tool for which job.
Specialized capabilities (Gemini for video analysis, fal for video
gen, etc.) become **MCP tools** the orchestrator calls — not
co-agents the user has to route to.

```
                       ┌────────────────────┐
                       │ Chat input         │
                       │ (chips + pills)    │
                       └──────────┬─────────┘
                                  │
                       ┌──────────▼─────────┐
                       │ Claude Sonnet 4.6  │   single agent
                       │ (Agent SDK)        │
                       └──────────┬─────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
   ANALYSIS tools          GENERATION tools           EDITING tools
   (read the project)      (make new assets)          (mutate timeline)
        │                         │                         │
   - analyze_clip          - generate_broll          - cut_silence
   - read_transcript_…     - generate_image          - replace_clip_with_
   - detect_chapters       - animate_image             regeneration
   - find_moment           - generate_voiceover      - karaoke_captions
   - identify_broll_gaps   - add_gif                 - smart_trim
   - describe_timeline     - add_motion_graphic      - chapter_marks
                           - restyle_clip            - add_subtitles
                                                     - transcribe
```

Provider abstraction stays per-capability (transcription / video gen /
TTS / **analysis**) so the *backend* of each tool is swappable
(`fal` → `kie`, `kokoro` → `elevenlabs`, `gemini-flash` → future
`gemini-pro`) without touching the tool surface.

---

## 3. Capability matrix — what HyperEdit has, what we want, where we are

Green = already shipped in FreeCut. Yellow = next-up. Red = deferred
to Phase 2 or blocked. ⛔ = explicitly rejected (do not port).

| HyperEdit capability | FreeCut status | Target | Notes |
|---|---|---|---|
| Single orchestrator agent (Claude) | 🟢 shipped (M0–M3) | keep | Already where we want it |
| Transcription (Whisper local / OpenAI / Gemini) | 🟢 shipped (M1, M4.5) | keep | Three-tier fallback identical to HyperEdit; we hard-bar Gemini from `auto` |
| Caption-track insert | 🟢 shipped (M2) | keep | |
| Text-to-video b-roll (fal Kling) | 🟢 shipped (M3) | keep | Same provider HyperEdit uses for `animate` |
| Replace-clip-with-regeneration | 🟢 shipped (M4.1) | keep | We chose placeholder→swap (better undo); HyperEdit does in-place overwrite |
| `prompt_modifier` for additive tweaks | 🟢 shipped (M4 bug fix) | keep | HyperEdit has no equivalent |
| RMS silence removal | 🟢 shipped (M4.2) | **upgrade to hybrid** | Add Whisper-word-boundary clipping (see §5) |
| Transcript-grounded prompts | 🟢 shipped (M4.3) | **upgrade to also use visual context** | Today: transcript only. Next: Gemini frame analysis |
| Chat UX (chips + pills + flags) | 🟢 shipped (M4.4) | keep | HyperEdit's chat is plainer |
| Gemini Flash transcription | 🟢 shipped (M4.5) | keep | Opt-in only |
| Gemini frame+audio video analysis | 🔴 missing | **M4.6** | The §6.5.4 `AnalysisProvider` slot has a real consumer now |
| Image generation (fal `gpt-image-2`) | 🔴 missing | **M4.7** | Still-image b-roll path |
| Image-to-video animation (fal Kling image→video) | 🔴 missing | **M4.7** | Better motion control than pure text-to-video |
| GIF search + insert (Giphy) | 🔴 missing | M4.8 | Cheap; Giphy is free for dev |
| TTS / voiceover (Kokoro + ElevenLabs) | 🔴 missing | **M5** | Already in plan |
| Karaoke-style captions (per-word highlight) | 🔴 missing | **M5.1** | HyperEdit does this with pure CSS color transitions; trivial to port |
| Smart trim suggestions ("this clip is too long") | 🔴 missing | M6 | Needs visual + transcript reasoning |
| Chapter detection | 🔴 missing | M6 | Gemini does this well; HyperEdit has it |
| Find-the-moment ("when does X happen") | 🔴 missing | M6 | Gemini single-call |
| Motion-graphics templates (lower thirds, charts, etc.) | 🟡 partial (FreeCut shapes/text/keyframes) | M6+ | Build prefab compositions from FreeCut primitives, not Remotion |
| Concept-card approval flow | 🔴 missing | **M5+** | Spend-confirmation card before expensive renders |
| `Scene[]` discriminated union schema | 🔴 missing | **Phase 2** | The storyboard workflow's universal output shape |
| Storyboard / scene-list UI | 🔴 missing | Phase 2 | Workflow 2 (chat) ships first; storyboard is Workflow 1 |
| Talking head / avatar generation | 🔴 missing | M6 (Hyperframe) | Blocked on Hyperframe API docs |
| Music generation | 🔴 missing | not planned | Out of scope for v1 |
| Restyle clip (fal ltx2) | 🔴 missing | M6+ | Niche; defer |
| Remove background (fal bria) | 🔴 missing | M6+ | Niche; defer |
| LLM-generated FFmpeg command strings | ⛔ never | — | RCE surface; HyperEdit has it; we explicitly reject it |
| 3-sibling-agents-in-tabs UI | ⛔ never | — | UX anti-pattern; one agent with all tools instead |
| Remotion as the renderer | ⛔ never | — | FreeCut's WebGPU compositor + keyframes do everything Remotion does on-timeline |
| Cloudflare Worker backend | ⛔ never | — | We're a local dev tool; agent server on localhost is the right shape |

---

## 4. The "match the vibe" workflow (M4.6) — concrete sketch

This is the workflow that *defines* the AI editor for me. User says
"add b-roll that matches what's playing here", agent does the rest.

**User input:** `"add some b-roll between 0:10 and 0:18 that fits the vibe"`

**Agent flow:**

1. Reads timeline summary → sees clip `intro.mp4 (item:abc)` covering
   0:10–0:18.
2. Calls **`analyze_clip(clip_id: 'item:abc', focus: 'all')`** — new
   tool added in M4.6.
   - Browser action `read-clip-video-bytes(clip_id_or_range)` returns
     base64 of a downsampled sub-clip (target: <15MB to fit Gemini
     inline cap).
   - Server provider `GeminiVideoAnalysisProvider.describeClip()` calls
     `gemini-3.5-flash` with the video bytes + a structured-JSON
     response schema asking for: `visualDescription`, `mood`,
     `lighting`, `cameraMovement`, `colorPalette`, `subject`,
     `audioSummary`, `pace`, `suggestedBrollPrompts[]`.
3. Agent constructs a generation prompt by combining the analysis +
   user intent. Example:
   ```
   Warm late-afternoon golden hour, slow handheld push-in, person at
   window of high-rise looking out at cityscape, contemplative mood,
   muted earth tones, ambient piano underscore. B-roll should match
   this lighting and pace.
   ```
4. Calls **`generate_broll`** with that rich prompt (no change to the
   existing tool).
5. Result: a fal-rendered clip that visually MATCHES instead of
   visually contradicts.

**Why this is huge:** transcript grounding tells us what's being
*said*. Visual grounding tells us what's being *shown*. Most b-roll
mishaps (the Roman-soldier-from-city-skyline bug) happen because the
model has no idea what the surrounding footage looks like.

**Decision:** Gemini is the de-facto default for the
`VideoAnalysisProvider` capability — no local alternative does
temporal + audio + visual joint understanding. The §6.5.4 "never
auto-route to Gemini" rule applies to **transcription only**.
Analysis is Gemini-by-default because there's nothing else.

---

## 5. Hybrid silence detection (M4.2 upgrade)

HyperEdit's `handleRemoveDeadAir` (line 779 of their
`local-ffmpeg-server.js`) does something clever we should port:

1. Run audio-energy silence detection (`silencedetect` / RMS) → list
   of candidate silent ranges.
2. Look up the Whisper word boundaries that intersect each candidate.
3. **Clip the range borders to the nearest word boundary** so we don't
   amputate the trailing sibilant of "yes" or the leading consonant of
   "now". Pure RMS cuts at energy threshold; Whisper knows where words
   *actually* end.

Effort: small. We already cache word timings in `transcript.json`.
The change is in `removeSilenceFromItems` / `analyzeSilenceForItems`
to snap range edges to nearby word boundaries.

Result: smoother cuts, fewer "wait, my words got chopped" complaints.

---

## 6. Karaoke captions (M5.1)

Single most-loved HyperEdit feature, surprisingly simple
implementation:

```ts
// CaptionRenderer.tsx, lines 84-91:
case 'karaoke':
  return {
    color: isActive ? style.highlightColor || '#FFD700' : style.color,
    transition: 'color 0.1s ease'
  }
```

No per-word keyframes. No FFmpeg drawtext. Just a CSS color transition
driven by `currentTime` vs each word's `[start, end]` from the Whisper
word-level timestamps we already store.

For FreeCut: extend `SubtitleSegmentItem` to optionally render in
"karaoke" mode. The renderer reads `cue.words[]` (we already have
word-level data from Whisper) and applies the active-word color to
the word covering the playhead frame.

Trivial change. Massive perceived-polish gain.

---

## 7. Image-then-animate b-roll path (M4.7)

HyperEdit generates *still images* for b-roll, not videos. Same fal
account, different model:

- `fal-ai/openai/gpt-image-2` for still generation (~$0.02/image)
- `fal-ai/kling-video/v1.5/pro/image-to-video` for animation
  (~$0.40/clip, much cheaper than text-to-video and you keep visual
  control)

**Why we want both paths:**

- **Text-to-video** (current `generate_broll`): fast, one call, but
  the model picks the composition; less consistency across multiple
  clips.
- **Image-then-animate** (new): generate the still first → preview →
  user can regenerate the still cheaply → only animate the approved
  still → animations preserve the still's framing/lighting/subject.

This is also the natural way to ship a **concept-card approval flow**:
the still IS the concept card. User sees it, says "yes animate this"
or "no, regenerate the still with these tweaks."

---

## 8. Concept-card approval (M5+)

HyperEdit's `analyze-for-animation` → user-approves → `render-from-
concept` endpoint pair. The concept JSON travels through the user's
hands before any expensive compute runs.

We should adopt this for any generation step that costs more than ~$0.50
or takes more than ~30s. Specifically:

- Image-then-animate (M4.7) — the still IS the card
- Hyperframe avatar / talking-head (M6) — show a script preview +
  voice sample before render
- Phase 2 storyboard scenes — each scene card IS a concept card

The protocol: tools that emit cards return a `pending-confirmation`
object instead of executing. Chat panel renders Approve / Reject /
Edit buttons. The follow-up action calls the actual render.

---

## 9. Patterns we EXPLICITLY reject (audit trail)

- **LLM-generated FFmpeg command strings.** HyperEdit's Director path
  asks Gemini to emit `{"command": "ffmpeg -i ..."}` and shell-execs
  it. The "input.mp4/output.mp4 hardcoded" filename pattern is their
  only sandbox. RCE surface. We use scene schemas + deterministic
  compilation (FreeCut's GPU compositor + timeline actions) so the LLM
  never writes shell.

- **Sibling agents in tabs.** Forces the user to know which agent
  does what. Replace with a single agent + system prompt.

- **Remotion as a rendering layer.** FreeCut's text + shapes +
  transitions + masks + keyframes already render everything we need
  on-timeline, without a CLI farm. **For the workflow Remotion would
  otherwise own — AI-generated talking-head / avatar / lower-third
  content — Hyperframe is the path** (M6, blocked on API docs).
  Hyperframe tools will reuse the M3 placeholder→swap pattern and
  the M4.6 analysis surface; the rendered output drops onto FreeCut's
  timeline as ordinary media, no separate render farm involved.

- **Cloudflare Worker as backend.** We're a local-first dev tool;
  the agent-server-on-localhost shape is right.

- **Two parallel session systems** (HyperEdit explicitly calls these
  out as legacy). FreeCut has a single source-of-truth timeline.

---

## 10. Sequencing — what to build next

In strict priority order, given today's M4-done state:

1. **Verify and commit M4** ([M4-VERIFICATION.md](M4-VERIFICATION.md))
2. **M4.6 — Gemini visual analysis + `analyze_clip` tool + system
   prompt update** so "match the vibe" works
3. **M4.2 hybrid upgrade** — snap silence boundaries to Whisper words
   (cheap polish)
4. **M4.7 — Image-then-animate b-roll** (fal `gpt-image-2` +
   `kling-image-to-video`); brings concept-card approval naturally
5. **M5 — Voiceover generation** (Kokoro + ElevenLabs) as originally
   planned
6. **M5.1 — Karaoke captions** (cheap, high-polish)
7. **M6 — Smart trim / chapter detection / find-the-moment** — once
   we have a stable analysis surface to compose against
8. **Phase 2 — Storyboard workflow** with the `Scene[]` schema

Each step composes onto the previous one without rewriting earlier
work. The goal at every step is the same: the user types intent in
natural language; the agent figures out the rest.

---

## 11. The honest gap

What HyperEdit has that we *don't yet*, and how much it matters:

| Gap | User-visible impact | Effort to close |
|---|---|---|
| Visual analysis (Gemini frames) | "Match the vibe" doesn't work without it | M4.6, ~1 day |
| Image-then-animate path | All b-roll has to be one-shot text-to-video | M4.7, ~2 days |
| Karaoke captions | Captions look generic | M5.1, ~0.5 day |
| Hybrid silence detection | Cuts occasionally clip word edges | upgrade, ~0.5 day |
| Chapter detection | No automatic structure | M6, ~1 day |
| Find-the-moment | Can't navigate by content | M6, ~1 day |
| Concept-card approval | Expensive renders run without preview | M5+, ~1 day |
| Storyboard view | No "AI proposes 8 scenes" workflow | Phase 2 |
| GIF search | No quick reaction-GIF inserts | M4.8, ~0.5 day |
| Motion graphic templates | Lower thirds are manual | M6, ~3 days |

Total to feature-parity on the workflows that matter: roughly 3 weeks
of focused work. The path is well-defined and each piece composes.

---

## 12. Managing tool-surface growth — keeping the agent sharp

Legitimate concern: "one agent with many tools" gets brittle past ~10
tools. Tool descriptions blur together, the agent picks wrong tools,
the system prompt balloons. We mitigate in four layers, in order of
how soon we apply them:

**12.1 — Tool descriptions answer "when to use", not "what it does".**
Already applied across M4. Every tool's Zod `.describe()` block tells
the agent *the kind of user request that should trigger this tool*,
plus what NOT to use it for. Example from `replace_clip_with_regeneration`:
`prompt_modifier` is described as "Use this whenever the user asks to
MODIFY an existing AI-generated clip — phrases like 'make it more
cinematic'... Do NOT use new_prompt for stylistic tweaks." That kind
of negative-example phrasing is what keeps the agent from drifting
toward the wrong tool.

**12.2 — System-prompt decision tree.** When the tool count crosses
~8, the system prompt grows a short, numbered decision tree at the
top — "if the user said X, route to tool Y; if ambiguous, ask before
acting." We're at 5 tools today; this becomes worthwhile around M5+.

**12.3 — Intent router (§6.5.5 in PHASE-1-PLAN.md, deferred from
M4).** A cheap pre-flight (keyword match + Haiku-class LLM fallback,
similar to HyperEdit's `intent-classifier.js`) that restricts the
tool set the main agent sees per turn based on the user's prompt. The
agent never "sees" `generate_voiceover` when the user is asking about
b-roll; tool selection accuracy goes up, prompt cost goes down. We
build this at the ~10-tool mark (likely between M5 and M6).

**12.4 — Skills as workflow capsules (§13).** Once a multi-tool
workflow is stable, package it as a skill that exposes ONE entry
point. The agent stops seeing the 3-tool dance; it sees one tool
called `add_matching_broll` that internally does
`analyze_clip → construct prompt → generate_broll`. This collapses
cognitive load on the agent dramatically. Details below.

The order matters: 12.1 is free and always-on, 12.2 is cheap when
needed, 12.3 is a real piece of infrastructure but well-defined, 12.4
is the long-term architecture. Each layer composes on the previous.

---

## 13. Skills as a graduation path (post-M6)

**Concept:** today's tool surface is *primitives* — `analyze_clip`,
`generate_broll`, `read_transcript_context_for_range`, etc. As
workflows stabilize, we'll have repeating multi-tool dances:

- "Match the vibe" = `analyze_clip` → compose prompt → `generate_broll`
- "Full caption pass" = `transcribe` → `add_subtitles` →
  `karaoke_captions` (M5.1)
- "Smart cut" = `transcribe` → `analyze_clip` → propose trims → apply

Each one will get re-orchestrated by the agent on every invocation
until we package it. The packaging unit is a **Skill** —
Claude-Code-style skills are a great fit because the Claude Agent SDK
(the same SDK powering our agent-server) already supports skill
registration.

**Tool vs Skill distinction:**

| Aspect | Tool | Skill |
|---|---|---|
| Granularity | Primitive operation | Multi-step workflow |
| Examples today | `transcribe`, `generate_broll` | (none yet) |
| Examples future | `analyze_clip`, `add_gif` | `match_vibe_broll`, `full_edit_pass`, `talking_head_intro` |
| Implementation | TS function + Zod schema, lives in `tools/` | Markdown file + orchestration script, lives in `skills/` |
| When to invoke | Atomic operation needed | Repeating workflow recognized |
| Agent perspective | "I have 20 buttons" | "I have 8 buttons" (skills hide the primitives they compose) |

**Graduation criteria — when a workflow becomes a skill:**

1. The agent has called the same multi-tool sequence ≥3 times across
   real sessions.
2. The composition is *deterministic* given the inputs (no creative
   decisions hidden in the choreography).
3. The skill can be described to a non-technical user in one sentence.

When all three hold, we write the skill, the agent's system prompt
moves from "call analyze_clip then generate_broll" to "for 'match the
vibe' requests, use the `match_vibe_broll` skill", and the prompt
shrinks.

**Architecture impact today:** none direct, but two constraints worth
keeping:

- Tools must be **side-effect-honest**. A skill that composes
  `analyze_clip + generate_broll` needs to know analyze_clip is
  read-only and generate_broll mutates the timeline. Today this is
  implicit; we should add a small `sideEffects: 'read' | 'mutate'`
  annotation to each tool definition. Cheap to add now, painful to
  retrofit.
- Tools must be **composable in the same turn**. The
  `replace-clip-with-placeholder` handler is mutating; we deliberately
  separated it from the read-only `read-clip-for-regen` so the server
  could validate before mutating. That separation is what lets a
  future skill compose them safely. Keep this pattern: separate read
  from write across the bridge.

**Reserved location:** `apps/agent-server/src/skills/` for future
skill modules. Empty for now. The Claude Agent SDK loads them
via the same MCP machinery as tools, so registration is the same
shape.

We don't build skills until M6 at earliest. But the architecture
takes them into account so the M4.6, M4.7, M5 tools we ship next are
each composable into skills later without rework.

---

## 14. What FreeCut has that HyperEdit doesn't

For balance — we are not behind on everything. Things HyperEdit can't
do that we already can:

- Real multi-track timeline with track groups, sync locks, ripple edits
- GPU-accelerated effects pipeline (color wheels, curves, halftone,
  pixelate, chromatic, etc.)
- GPU transitions (13 of them) with proper alpha blending
- Keyframe animation with Bezier editing
- Pre-compositions (1-level nesting)
- Project bundle export/import (portable projects)
- Workspace-folder storage (no SaaS lock-in)
- Per-frame WebGPU rendering with sub-millisecond DOM-video zero-copy
- Proper undo/redo via Zundo across every editing operation
- Reverse-conform playback
- Subtitle cue partitioning on clip splits
- Embedded waveform displays
- Linked items + group editing

We don't need to port any of that; we need to expose it *through* the
agent. The AI editor's value-add isn't a new editor — it's the agent
that knows how to drive ours.
