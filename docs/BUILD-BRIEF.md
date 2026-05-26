<!--
This is the original build brief as written, preserved verbatim for reference.

Decisions that supersede or refine it live in:
  - docs/ARCHITECTURE.md §5 (Q1–Q12 locked decisions)
  - docs/PHASE-1-PLAN.md (concrete implementation plan)

If this file and the architecture doc disagree, the architecture doc wins.
-->

# AI Video Editor — Unified Build Brief

## What We're Building

A personal, self-hosted, AI-powered video editing tool built on top of **FreeCut** (forked). Single application, two workflows that share the same foundation:

1. **Faceless YouTube workflow** — storyboard-first creation: scene cards with prompts, start/end frame images, per-scene AI-generated video clips via fal/kie. Output flows onto the timeline.
2. **AI-powered timeline editing** — a chat agent operates on clips already on the timeline: generate B-roll at timestamp ranges, subtitles, lower thirds, replace clips with regeneration, cut silence, transcribe.

The timeline is the meeting point. Workflow 1's output is workflow 2's input. This is one app, not two.

---

## Core Architecture

```
                       ┌──────────────────────────┐
                       │   Chat Agent (LLM)       │
                       │   - High-level tools     │
                       │   - Project memory       │
                       └────────────┬─────────────┘
                                    │
                       ┌────────────▼─────────────┐
                       │   Tool Orchestrator      │
                       │   (high-level → low-level)│
                       └─┬─────┬─────┬─────┬──────┘
                         │     │     │     │
        ┌────────────────▼──┐  │  ┌──▼──────────────┐
        │ FreeCut Timeline  │  │  │ External APIs   │
        │ (existing NLE)    │  │  │ fal, kie,       │
        │                   │  │  │ ElevenLabs,     │
        └────────▲──────────┘  │  │ Whisper,        │
                 │             │  │ Hyperframe      │
                 │             │  └─────────────────┘
        ┌────────┴──────────┐  │
        │ Storyboard View   │◄─┘
        │ (new, scene cards)│
        └───────────────────┘
```

The chat agent never speaks to the timeline directly. It calls a small set of **high-level tools**. Each tool internally orchestrates the many low-level FreeCut operations needed to do the job.

---

## The Critical Design Principle: Lean Tool Surface

This is the most important architectural constraint in the project. Get this wrong and the tool gets expensive and slow.

**Wrong:** expose every FreeCut operation as an LLM tool (`move_clip`, `trim_clip`, `split_clip`, `add_track`, `set_clip_property`, etc.). Easy to implement, but every tool definition lives in the LLM's context window on every turn. Dozens of micro-tools = bloated context, slower inference, higher cost, and the agent has to reason at the wrong level of abstraction.

**Right:** expose ~10–15 **high-level workflow tools** that the agent reasons about. Each tool internally calls whatever low-level FreeCut operations it needs.

Example high-level tools:

- `generate_broll(prompt, start_time, end_time, model="auto")`
- `add_subtitles(asset_id, style)`
- `replace_clip_with_regeneration(clip_id, new_prompt, model="auto")`
- `cut_silence(clip_id, threshold_db)`
- `add_lower_third(text, style, start_time, duration)`
- `transcribe(asset_id)`
- `generate_voiceover(text, voice_id, scene_id)`

Internally these wrap dozens of FreeCut calls. The LLM never sees the internals. **No MCP unless we explicitly choose it later for a specific use case** — direct programmatic calls to the tool layer keep context lean.

---

## The Two Workflows in Detail

### Workflow 1: Faceless YouTube (Storyboard Mode)

Entry point: blank project → switch to **Storyboard view**.

Flow:
1. Paste or generate a script. Agent breaks it into scenes (scene cards).
2. Each scene card holds: prompt, VO audio, optional start/end frame images, generated video clip, model used, cost.
3. Click a card → side panel: edit prompt, pick model (Kling, Seedance 2.0, Veo, Wan, etc. via fal/kie), hit regenerate. Clip updates in place when the job returns.
4. Drag cards to reorder.
5. **"Send to timeline"** turns scene cards into clips on FreeCut's timeline in order, with VO audio on the audio track.

### Workflow 2: AI Timeline Editing

Entry point: project with clips on the timeline (from Workflow 1, or imported footage, or screen recordings — doesn't matter).

Flow:
- Chat panel on the right side of the timeline.
- Examples of what the user types:
  - *"Add B-roll of a city skyline at night between 0:12 and 0:18 using Seedance"* → `generate_broll(...)` → clip appears on the timeline when ready
  - *"Add subtitles to the whole timeline"* → `transcribe(...)` + `add_subtitles(...)`
  - *"Cut all silences over 0.5 seconds in clip 3"* → `cut_silence(...)`
  - *"Replace this clip with a more dramatic version"* (clip selected) → `replace_clip_with_regeneration(...)`
  - *"Lower third saying 'CEO, Acme Corp' from 0:42 for 4 seconds"* → `add_lower_third(...)`
- Long-running generations show progress in the chat panel and on the affected timeline slot.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Foundation | FreeCut (forked, MIT) |
| Runtime | Whatever FreeCut uses (verify in Phase 0) |
| Agent SDK | Anthropic SDK or Vercel AI SDK with tool use |
| LLM | Claude Sonnet 4.x for the agent (configurable) |
| Generative video | fal + kie (model arbitrage per call) |
| TTS | ElevenLabs API |
| Transcription | Whisper (local server or OpenAI API) |
| Motion graphics | Hyperframe API |
| Asset storage | Local filesystem for v1, S3/R2 later if needed |
| Project state | JSON file per project (start simple, migrate if needed) |
| API keys | `.env` for v1, settings UI later |

---

## Phase 0 — Reconnaissance (Don't Skip)

Before writing a single line of new code, the agent in Antigravity must understand FreeCut's existing architecture. Output of this phase is a `ARCHITECTURE.md` in the repo summarizing:

- Tech stack (framework, state management, rendering pipeline)
- Timeline data model (how are clips, tracks, transitions, effects represented?)
- How clips get added programmatically (not just through UI drag-drop)
- How async clip insertion works — what happens if a clip is inserted while a render is mid-flight?
- Where UI components live and how decoupled they are from the editor core
- What FreeCut already does that we don't need to rebuild (transitions, captions, export, etc.)
- What FreeCut does NOT do well that we might need to extend

**Don't proceed to Phase 1 until this document exists and you've read it end to end.**

---

## Phase 1 — Timeline AI Tools (Workflow 2 First)

Build the timeline-editing workflow before the storyboard. Reasons:
- Smaller scope per tool. Each tool is independently testable.
- You can test on existing footage you already have. No dependency on Workflow 1 being done.
- It forces deep understanding of FreeCut internals, which makes Phase 2 trivial.
- Ships something usable in weeks.

Build order within Phase 1:

1. **Tool orchestrator skeleton** — define the tool interface (name, schema, handler). One dummy tool that returns "hello." Test the agent can call it.
2. **Chat panel UI** — right sidebar in FreeCut. Wire to Anthropic API with tool use enabled.
3. **First real tool: `transcribe(asset_id)`** — uses Whisper, returns a transcript JSON tied to the asset. No timeline writes yet. Easiest, no async ambiguity.
4. **Second tool: `add_subtitles(asset_id, style)`** — uses the transcript, writes subtitle blocks to a subtitle track. First real timeline write.
5. **Third tool: `generate_broll(prompt, start_time, end_time, model)`** — fal call, returns clip URL, inserts on a video track at the given range. First async generation flow. Solve the progress-indicator pattern here — this pattern is reused everywhere.
6. **Fourth tool: `replace_clip_with_regeneration(clip_id, new_prompt, model)`** — uses the existing clip's metadata as context, regenerates, swaps in place.
7. **Fifth tool: `cut_silence(clip_id, threshold_db)`** — pure FFmpeg.wasm operation, no external API. Tests the local-processing tool pattern.
8. **Sixth tool: `add_lower_third(text, style, start_time, duration)`** — Hyperframe API, returns motion graphic asset, inserts on an overlay track.
9. **Seventh tool: `generate_voiceover(text, voice_id)`** — ElevenLabs API, returns audio asset.

After Phase 1, the tool has real value on its own — you can edit any project with AI assistance.

---

## Phase 2 — Storyboard View (Workflow 1)

Now you understand FreeCut's timeline well enough to build the storyboard as a layer that *produces* timeline state.

Build order:

1. **Storyboard data model** — a scene is `{ id, prompt, vo_audio_asset_id, start_frame_image_id, end_frame_image_id, video_clip_asset_id, model_used, cost }`. A project is `{ scenes: Scene[] }`.
2. **Storyboard view UI** — horizontal scrolling cards. Each card shows thumbnail + prompt + status (empty/generating/ready).
3. **Scene side panel** — edit prompt, pick model from dropdown, regenerate button.
4. **Tool: `break_script_into_scenes(script_text)`** — agent reads the script, populates scene cards with prompts.
5. **Tool: `generate_scene_clip(scene_id, model)`** — runs the full generation flow for one scene (frames → video) and updates the card.
6. **"Send to timeline"** — takes all scenes in order, inserts each video clip on the video track, VO audio on the audio track. After this point, the user is in Workflow 2 territory.
7. **View switcher** — top-bar toggle between Storyboard and Timeline view. Same project, two ways of looking at it.

---

## File / Directory Structure (Suggested)

```
/                          # FreeCut fork root
  /src
    /core                  # FreeCut's existing editor — touch carefully
    /agent                 # NEW
      /tools               # High-level tool definitions + handlers
      /llm                 # LLM provider abstraction (Anthropic, OpenAI)
      /chat-panel          # Chat UI component
    /integrations          # NEW: API wrappers
      fal.ts
      kie.ts
      elevenlabs.ts
      whisper.ts
      hyperframe.ts
    /storyboard            # NEW: scene cards view + scene-to-timeline export
    /ui                    # FreeCut's UI + view switcher + storyboard panel
    /state                 # Project state, asset library
  /docs
    ARCHITECTURE.md        # Output of Phase 0
    TOOLS.md               # Tool catalog + design rationale
    PROMPTS.md             # Agent system prompts per mode
```

---

## Discipline Rules (Read These Every Week)

1. **Build for the next video you actually need to publish.** Not abstract completeness. If a tool isn't in the path for the video on your desk this week, defer it.
2. **No MCP unless it earns its place.** Every tool starts as a direct programmatic call. Only consider MCP for a tool if there's a specific reason it can't be direct.
3. **Don't touch FreeCut's core gratuitously.** Add new code in new directories. Modify core only when necessary, and document why in commit messages.
4. **Async generation is the hardest pattern** — solve it once in `generate_broll`, then reuse the pattern. Don't re-invent it for every tool.
5. **If a tool's parameter list exceeds 5 fields, you're probably trying to make one tool do two things.** Split it.

---

## Open Questions to Answer Before Starting Phase 1

These need decisions in your first planning turn with Claude Code in Antigravity:

- **LLM provider strategy.** Anthropic API directly (clean), or via the Claude Agent SDK subprocess (lets you use your existing Max subscription, same approach as your gateway project)? Mixed?
- **Asset storage location.** Local filesystem only for v1, or set up S3/R2 from day one?
- **Project file format.** Single JSON per project (simple, git-friendly) or SQLite (better for large projects with many assets)?
- **API key management.** `.env` for v1 is fine, but where do they live on a deployed instance? Settings UI later?
- **Default model selection.** When the user doesn't specify a model in `generate_broll`, what's the default? Cost-optimized (Wan) or quality-optimized (Seedance 2.0)?
- **Browser-only or Electron wrapper?** FreeCut is web-based — do you want to ship as a desktop app eventually, or keep it browser-only?
- **Whisper hosting.** Local Whisper server (free, your hardware), or OpenAI API (pay per minute)?
- **How does the agent reason about the timeline state?** Does it get a JSON snapshot of the timeline each turn (potentially heavy), or does it call a `get_timeline_state()` tool when it needs the info?

The last question matters more than it looks — it affects every tool design. Recommend deciding it explicitly in Phase 0.

---

## First Prompt to Claude Code in Antigravity

> I have a build brief for an AI-powered video editor built on a FreeCut fork. Two workflows: storyboard-first faceless YouTube creation, and AI-powered timeline editing via chat agent. I want to start with Phase 0 — reconnaissance of the FreeCut codebase. Read through the repo and produce `docs/ARCHITECTURE.md` answering the questions in the Phase 0 section of the brief. Don't write any new feature code yet. Brief is attached.

Then paste this brief as context.
