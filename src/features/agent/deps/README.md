# Agent feature dependencies

Cross-feature imports go through this directory per the project's
`check:boundaries` rule. Other features should NOT import directly from
`@/features/agent/*` (the agent owns its own consumers — main.tsx, the
forthcoming chat panel).
