---
version: alpha
name: iost-terminal-design
description: A dark terminal-command-center interface for a live trading platform — near-black canvas (#07090c) with mint-green (#2fffd0) as the money/up signal, cyan (#4dd6ff) as the interactive accent, and trading red (#ff6157) for down states. Type runs Chakra Petch for display, Sora for body, JetBrains Mono for all data. Density is high (11–13px data, 4px spacing base), surfaces are layered panels with hairline borders, and every state change moves on a deliberate ease-out curve. The AITT brand mark is the "A>" glyph (agent executes) on black.
---

# IOST Terminal — DESIGN.md

Design language of the IOST Terminal (iostcallister.com). Dark neon terminal aesthetic: machine-grade density, glow-tinted accents, semantic trading colors. Every new page must follow this language.

## colors

```css
--bg:            #07090c   /* page canvas — near black */
--surface:       #0d1117   /* base panel */
--surface-2:     #121a23   /* elevated panel / hover */
--border:        #223044   /* hairline */
--border-strong: #33455f   /* focused / stronger hairline */
--text:          #eef6fc   /* primary text */
--muted:         #96a7b8   /* secondary text */
--dim:           #64758a   /* tertiary / disabled */
--up:            #2fffd0   /* mint — profits, up moves, positive, LIVE */
--up-dim:        rgba(47,255,208,0.16)   /* up-tinted fill/glow */
--down:          #ff6157   /* red — losses, down moves, danger */
--down-dim:      rgba(255,97,87,0.16)    /* down-tinted fill */
--warn:          #ffd06a   /* amber — warnings, pending */
--accent:        #4dd6ff   /* cyan — interactive accent, links, focus */
--accent-dim:    rgba(77,214,255,0.14)   /* accent-tinted fill */
```

Landing/marketing surfaces may use the lighter variant set (`--bg #04060a`, `--surface #0a0e15`, `--line #1c2b40`, plus `--cyan #00f2ff`, `--violet #8f6bff`, `--mint #2fffd0`, `--red #ff6b6b`).

**Semantic rules:** green/up and red/down are *trading signals only* — never decorative. Use `--up-dim`/`--down-dim` fills for backgrounds, full chroma for text/icons/values.

## typography

| Role | Family | Notes |
|---|---|---|
| Display / headings | `Chakra Petch` (fallback Space Grotesk) | tech-terminal character; uppercase for section eyebrows |
| Body / UI | `Sora` | clean, readable |
| Data / code / numbers | `JetBrains Mono` | ALL numbers, prices, timestamps, tables, logs |

**Scale (observed):** data grid 11–13px · body 14–16px · titles 17–22px · hero/display scales from Chakra Petch at larger sizes with tight line-height. Trading values get mono + up/down color + tabular feel.

## spacing & layout

- Base unit: `--sp-1: 4px` → `--sp-2: 8px` · `--sp-3: 12px` · `--sp-4: 16px` · `--sp-5: 24px` · `--sp-6: 32px`
- Density is HIGH — trading screens pack data; whitespace is for grouping, not decoration
- Panels: layered surfaces (`--surface` on `--bg`), separated by 1px `--border` hairlines; elevated states use `--surface-2`

## radius & effects

- Radius: `6px` base (`--radius`) — corners are slightly soft, never pill-shaped
- Glow accents: accent-tinted fills (`--up-dim`, `--accent-dim`) for active/selected/LIVE states — glow via rgba tint, not heavy blur
- Focus: visible `:focus-visible` outlines in accent color; hover gated to `pointer: fine` devices (no hover styles on touch)

## motion

- `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` — standard enter/reveal
- `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)` — transitions/state changes
- Short durations; motion serves state feedback (prices, approvals, status), not decoration

## components

- **Cards/panels** — `--surface` bg, hairline `--border`, 6px radius, mono headers with uppercase eyebrows
- **Stat values** — JetBrains Mono, `--up`/`--down`/`--warn` semantic colors, dim labels
- **Buttons** — primary CTA in mint/up-tinted fill or accent; destructive in down; disabled = `--dim`
- **Status dots/pills** — up (mint) / down (red) / warn (amber) / neutral (dim); LIVE indicator uses up-tinted glow
- **Charts** — dark canvas, accent/up/down semantic series, hairline grid
- **Brand mark** — AITT "A>" glyph (agent executes) on black; hexagon variant for static/logos

## principles

1. **Terminal, not brochure** — machine-grade density, data-first, minimal chrome
2. **Color carries meaning** — semantic trading colors only; no decorative rainbows
3. **Mono for money** — every number is mono; every number carries its semantic color
4. **Layered darkness** — panels on panels on near-black, separated by hairlines
5. **Motion with intent** — ease-out reveals; state changes animate, content never bounces
6. **Agent-native** — surfaces readable and actionable by agents (semantic HTML, ARIA, visible focus)

## evidence

Tokens verified from `public/index.html` and `public/css/style.css` (`:root` blocks), Aug 2026. If a token moves, update this file — it is the contract agents follow.
