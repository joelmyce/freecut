/**
 * Starter-prompt chips above the chat input (PHASE-1-PLAN.md §6.5.2.1).
 *
 * Lower cold-start cost: a fresh user with no idea what the agent does sees
 * 12 named jobs the agent can actually do, seeded from the live tool set.
 * Click populates the textarea — doesn't auto-send so the user can tweak.
 *
 * The chip list is deliberately static — surfacing real timeline context
 * (clip names, time ranges) lives in the reference-pill picker below the
 * input. These are just task templates.
 */

import { memo } from 'react'

interface SuggestionChipsProps {
  disabled: boolean
  onPick(prompt: string): void
}

interface ChipDef {
  label: string
  prompt: string
}

const CHIPS: ReadonlyArray<ChipDef> = [
  { label: 'Add captions', prompt: 'Add captions to the selected clip.' },
  {
    label: 'Cut silences',
    prompt: 'Cut silences over 0.5s on the selected clip.',
  },
  {
    label: 'B-roll 0:12–0:18',
    prompt: 'Add b-roll of a neon city skyline between 0:12 and 0:18.',
  },
  { label: 'Regenerate this clip', prompt: 'Regenerate the selected clip.' },
  {
    label: 'Transcribe (Gemini)',
    prompt: 'Transcribe the selected clip using gemini.',
  },
  { label: 'Transcribe', prompt: 'Transcribe the selected clip.' },
  {
    label: 'B-roll under this',
    prompt:
      'Add b-roll that visually matches what is being said in the selected clip over the same time range.',
  },
  {
    label: 'More dramatic regen',
    prompt: 'Regenerate the selected clip but make it more dramatic and cinematic.',
  },
]

export const SuggestionChips = memo(function SuggestionChips({
  disabled,
  onPick,
}: SuggestionChipsProps) {
  return (
    <div
      className="flex flex-wrap gap-1 px-2 pt-2 pb-1 shrink-0 border-t border-border bg-background/30"
      data-testid="agent-suggestion-chips"
    >
      {CHIPS.map((chip) => (
        <button
          key={chip.label}
          type="button"
          disabled={disabled}
          onClick={() => onPick(chip.prompt)}
          className="text-[10px] leading-tight px-2 py-1 rounded-full border border-border bg-background hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title={chip.prompt}
        >
          {chip.label}
        </button>
      ))}
    </div>
  )
})
