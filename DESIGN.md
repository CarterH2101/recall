# DESIGN.md — recall viewer

One self-contained HTML file (`src/ui/index.html`). System fonts only. All
values as CSS custom properties; OKLCH.

## Theme
Warm paper ledger, light by default; a deliberate warm-graphite dark variant
via `prefers-color-scheme`. Never blue-black, never pure #000/#fff.

Scene: a developer flips from a dark editor to this tab for twenty seconds to
check what memory got injected, any hour. Both palettes are first-class.

## Tokens (light / dark)
- `--paper`   oklch(96.5% 0.007 85)  /  oklch(21% 0.012 75)   page
- `--surface` oklch(98.6% 0.004 85)  /  oklch(24.5% 0.012 75) panels, inputs
- `--ink`     oklch(24% 0.015 75)    /  oklch(90% 0.008 85)   primary text
- `--ink-2`   oklch(44% 0.012 75)    /  oklch(72% 0.01 80)    secondary
- `--ink-3`   oklch(58% 0.01 78)     /  oklch(56% 0.01 78)    labels, hints
- `--rule`    oklch(89% 0.008 85)    /  oklch(31% 0.012 75)   hairlines
- `--accent`  oklch(56% 0.14 55)     /  oklch(74% 0.12 62)    burnt sienna
- Kind hues (dots + text, never pill backgrounds):
  decision = accent · gotcha oklch(54% 0.13 30) · preference oklch(52% 0.09 310)
  · reference oklch(52% 0.1 150)

Color strategy: Restrained. Accent on active tab, links, chart bars, focus,
primary hover. Everything else is inked neutrals.

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
