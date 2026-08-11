# DESIGN.md — recall viewer

One self-contained HTML file (`src/ui/index.html`). System fonts only. All
values as CSS custom properties; OKLCH.

## Theme
Light, airy, techy — the SAME scheme as recall-console (one product, one
look): cool-gray wash, floating white surfaces with soft two-layer shadows,
deep navy ink, one vivid indigo-blue accent. Single committed light theme.
Never pure #000/#fff.

## Tokens (shared with recall-console/DESIGN.md)
- `--paper`   oklch(97.6% 0.005 250)  page wash
- `--surface` oklch(99.4% 0.002 250)  cards, inputs
- `--ink`     oklch(26% 0.035 265)    primary text (navy)
- `--ink-2`   oklch(45% 0.022 262)    secondary
- `--ink-3`   oklch(60% 0.016 258)    labels, hints
- `--rule`    oklch(91.5% 0.009 255)  hairlines
- `--accent`  oklch(52% 0.19 265)     indigo-blue; `--accent-soft` focus rings
- Kind hues (dots + text, never pill backgrounds):
  decision = accent · gotcha oklch(56% 0.15 38) · preference oklch(54% 0.15 305)
  · reference oklch(52% 0.12 158)

Color strategy: Restrained. Accent on active tab, links, chart bars, focus,
primary hover. Everything else is inked neutrals. Stat ledger floats as a
white card; tables stay hairline-rule only.

## Type
- UI: `system-ui, "Segoe UI", -apple-system, sans-serif`, 14px base.
- Data (ids, scores, dates, counts, labels): `ui-monospace, "Cascadia Mono",
  Consolas, monospace`, 12–12.5px.
- Section labels and table headers: mono, 10.5px, uppercase, +0.08em.
- Scale ratio ~1.2; wordmark is lowercase mono `recall` with an accent block
  cursor, 16px. No display fonts.

## Structure
- Header: wordmark + db path (mono, ink-3) + underline tab nav. No pills.
- Stats: a horizontal ledger strip (hairline-separated figures, mono numerals,
  small mono labels) — explicitly not a card grid — then the turns/day chart,
  then plain tables.
- Tables: hairline row rules only; no zebra, no card wrappers; th in label
  style; generous 10px row padding; long content clamps with ellipsis.
- Facts edit is inline (textarea swaps in place). No modals, no prompt().

## Components
- Buttons: mono 12px text actions, 1px hairline border, transparent bg;
  hover raises to accent border + accent text; focus-visible 2px accent ring;
  disabled = ink-3 40%.
- Badges: kind = colored dot + mono word. Pinned = small accent ▪ before text.
- Chart: 6px bars, 2px top radius, accent fill at 85% opacity (100% hover);
  sparse mono x-labels; native <title> tooltips.
- Empty states: one ink-2 sentence that teaches the CLI command that fills it.

## Motion
150ms, cubic-bezier(0.22, 1, 0.36, 1), opacity/color/border only. Tab content
fades in 6px rise. `prefers-reduced-motion` disables all of it.

## Copy
Sentence case everywhere; labels without periods; no em dashes; no emoji in
chrome (the 🧠 stays in the terminal hook, not here).
