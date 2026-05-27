# M4 — End-to-End Verification

Sequential checklist for verifying every M4 surface before committing.
Each section can pass/fail independently — if something breaks midway,
note which step and stop; we'll diagnose before moving on.

**Prereqs:**

- `npm run dev:all` is running (vite on 5173 + agent on 5174). Check
  `ws://127.0.0.1:5174` is listening — the agent-server log line
  `agent server ready on ws://127.0.0.1:5174` should be visible.
- Your `.env` has `OPENAI_API_KEY`, `FAL_API_KEY`, `GEMINI_API_KEY`.
- A workspace folder picked.
- A project open with **one video clip with audible speech** on the
  timeline (10–60 seconds is ideal — short enough to iterate, long
  enough to have silences and content). A vlog-style clip is perfect.
  *For the Gemini step, a non-English clip is even better — but
  optional.*

**Known cosmetic issue:** transcription currently outputs English even
when the source is non-English. Tracked separately; doesn't block
verification.

---

## Step 1 — Chat panel UX (no AI calls, ~1 min)

Just verify the new chat-panel surfaces render. Open the chat panel
(the Bot icon in the toolbar).

**1.1 Suggestion chips**
- [ ] Row of small chips appears immediately above the textarea
- [ ] At least these labels are visible: "Add captions", "Cut silences",
      "B-roll 0:12–0:18", "Regenerate this clip", "Transcribe",
      "Transcribe (Gemini)"
- [ ] Click "Add captions" → the textarea populates with `Add captions
      to the selected clip.` (does NOT auto-send)

**1.2 Reference pill picker**
- [ ] A small `+ Attach` button is visible below the textarea
- [ ] Click it → popover opens with three rows: "Selected clip",
      "In/Out range", "Around playhead" + `±2s` `±5s` `±10s` buttons
- [ ] Select a clip on the timeline, reopen the popover, click
      "Selected clip" → a pill appears below the input reading
      `Clip: <filename> on <track>`
- [ ] Click the `×` on the pill → it disappears

**1.3 UI-state flags in the timeline summary** *(verified indirectly
in Step 3 below — the agent should know which clip you mean without
you saying its filename)*

---

## Step 2 — Transcribe + subtitles (M1 + M2 regression, ~2 min)

Confirm the well-trodden path still works after M4 edits.

- [ ] Select your video clip
- [ ] Open chat panel, click the **Add captions** chip, hit Enter
- [ ] **Expected:** agent calls `transcribe` then `add_subtitles` in
      one turn → caption track appears below your video with cues
- [ ] Press `Ctrl+Z` once → captions disappear in a single step

---

## Step 3 — Reference pills + "this clip" resolution (M4.4, ~1 min)

Test that the pill picker compiles to bracket context AND the agent
uses it.

- [ ] With the video still selected, click `+ Attach` → "Selected clip"
- [ ] Confirm the pill appears below the input
- [ ] Type `transcribe this` and send
- [ ] In the agent-server stdout (`npm run dev:agent` log), look for
      `tool-call` with `transcribe` and `asset_id` matching your clip's
      mediaId
- [ ] **Expected:** the bracket context line `[Clip: <name> on …
      (item:XYZ)]` appears in the user-message text that was sent (you
      can verify this in the chat panel's user-message bubble)

---

## Step 4 — Gemini transcription (M4.5, ~2 min)

Opt-in path. The plain "transcribe" still routes to local Whisper —
only the explicit "using gemini" should hit Google.

- [ ] In chat, type `transcribe the selected clip using gemini` and
      send
- [ ] Watch agent-server stdout for `tool-call` with
      `provider: "gemini"`
- [ ] **Expected:** the transcript replaces (or first-creates) the
      transcript for this clip. The tool result should show
      `provider: "gemini-flash"`.
- [ ] In a fresh chat message, type `transcribe the selected clip`
      (without "using gemini") → tool-call should show `provider:
      "auto"` and the result `provider: "local-whisper"`. **Gemini must
      NOT be picked under auto.** This is the most important
      verification — if it auto-routes to Gemini we have a bug.

---

## Step 5 — generate_broll + transcript grounding (M3 + M4.3, ~2 min)

Seed an AI-generated clip and verify transcript grounding kicks in.

- [ ] Note a time range on your timeline where there's an existing
      transcript (e.g. between 0:05 and 0:10 of your clip)
- [ ] In chat, type `add b-roll of a quiet coffee shop between 0:05
      and 0:10` and send
- [ ] **Expected:** a blue dotted placeholder appears immediately at
      0:05–0:10 on a new "AI Generated" track above your clip
- [ ] In agent-server stdout, the `tool-result` for `generate_broll`
      should include `usedTranscriptContext: true` (because your
      transcript from Step 2 covers that range)
- [ ] ~30–90s later, a real video clip swaps in. The new clip lands in
      the Media Library with an indigo wand icon
- [ ] Press `Ctrl+Z` once → the final clip is removed in a single step

**Stop here if the swap doesn't happen — check the agent-server log
for fal errors.**

---

## Step 6 — Regenerate with prompt_modifier (M4.1 + bug fix, ~2 min)

The exact path you tested earlier. With today's fix, the subject must
be preserved.

- [ ] Select the b-roll clip you just generated (the swapped-in one,
      not the original video)
- [ ] In chat, type `regenerate this clip but make it more cinematic
      and more dramatic`
- [ ] In agent-server stdout, the `tool-call` for
      `replace_clip_with_regeneration` should show
      `prompt_modifier: "more cinematic and more dramatic"` and
      **NOT** a `new_prompt` field
- [ ] The `tool-result` should include:
      - `regenMode: "modifier"`
      - `finalPromptPreview` containing both your original subject
        (e.g. "coffee shop") AND "more cinematic and more dramatic"
      - `modelUsed` matching the ORIGINAL model (kling-video/v1.5/...)
        not v3
- [ ] When the swap completes, the rendered clip should be visually
      consistent with the original subject — not a Roman soldier 🙂
- [ ] Press `Ctrl+Z` once → original AI clip restored

---

## Step 7 — Regen identity + replacement modes (M4.1, ~2 min)

Cover the other two prompt modes.

- [ ] Select your AI-generated clip, chat: `regenerate this clip` (no
      modifier) → `tool-call` should have neither `new_prompt` nor
      `prompt_modifier`; `tool-result` should show
      `regenMode: "identity"`
- [ ] After swap completes, select the new clip again, chat:
      `replace this clip with footage of a forest at sunrise instead`
      → `tool-call` should have `new_prompt` set; `tool-result` should
      show `regenMode: "replacement"`
- [ ] Both should single-Ctrl+Z back to the previous state

---

## Step 8 — Regen on a non-AI clip errors clearly (M4.1, ~30s)

- [ ] Select your **original** video clip (NOT an AI-generated one)
- [ ] Chat: `regenerate this clip` (no modifier, no new_prompt)
- [ ] **Expected:** chat shows an error like *"Clip <id> was not
      AI-generated … Pass new_prompt explicitly to regenerate it from
      scratch."*
- [ ] Try again with: `regenerate this clip but make it dramatic`
      (prompt_modifier on a non-AI clip)
- [ ] **Expected:** chat shows *"… is not AI-generated, so
      prompt_modifier ... has nothing to append to. Pass new_prompt
      with the full description instead."*
- [ ] Try again with: `replace this clip with footage of mountains`
- [ ] **Expected:** regen runs (full replacement path works on non-AI
      clips)

---

## Step 9 — cut_silence (M4.2, ~2 min, DESTRUCTIVE)

⚠️ Local-only. No remote calls. But the operation modifies your
timeline — save the project before this step in case undo misbehaves.

- [ ] Save your project (Ctrl+S or wait for autosave)
- [ ] Select your original video clip (the one with audible speech)
- [ ] Click the **Cut silences** chip to populate the textarea, send
- [ ] Watch the agent-server stdout for the tool-call args
- [ ] **Expected:** clip splits into multiple pieces with silent
      ranges removed, trailing items ripple back, captions stay
      aligned with their parent segments
- [ ] The `tool-result` should include `silenceRangeCount`,
      `removedDurationSec`, `splitCount`
- [ ] Press `Ctrl+Z` once → clip restored to its original state in a
      single undo
- [ ] (Optional sanity) Try with explicit args: `cut silences over 1
      second on this clip` → should pass `min_silence_sec: 1`

---

## Final commit checklist

If all steps above passed:

- [ ] `cd /Users/joelm/Documents/Antigravity/FreeCut && npm run lint`
      → 0 errors, 0 warnings
- [ ] `cd apps/agent-server && npm test` → 84 tests pass
- [ ] `npm run test:run -- agent` → 23 tests pass
- [ ] `npm run check:boundaries` → pass
- [ ] Update `ai-video-editor-status.md` to mark M4 verified
- [ ] Commit M4 as one or two logical chunks (suggested: tool code +
      tests first, then chat UX, then docs)

---

## If something fails

For any tool-related failure, grab these three things and we'll
diagnose:

1. The exact text you sent to chat
2. The agent-server stdout from the moment you hit send (now logs
   every `tool-call` + `tool-result` with args truncated to 600 chars)
3. The browser console (cmd-opt-J) — look for `[agent-bridge]` or
   `[ai-gen]` errors

The new `regenMode` + `finalPromptPreview` fields on the regen tool
result are specifically there to make the next regen mishap easy to
diagnose without re-reading code.
