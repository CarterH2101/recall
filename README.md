# recall

**Local-first memory for your coding agents — cross-session, cross-agent, and voice-accessible via Siri.**

Your AI coding sessions are full of decisions, approaches, and answers that
evaporate the moment the session ends. `recall` captures your Claude Code
sessions, indexes them **entirely on your own machine**, and:

- **auto-injects** relevant past context into every new prompt (your agent
  remembers what you did last week),
- gives any agent an explicit **`recall` MCP tool** ("what did I conclude
  about X?"),
- and answers **by voice from your iPhone**: *"Hey Siri, Ask Recall."*

**Nothing ever leaves your machine.** Storage, embeddings, and search are all
local. No cloud, no account, no API key. Your transcripts already sit on your
disk — this just makes them useful.

> **Beta.** Captures Claude Code today. Codex/Cursor adapters are next — the
> schema is already source-agnostic.

## Install

```bash
npx recalld@latest setup
```

That's it. One command installs the runtime to `~/.recall/app` (~550MB of
dependencies — the on-device embedding engine is most of it), downloads a
~130MB embedding model once, indexes your existing transcripts, registers the
Claude Code hooks, and starts the local daemon. Restart your Claude Code
session and you'll see `🧠 recall: injected N snippets…` when past context is
found.

**Or install as a Claude Code plugin:**

```
/plugin marketplace add CarterH2101/recall
/plugin install recall@recall
/recall:setup
```

The plugin registers the hooks and the MCP tool declaratively; `/recall:setup`
installs the runtime.

Requires Node 20.11+. Windows, macOS, and Linux (x64/arm64; Windows-on-ARM and
Alpine are not supported yet — sqlite-vec has no prebuilds there).

## What you get

```
Claude Code ──Stop hook──────────► recalld (local daemon, 127.0.0.1)
            ──UserPromptSubmit────►   • warm local embedding model
                  │                    • SQLite + sqlite-vec (one file: ~/.recall/memory.db)
                  ▼                    • /ingest /recall /ask
        injected context
                                     ▲                    ▲
   Any agent ── stdio MCP ───────────┘     iPhone ── Siri Shortcut ── /ask
```

- **Auto-recall on every prompt.** A `UserPromptSubmit` hook vector-searches
  your past sessions and prepends strong matches (with a visible
  `🧠 recall: …` indicator). Conservative thresholds, hard caps, and strictly
  fail-open: if the daemon is down it injects nothing and your prompt is
  untouched.
- **Silent capture.** A `Stop` hook ingests just the appended bytes of the
  session transcript. Idempotent — never duplicates, even on 38MB transcripts.
- **MCP tools.** `recall(query, …)` and `recent_sessions()` over stdio for any
  MCP-capable agent: `recalld mcp` (talks to the daemon — no second copy of
  the model in RAM).
- **Self-healing daemon.** Identity handshake, automatic port fallback when
  something else holds 4319, stale-version replacement after upgrades, and
  `recalld doctor` when you want receipts.
- **Siri voice access.** A 3-minute Shortcut setup lets you ask your memory
  from anywhere — see **[docs/siri.md](docs/siri.md)**. Phone↔computer over
  your own LAN or Tailscale; token-authed; still no cloud.

## CLI

```
recalld setup            install/update everything (--runtime-only, --no-backfill)
recalld status           install + daemon + database at a glance
recalld doctor           diagnose problems, with fix hints
recalld autostart on     start the daemon at login (optional; schtasks/launchd/systemd)
recalld update           update the runtime to the latest release
recalld backfill         re-index existing transcripts
recalld uninstall        remove hooks/shims/runtime (--purge removes your data too)
```

## Configuration (env vars, all optional)

These are read from the real process environment (nothing loads `.env` —
`.env.example` is documentation). Set persistent values system-wide
(`setx` on Windows).

| Var | Default | Meaning |
|-----|---------|---------|
| `RECALL_DB_PATH` | `~/.recall/memory.db` | DB file location |
| `RECALL_PORT` | `4319` | Daemon port (falls back to 4320+ if occupied) |
| `RECALL_BIND` | `127.0.0.1` | Set `0.0.0.0` to allow phone access (token required) |
| `RECALL_MODEL` | `Xenova/bge-small-en-v1.5` | Local embedding model |
| `RECALL_MODEL_DIR` | `~/.recall/models` | Model cache location |
| `RECALL_ENABLED` | `true` | Set `false` to instantly disable auto-inject |
| `RECALL_MIN_SCORE` | `0.75` | Min similarity for auto-injected snippets |
| `RECALL_ASK_MIN_SCORE` | `0.45` | Min similarity for Siri `/ask` answers |
| `RECALL_PROJECT_ROOTS` | — | `path=label;path=label` cwd→project mapping (also `~/.recall/config.json`) |
| `RECALL_DEBUG` | — | `1` for daemon request logging (metadata only) |
| `RECALL_PRUNE_CWD` | — | cwd substrings treated as junk by prune-noise |

## Migrating from a clone install

`npx recalld@latest setup` handles it: legacy hook entries pointing into your
old checkout are scrubbed automatically (a timestamped settings backup is
made first), and your existing database at `~/.recall/memory.db` is picked up
untouched. Delete the old clone afterwards.

## Uninstall

`recalld uninstall` removes the hooks, shims, autostart entry, and runtime.
Your memory database is kept unless you pass `--purge`.

## Privacy model, stated plainly

- Capture reads transcript files Claude Code already writes to your disk.
- Embeddings run in-process with a local model (one-time download from
  Hugging Face into `~/.recall/models`; after that the network is never used).
- The daemon binds localhost by default. If you opt into `RECALL_BIND=0.0.0.0`
  for Siri, non-localhost requests require a bearer token, and using Tailscale
  keeps traffic end-to-end encrypted between your own devices.
- Transcripts can contain secrets. They stay in `~/.recall/memory.db` on your
  machine. Redaction-on-ingest is on the roadmap ahead of any sync feature.

## Development

```bash
git clone https://github.com/CarterH2101/recall
cd recall
npm install
npm test                 # build + node:test suite
npm run setup            # install this checkout as the runtime
npm run bundle-plugin    # regenerate committed plugin bundles (CI checks freshness)
```

## Roadmap

- **Codex CLI capture adapter** — makes memory cross-agent, not just
  cross-session.
- Secret redaction on ingest.
- Retrieval-quality eval harness (measured, regression-gated retrieval changes).
- Distilled durable facts, promoted from raw history.
- Local memory viewer UI.
- Cursor / Gemini CLI adapters.
- Optional E2E-encrypted team sync (facts only, opt-in, redaction-gated).

## License

MIT
