# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

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
