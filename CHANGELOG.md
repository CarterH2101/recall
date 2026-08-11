# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Versioned database migrations (`PRAGMA user_version`).
- Test harness (`node:test`) and cross-platform CI.

## [0.1.0] — unreleased target

First published release as `recalld` on npm. Planned:

- `npx recalld setup` one-command install (runtime in `~/.recall/app`, stable
  hook shims in `~/.recall/bin`).
- Claude Code plugin (declarative hooks + auto-registered MCP server).
- Daemon lifecycle hardening: identity handshake, pidfile, port fallback,
  `recalld doctor`, opt-in autostart.
- MCP server talks to the daemon instead of loading a second embedding model.

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
