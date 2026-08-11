# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-08-11

Team sync — the memory pool becomes shareable, without the server ever
reading it.

### Added
- **`recalld sync`** (migration v5): `init --server <url>` creates a team and
  prints a single invite code; `join <invite>`; `now|push|pull`; `status`;
  `share <id> [--allow-secret]` / `share --all [--project P]` / `unshare`.
  Sharing is per-fact opt-in — nothing syncs by default, raw turns never sync.
- **True E2E encryption**: facts are AES-256-GCM encrypted with the shared
  team key before leaving the machine (op id bound as AAD — no replay under
  another id). The hub stores opaque blobs; pulled facts are re-embedded
  locally, so embeddings never travel. Home-directory paths are rewritten to
  `~` in transit.
- **Redaction hard gate at push**: a secret hit blocks the fact with the rule
  names printed; override is per-fact (`share <id> --allow-secret`), never
  global.
- **Conflict handling**: last-writer-wins on (version, timestamp, device);
  an unsynced local edit that loses is preserved as a visible `[conflict]`
  copy, never silently dropped.
- **Stateless-retry push**: no outbox table — push diffs `shared` facts whose
  version is ahead of `synced_version`, with deterministic op ids
  (`device:fact:version`), so crashed/retried pushes are idempotent by
  construction.
- Daemon syncs every 5 minutes when a team is configured (best-effort; a down
  hub never affects local operation).
- **Server**: separate repo `recall-sync-server` (BSL 1.1, converts to
  Apache-2.0 in 2030) — a single-container append-only ciphertext log with
  team bearer auth, SQLite/WAL storage, and idempotent op ingestion. Wire
  protocol documented in both repos.
- End-to-end verification script (`scripts/verify-sync-e2e.mjs`): two
  isolated client processes + a real hub — 12 checks including
  hub-sees-no-plaintext and the conflict-copy path.

## [0.5.0] — 2026-08-11

Your memory has a face now.

### Added
- **Viewer** at `http://127.0.0.1:4319/ui` — single self-contained HTML page
  served by the daemon, no framework, no build step. Tabs: Search (live
  `/recall` with fact/turn badges and scores), Sessions (browse any captured
  session, per-turn "never inject" index removal), Facts (add/edit/pin/
  archive inline), Activity (the injections log with 👍/👎 labeling that
  appends to `~/.recall/eval/labels.jsonl` — closing the eval loop), Stats
  (turns/day chart, source breakdown, hook injection rate).
- The viewer and its `/api/*` routes are **localhost-only even with a valid
  bearer token** — the token exists for Siri, not remote administration.

## [0.4.0] — 2026-08-11

Raw history gets distilled into durable, editable facts.

### Added
- **Facts** (migration v4): short curated memories with kind
  (decision/gotcha/preference/reference), pin/archive/edit, source-turn
  provenance, and dedup/merge on insert (exact hash merge; ≥0.92 vector
  similarity merge that never clobbers human edits; 0.86–0.92 flagged
  near-duplicate). `recalld facts list|add|show|edit|pin|archive|rm`.
- **Distill** (`recalld distill`, dry-run by default): two-stage promotion —
  pure-local candidate selection (lexical durability markers + cross-session
  vector recurrence, injected-content filters) then rewrite via a pluggable
  local summarizer (`RECALL_DISTILL_CMD`; auto-detects headless `claude -p`;
  no cloud keys ever). Extractive fallback only for strong assistant
  decision/gotcha turns. Incremental via `distill_state`.
- **Merged ranking**: facts rank above raw snippets (+0.06 boost, +0.05
  pinned, −0.05 threshold relief, capped at limit−1, session-dedup-exempt);
  raw turns already distilled into a selected fact are suppressed. The hook
  renders facts as `📌 [kind] …`.

### Fixed
- vec0 virtual tables don't implement `INSERT OR REPLACE` — vector updates
  now delete+insert. This also silently broke `redact --reembed`; re-ran
  against the production db (11 vectors truly rewritten + VACUUM).

## [0.3.0] — 2026-08-11

Retrieval changes are measured now, not vibed.

### Added
- **Eval harness** (`recalld eval`): labeled-dataset runner computing
  recall@1/3/5, MRR, hook-operating-point precision/noise/injection rates,
  and a threshold sweep that recommends the F0.5-optimal `RECALL_MIN_SCORE`
  with a hit/miss score histogram. `seed` samples real history into
  candidates; `label` is an interactive y/n/f labeling loop building
  `~/.recall/eval/personal.jsonl` (never committed).
- **CI eval gate**: committed pre-embedded fixture (invented 14-session
  corpus + 20 paraphrase queries, zero model download in CI) compared
  against `eval/baseline.json` — recall@3/MRR/hook-recall drops or noise
  rises >0.02 fail the build. Deterministic (byte-identical repeat runs).
- **Injections log** (migration v3): every `/recall` and `/ask` records
  query, source (hook/mcp/ask), result ids + scores — the audit trail of
  what memory actually got injected, feeding eval labeling and the future
  viewer. 20k-row retention sweep at daemon start.

### Changed
- `recall()` split into `recallCandidates()` (KNN + penalties) and
  `selectSnippets()` (threshold/dedup/pairing) — behavior-identical
  (deterministic tiebreak added), enabling single-pass threshold sweeps.
- First measured insight, for the record: on the synthetic fixture the 0.75
  hook threshold yields 50% hook-recall at 0% noise; 0.69 would yield 90%
  at 0% noise. Real-history labeling will decide any change.

## [0.2.0] — 2026-08-11

Memory goes cross-agent, and secrets stop entering the database.

### Added
- **Codex CLI capture.** Rollout sessions under `~/.codex/sessions` are
  parsed (formats 0.119→0.142 verified), watched live by the daemon
  (recursive fs.watch, debounced, with a polling fallback and a 7-day
  catch-up sweep on startup), and backfillable via
  `recalld backfill --source codex|all`. Ask Claude Code what you did in
  Codex last week — it knows now.
- **Secret redaction on ingest.** ~20 high-precision rules (AWS, GitHub,
  OpenAI, Anthropic, Slack, Stripe, PEM blocks, JWTs, connection-string
  passwords, entropy-gated generic assignments) run before storage — and
  therefore before embedding. Custom patterns via `~/.recall/config.json`.
  `recalld redact --dry-run|--backfill` retro-cleans existing databases,
  re-embeds affected rows, and truncates WAL + VACUUMs so plaintext doesn't
  linger in freed pages.
- Source-adapter interface (`src/lib/sources/`) — new capture sources are one
  file; per-source enable/disable in config. Existing claude-code turn ids
  unchanged (verified: full cursor-less re-read of a production database
  inserts zero duplicates).
- Migration v2: `turns.redaction_count`.

## [0.1.0] — 2026-08-11

First published release as `recalld` on npm.

### Added
- `npx recalld setup` one-command install: runtime in `~/.recall/app`,
  stable hook shims in `~/.recall/bin` (survive npx cache eviction and node
  version-manager switches), hook `timeout` fields, automatic scrubbing of
  legacy clone-era hook entries.
- Claude Code plugin: declarative hooks, auto-registered MCP server
  (stdlib-only committed bundles), `/recall:setup` command, self-hosted
  marketplace manifest.
- Single `recalld` dispatcher CLI: `setup`, `daemon`, `status`, `doctor`,
  `update`, `uninstall`, `autostart on|off`, `backfill`, `mcp`, and the
  maintenance subcommands.
- Daemon lifecycle: identity `/health`, localhost-only `/shutdown`, pidfile
  (`~/.recall/daemon.json`), port fallback past foreign processes,
  stale-version replacement after upgrades.
- Versioned database migrations (`PRAGMA user_version`).
- Test harness (`node:test`) and cross-platform CI (3 OS × Node 20/22),
  tag-triggered npm release workflow.

### Changed
- MCP server is daemon-first over HTTP — no second in-RAM copy of the
  embedding model; in-process fallback only if the daemon can't start.
- Embedding model cache moved to `~/.recall/models` (re-downloads once).
- The seven per-feature bins are replaced by the `recalld` dispatcher.

## [0.0.1] — 2026-07-30

Initial clone-install beta.

### Added
- Claude Code capture (Stop hook, byte-cursor incremental ingest) and
  auto-recall injection (UserPromptSubmit hook, 0.75 threshold).
- Local embedding (bge-small-en-v1.5 via transformers.js), SQLite + sqlite-vec.
- Q+A retrieval units, self-reference penalty, one-snippet-per-session dedup.
- MCP tools `recall` and `recent_sessions`.
- Siri voice access via daemon `/ask`.
- Granola meetings as a second memory source.
- Project-root config, junk pruning, re-projection CLIs.
