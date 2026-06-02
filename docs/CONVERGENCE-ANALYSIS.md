# Convergence Pipeline — Feasibility & Architecture Analysis

> **Status: analysis + settled direction (2026-06-01).** This is the worked-out
> conclusion of pressure-testing the user's "convergence pipeline" north-star
> (one end-to-end script→export faceless-video flow). It is the canonical detail
> behind the shorter pointers in [AI-EDITOR-VISION.md §15](AI-EDITOR-VISION.md),
> [PHASE-1-PLAN.md §6.15–§6.16](PHASE-1-PLAN.md), and [ARCHITECTURE.md §5 Q5/Q13](ARCHITECTURE.md).
> Memory: [[convergence-pipeline-concept]], [[creative-director-direction]],
> [[video-model-strategy]]. No code has been written for this yet.

---

## 1. Verdict

The convergence concept is **directionally right and already latent in the
existing design** — but the framing to reject is "**one linear flow carried
end-to-end by one creative-director agent.**" Build the same UX as a **persisted
storyboard document + a few resumable stages + approval-as-checkpoints**, with
the *already-shipped editorial creative director* handed the timeline at the
end. This preserves every settled decision, lets the editorial capstone ship now
on existing footage, and lets the generative front-half plug in later without
touching it.

---

## 2. Two grounding findings

**A — the convergence is already half-built into the data model.**
[BUILD-BRIEF.md](BUILD-BRIEF.md) already states *"The timeline is the meeting
point. Workflow 1's output is workflow 2's input. This is one app, not two,"* and
the Phase-2 `Scene` already carries **both** `start_frame_image_id` and
`end_frame_image_id`. The concept is not new architecture — it is *adding an
agent (the creative director) as the through-line over a seam the data model
already anticipated.*

**B — two-keyframe (start+end frame) animation is not wired, and is now
*opportunistic, not required*.** Verified in code: `buildRequestBody` in
`apps/agent-server/src/providers/video/fal.ts` emits only `start_image_url`
(single frame); the default `fal-ai/kling-video/v3/standard/image-to-video` is
start-frame-only. The user relaxed the requirement (2026-06-01: *"they do not
need to be first and last per se, it is not a must"*). So the default animate
path stays **single-frame i2v + motion prompt** (current `animate_image`, more
controllable); start+end becomes a capability *flag* the agent prefers only when
a shot suits it. fal models that DO support it if ever wanted: **Seedance 1.5
Pro**, **Kling O1**, **Veo 3.1 first-last-frame** (see [[video-model-strategy]]).

---

## 3. Architecture — document + resumable stages, NOT one end-to-end agent

A 9-stage linear flow held in one agent session breaks in four ways: (1) latency
stacks across human-approval gates that outlive any in-memory session; (2)
cost-before-information — the expensive animation spend lands *before* the user
sees anything move; (3) mid-pipeline failure has no recovery vocabulary; (4)
re-running one scene silently invalidates downstream artifacts.

**The fix:** the through-line is a **persisted document**, not a long-lived
agent. One Sonnet orchestrator runs **stage-scoped episodes** that read/write the
document. The *stage* is a field on the document, not a different agent
(respects the settled "one orchestrator, never sibling agents"). The document IS
the context — there is no inter-agent handoff object (this answers the concept's
open question *"what's the context object that passes between stages?"*).

Persist on the **existing project schema** (`Project.storyboard`), through the
**existing workspace-fs**, versioned through the **existing migrations** — *no
new store* (a second store is the "two parallel session systems" anti-pattern the
project already rejected).

Four decoupled, individually-approvable, resumable stages:

1. **Plan** (`read_script`/`break_script_into_scenes`): script → `Scene[]` with
   descriptions + VO text + duration hints. Free. Approval = storyboard checklist.
2. **Generate stills** (batch over planned scenes). Cheap. Per-scene/grid approval.
3. **Animate** (batch over approved scenes): single-frame i2v by default. **One
   batch spend gate** showing total $. A failed scene → `status:'failed'`, others
   proceed; retry = re-run failed scenes only.
4. **Assemble + editorial pass**: "Send to timeline" materializes clips in order
   with VO → hands to the **shipped editorial creative director** over the
   populated timeline (BUILD-BRIEF's "timeline is the meeting point" handoff).

Properties the linear flow can't give: resumable across restarts/human pauses;
explicit staleness (`staleReason`) instead of silent cascades; mature/immature
decoupling enforced by the schema (the editorial capstone only ever sees a
populated timeline, exactly how BUILD-BRIEF defines Workflow 2's entry point).

---

## 4. Shared context object

Persisted at `Project.storyboard` (existing project JSON, versioned via existing
migrations). **Build `EditPlan` first** (the director needs it); **grow
`StoryboardScene` reactively** — do NOT build the full field set before a stage
needs it (YAGNI; matches the "grow the palette reactively" principle).

```ts
interface StoryboardDoc {
  schemaVersion: number
  stage: 'concept' | 'storyboard' | 'stills' | 'animation' | 'assembled' | 'editorial' | 'final'
  goal: string                       // the video's purpose — the through-line
  scriptText: string | null
  creativeConcept: string | null
  scenes: StoryboardScene[]          // START MINIMAL; add fields per stage as needed
  editPlans: EditPlan[]              // the editorial director's passes (back half)
  brandId?: string                   // resolves via existing resolveBrandKnobs()
}

// Minimal to start — grows reactively:
interface StoryboardScene {
  id: string
  order: number
  description: string                // for the review card
  voText: string                     // narration line (drives timing — §7)
  durationSec: number | null         // authoritative once VO synthesized (§7)
  status: 'planned' | 'stills-ready' | 'clip-ready' | 'on-timeline' | 'failed'
  staleReason?: string               // set when an input changed → downstream invalidated
  // generative fields (startFrameImageId, endFrameImageId, videoClipAssetId, cost,
  // model) added when the stills/animate stages are actually built.
}

// BUILD FIRST — the director's deliverable; generalizes suggest_trims' single
// decision into a multi-step, individually-toggleable plan:
interface EditPlanStep {
  id: string
  tool: string                       // existing tool name: 'cut_silence' | 'add_motion_graphic' | …
  args: Record<string, unknown>
  rationale: string                  // shown on the review card
  costEstimate?: { amount: number; currency: string; isEstimate: boolean }
  sideEffects: 'read' | 'mutate'     // honors the tool-design rule
  status: 'proposed' | 'approved' | 'rejected' | 'edited' | 'done' | 'failed'
  editedArgs?: Record<string, unknown>
}
interface EditPlan { id: string; createdAt: string; steps: EditPlanStep[] }
```

Two distinct "scene" concepts must stay separate: the **generative-video `Scene`**
(prompt→frames→clip — the storyboard) vs HyperEdit's **15-type motion-graphics
union** (`title|chart|stat|…` — editorial overlay content rendered via native
`add_motion_graphic` + HyperFrames). `scenes[]` = what to *generate*;
`editPlans[].steps[]` = what graphics/edits to *overlay*. Do not merge them.

---

## 5. Build order — director-first (confirmed, not changed)

The convergence concept does **not** change the settled order; it confirms
director-first and adds "reserve the schema early."

1. **Editorial creative director over the existing timeline** — the Phase-1
   capstone. `EditPlan` schema + `propose_edit_plan` + multi-step plan-review UI
   + partial-execution orchestration. Reuses the existing 16 tools as-is. Ships
   independently, on footage the user already has. **Start here.**
2. **Concurrently:** reserve `Project.storyboard` (version bump, mostly-empty);
   design `EditPlan` and `StoryboardScene` so they nest. Don't over-build scene
   fields.
3. **Then the front half**, in dependency order: `read_script` → scene
   decomposer → VO synthesis (TTS-first, §7) → still gen → animate (single-frame)
   → assembler → "send to timeline" → hands off to the already-built director.

Director-first rationale: `suggest_trims` is a *shipped, verified* propose→gate→
execute loop (the seed); 16 tools are the director's hands while the front half
is mostly gaps; the multi-step plan-review UI is shared infra both halves need
and is the director's own deliverable; BUILD-BRIEF discipline rule #1 ("build for
the next video you actually need to publish") favors editing footage that exists
now.

---

## 6. MVP slice

**Spike 0 (fail-fast on the taste risk — days, ~zero new code):** hand-author a
3-scene `StoryboardDoc` JSON (skip `read_script`), run a throwaway script that
calls the *shipped* `generate_voiceover` → `generate_broll` per scene sized to VO
→ `add_subtitles` → export. **Watch it.** If a script→VO→generated montage is
garbage at 3 scenes, no pipeline polish saves the concept — learned in days for a
few dollars. Isolates the taste risk from the script-parsing risk.

**MVP (if Spike 0 is promising): "Script → narrated montage → editorial pass →
export."**
- Build #1: **`read_script(text)`** → `StoryboardScene[]` with voText/description.
- Build #2: a thin **assembler loop** (VO-first timing from §7, `generate_broll`
  per scene — single-shot, no two-keyframe).
- Reuse (shipped): `generate_voiceover`, `generate_broll` (+ its M5.2 gate),
  `add_subtitles`, `add_motion_graphic` (brand-aware), placeholder→swap, export.
- Editorial pass = the already-built director over the assembled timeline.
- **Deferred out of MVP:** two-keyframe interpolation, two-frame still gen,
  VO-grounded auto-prompting, music gen, avatar/talking-head.

---

## 7. VO-driven scene timing — TTS-first

`generate_voiceover` already returns authoritative `durationSec` (it has no
placeholder precisely because duration is unknown until after synthesis). VO is
also cheap (Kokoro, free/local), so synthesizing VO first is correct on *both*
timing authority and cost ordering (cheap thing first, then size the expensive
video to it).

1. Synthesize VO per scene first → write `scene.durationSec`.
2. Assembler sets `scene[i].timelineFromSec = Σ durations[0..i-1]`; each visual
   window = `[from, from+durationSec)`.
3. Size each generated clip to its VO window. **Watch the Kling 3–15s clamp** —
   a long VO scene can't be one clip; assembler policy = split scene / multiple
   b-roll under one VO span / hold. Named risk, not an unknown.
4. Word-timestamp alignment is the back-half polish layer (karaoke captions,
   beat-accurate graphics), reusing the same `read-asset-transcript` →
   `placement:{fromSec,…}` path `suggest_trims` already uses. Don't make
   word-timing the primary layout driver — raw `durationSec` is exact and enough.

---

## 8. Video model arbitrage (fal-only) + two-keyframe opportunistic

See [[video-model-strategy]] and [ARCHITECTURE.md §5 Q5](ARCHITECTURE.md) for the
locked decision. Summary: **fal stays the sole video provider** (proven reliable;
cheaper aggregators kie.ai/muapi.ai evaluated and parked). Within fal, a **curated
capability registry** drives multi-*model* arbitrage: hard-constraint filter in
code → agent taste-picks among viable candidates → chosen model + cost on the
M5.2 spend gate with an override dropdown. Evolve the existing `buildRequestBody`
regex branches into registry-keyed per-model adapters. **House-model coherence
bias:** prefer one model per montage; diverge only on a hard requirement.
Two-keyframe is just a `caps.endFrame` flag (opportunistic).

---

## 9. Approval-gate UX + brand

**One review surface.** Build the **multi-step plan-review UI** for the editorial
director (a toggle/edit checklist, bigger than the single M5.2 card), then reuse
it as the storyboard grid and per-scene gates. Keep `requestConfirmation` as-is
for single-tool spend gates (don't regress the 4 tools using it); add the
multi-step surface as a *sibling* bridge action (`request-plan-approval`). The one
genuinely new gate primitive the pipeline needs is a **batch spend gate** (animate
N scenes = $X total, with partial-failure semantics).

**Brand.** `resolveBrandKnobs()` is shipped; put `brandId`/`brandMode` on the
document and the editorial pass's `add_motion_graphic`/`add_kinetic_title` calls
inherit on-brand styling. **Text stays out of the AI stills** → added in the edit
pass as native/brand motion graphics so it stays editable and on-brand (this is
exactly why the editable-vs-baked boundary pays off here).

---

## 10. Riskiest assumptions to validate (ranked)

1. **Taste/quality (highest, not an engineering risk):** does script→VO→
   `generate_broll`-per-scene→editorial produce a *watchable* video? → **Spike 0.**
2. **Two-keyframe is a red herring:** is single-frame i2v + motion prompt actually
   *more controllable* than start→end for this content? → one real A/B.
3. **Batch spend gate + partial-failure UX:** the shipped gate is single-decision.
4. **VO-vs-clip length mismatch:** the Kling 3–15s clamp vs long VO scenes.
5. **Resumability across hours-long human gates:** the document must round-trip
   through workspace-fs and survive a session restart mid-pipeline — the lynchpin.
6. **Cost per finished video:** project a real per-video cost at the user's volume.

---

## 11. Decisions log (this analysis)

- Convergence = **persisted `Project.storyboard` document + resumable stages +
  approval-as-checkpoints**, NOT one end-to-end agent. Stage = a document field;
  one orchestrator runs stage-scoped episodes; the document is the context.
- **Director-first confirmed.** The editorial creative director is the Phase-1
  capstone and ships independently of all generative work.
- **Two-keyframe = opportunistic, not required.** Default = single-frame i2v +
  motion prompt.
- **fal = sole video provider**; multi-*model* arbitrage within fal via a curated
  registry; cheaper aggregators parked. (See [[video-model-strategy]].)
- **VO-first timing**; **one reusable plan-review surface** + a new batch spend
  gate; **brand via the shipped resolver**, text kept out of AI stills.
