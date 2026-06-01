# Abdias.Marketing brand assets

Source of record for the brand profile the AI agent applies on request
("do X on the Abdias brand").

- **`style-guide.html`** — Abdias.Marketing "The Editorial Architect" v3.0
  (April 2026). The canonical brand guide; all tokens live in its CSS `:root`.
- The agent's machine-readable profile is **hand-authored** from this guide at
  [`apps/agent-server/src/brand/profiles/abdias.ts`](../../apps/agent-server/src/brand/profiles/abdias.ts)
  (not parsed at runtime). When the guide changes, update that profile to match.

## Token summary

| Role | Light "Paper" | Dark "Ink" |
| --- | --- | --- |
| Background | `#F5F0E8` Paper | `#0B1220` Ink |
| Surface | `#FAF7F2` Paper Soft | `#1A2540` Midnight |
| Text primary | `#0B1220` Ink | `#F5F0E8` Paper |
| Text secondary | `#3D4A63` Slate | `#B8C0D0` Paper Muted |
| Accent (structural) | `#2B5CE6` Signal Blue | `#7FA1F0` |
| Accent (emphasis, "salt") | `#B8553A` Terracotta | `#D87B5A` Clay |

Fonts: **Fraunces** (display/headline, +italic emphasis), **Inter** (body/UI),
**JetBrains Mono** (technical/data). Default mode: **Light "Paper"**.

Rules: 80/15/5 accent budget · one italic emphasis word per headline · terracotta
like salt (never a fill) · no pure black/white · no gradient/glow · no emoji.
