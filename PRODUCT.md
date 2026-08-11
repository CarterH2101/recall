# PRODUCT.md — recall

register: product

## What it is
recall is local-first memory for coding agents. It captures Claude Code and
Codex CLI transcripts, embeds them on-device, redacts secrets, distills
durable facts, and injects relevant past context into new prompts. The viewer
(`/ui`, served by the local daemon at 127.0.0.1:4319) is the product's only
visual surface: a private console where one developer inspects and curates
their own memory.

## Users
Terminal-dwelling developers who live in coding agents. They are fluent in
Linear/Raycast/Stripe-quality tooling and allergic to SaaS chrome. They open
the viewer in a browser tab beside their editor, glance, curate a fact or
label an injection, and leave. Sessions are short and purposeful.

## Tone
Quality instrument, not dashboard. A ledger of your own working memory:
calm, dense where data is dense, quiet everywhere else. Privacy is the brand:
everything on this page exists only on this machine, and the design should
feel personal and archival rather than corporate.

## Anti-references
- Generic AI-built SaaS: indigo-blue accents, rounded pill badges, tile grids
  of big-number stat cards, emoji as iconography, gradient anything.
- Terminal-cosplay dark mode with neon greens.
- Anything requiring a build step: the viewer stays one self-contained HTML
  file with system fonts, served by the daemon.

## Strategic principles
- The machine boundary is the trust boundary; no logins, no cloud chrome.
- Density is respect: this user wants numbers and rows, labeled precisely.
- Curation actions (pin, archive, label, block) are the point of the page;
  they must be one interaction away, inline, never modal.
