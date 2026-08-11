# recall

**Local-first memory for your coding agents — cross-session and cross-agent.**

<img src="https://raw.githubusercontent.com/CarterH2101/recall/main/assets/demo.svg" alt="recall demo: one-command install, past context injected into new prompts, cross-agent memory between Codex and Claude Code, and secret redaction" width="880">


Your AI coding sessions are full of decisions, approaches, and answers that
evaporate the moment the session ends. `recall` captures your **Claude Code
and Codex CLI** sessions, indexes them **entirely on your own machine**, and:

- **auto-injects** relevant past context into every new prompt (your agent
  remembers what you did last week — even if you did it in a different agent),
- **redacts secrets** before anything is stored or embedded,
- **distills** durable facts (decisions, gotchas, conventions) out of raw
  history and ranks them first,
- and gives any agent an explicit **`recall` MCP tool** ("what did I conclude
  about X?").

**Nothing ever leaves your machine.** Storage, embeddings, and search are all
local. No cloud, no account, no API key. Your transcripts already sit on your
disk — this just makes them useful.

> **1.0.** Captures Claude Code and Codex CLI today; Cursor is next. Retrieval
> quality is regression-gated by an eval harness in CI — changes are measured,
> not vibed.

## Install

```bash
npx recalld@latest setup
```

That's it. One command installs the runtime to `~/.recall/app` (~550MB of
dependencies — the on-device embedding engine is most of it), downloads a
~130MB embedding model once, indexes your existing Claude Code transcripts,
registers the hooks, and starts the local daemon. Restart your Claude Code
session and you'll see `🧠 recall: injected N snippets…` when past context is
found.

If you use Codex CLI, new sessions are captured automatically (the daemon
watches `~/.codex/sessions`); index older Codex history once with
`recalld backfill --source codex`.

**Or install as a Claude Code plugin:**

```
/plugin marketplace add CarterH2101/recall
/plugin install recall@recall
/recall:setup
```

The plugin registers the hooks and the MCP tool declaratively; `/recall:setup`
installs the runtime.

Requires Node 20.11+ on macOS and Linux, Node 22+ on Windows (better-sqlite3
ships no Windows prebuilds for Node 20). x64/arm64; Windows-on-ARM and Alpine
are not supported yet — sqlite-vec has no prebuilds there.

## What you get

```
Claude Code ──Stop hook──────────► recalld (local daemon, 127.0.0.1)
            ──UserPromptSubmit────►   • warm local embedding model
                  │                    • SQLite + sqlite-vec (one file: ~/.recall/memory.db)
                  ▼                    • secret redaction before storage
        injected context               • /ingest /recall /ui
                                     ▲               ▲
 Codex CLI ── rollout watcher ───────┘               │
 Any agent ── stdio MCP ─────────────────────────────┘
```

- **Auto-recall on every prompt.** A `UserPromptSubmit` hook vector-searches
  your past sessions and prepends strong matches (with a visible
  `🧠 recall: …` indicator). Conservative thresholds, hard caps, and strictly
  fail-open: if the daemon is down it injects nothing and your prompt is
  untouched.
- **Silent capture, cross-agent.** A `Stop` hook ingests just the appended
  bytes of Claude Code transcripts; a daemon-side watcher captures Codex CLI
  rollouts. Idempotent — never duplicates, even on 38MB transcripts. Ask
  Claude Code what you did in Codex last week: it knows.
- **Secret redaction before storage — and before embedding.** ~20
  high-precision rules (AWS/GitHub/OpenAI/Anthropic/Slack/Stripe keys, PEM
  blocks, JWTs, connection-string passwords, entropy-gated generics) run at
  ingest, so credentials never enter the database or the vector index.
  Retro-clean an existing database with `recalld redact --dry-run`.
- **Distilled facts.** `recalld distill` promotes durable knowledge
  (decisions, gotchas, preferences, references) out of raw history —
  summarized locally via headless `claude -p` when available, heuristics
  otherwise. Facts are editable/pinnable and rank above raw snippets (📌).
- **A local viewer** at `http://127.0.0.1:4319/ui`: search your memory,
  browse sessions, manage facts, and audit exactly what got injected into
  which prompt (with 👍/👎 labeling that feeds the eval set).
- **MCP tools.** `recall(query, …)` and `recent_sessions()` over stdio for any
  MCP-capable agent: `recalld mcp` (talks to the daemon — no second copy of
  the model in RAM).
- **Self-healing daemon.** Identity handshake, automatic port fallback when
  something else holds 4319, stale-version replacement after upgrades, and
  `recalld doctor` when you want receipts.

## CLI

```
recalld setup            install/update everything (--runtime-only, --no-backfill)
recalld status           install + daemon + database at a glance
recalld doctor           diagnose problems, with fix hints
recalld backfill         index existing transcripts (--source claude-code|codex|all)
recalld redact           retro-clean secrets from stored turns (--dry-run|--backfill)
recalld distill          promote durable facts from history (dry-run; --apply)
recalld facts            manage facts (list|add|edit|pin|archive|rm)
recalld sync             team sync (init|join|now|share|status)
recalld eval             retrieval-quality harness (run|seed|label)
recalld autostart on     start the daemon at login (optional; schtasks/launchd/systemd)
recalld update           update the runtime to the latest release
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
| `RECALL_BIND` | `127.0.0.1` | Set `0.0.0.0` to allow LAN/remote clients (token required) |
| `RECALL_MODEL` | `Xenova/bge-small-en-v1.5` | Local embedding model |
| `RECALL_MODEL_DIR` | `~/.recall/models` | Model cache location |
| `RECALL_ENABLED` | `true` | Set `false` to instantly disable auto-inject |
| `RECALL_MIN_SCORE` | `0.75` | Min similarity for auto-injected snippets |
| `RECALL_ASK_MIN_SCORE` | `0.45` | Min similarity for the daemon's `/ask` short-answer endpoint |
| `RECALL_PROJECT_ROOTS` | — | `path=label;path=label` cwd→project mapping (also `~/.recall/config.json`) |
| `RECALL_DISTILL_CMD` | auto-detects `claude -p` | Local summarizer command for `recalld distill` (any stdin→JSON CLI, e.g. ollama) |
| `RECALL_DEBUG` | — | `1` for daemon request logging (metadata only) |
| `RECALL_PRUNE_CWD` | — | cwd substrings treated as junk by prune-noise |
| `CODEX_HOME` | `~/.codex` | Where Codex CLI keeps its sessions |

## Migrating from a clone install

`npx recalld@latest setup` handles it: legacy hook entries pointing into your
old checkout are scrubbed automatically (a timestamped settings backup is
made first), and your existing database at `~/.recall/memory.db` is picked up
untouched. Delete the old clone afterwards.

## Uninstall

`recalld uninstall` removes the hooks, shims, autostart entry, and runtime.
Your memory database is kept unless you pass `--purge`.

## Privacy model, stated plainly

- Capture reads transcript files your agents (Claude Code, Codex CLI) already
  write to your disk. Codex system prompts and encrypted reasoning blocks are
  never stored.
- Embeddings run in-process with a local model (one-time download from
  Hugging Face into `~/.recall/models`; after that the network is never used).
- The daemon binds localhost by default. If you opt into `RECALL_BIND=0.0.0.0`,
  non-localhost requests require a bearer token — and the viewer plus its
  admin API stay localhost-only even with the token. Use Tailscale if you
  expose it beyond the machine.
- Transcripts can contain secrets, so recall redacts them **before** storage
  and embedding (they never enter the database or the vector index), and the
  same rules hard-gate anything you share via team sync. Databases created
  before redaction existed can be retro-cleaned: `recalld redact --dry-run`,
  then `--backfill` (rewrites, re-embeds, and vacuums so plaintext doesn't
  linger in freed pages). Redaction is high-precision, not a guarantee —
  treat the database like the transcripts it came from.

## Development

```bash
git clone https://github.com/CarterH2101/recall
cd recall
npm install
npm test                 # build + node:test suite
npm run setup            # install this checkout as the runtime
npm run bundle-plugin    # regenerate committed plugin bundles (CI checks freshness)
```

## Team sync (optional)

Pool distilled facts across a team without the server ever reading them:
facts are AES-256-GCM encrypted with a shared team key before leaving your
machine, the hub stores opaque blobs, and teammates re-embed locally —
embeddings never travel. Sharing is per-fact opt-in, raw transcripts never
sync, and a redaction gate hard-blocks anything secret-shaped at push.

```
recalld sync init --server https://your-hub    # create team, print invite
recalld sync join <invite>                     # on a teammate's machine
recalld sync share <fact-id> && recalld sync now
```

Self-host the hub: [recall-sync-server](https://github.com/CarterH2101/recall-sync-server)
(single container, SQLite, BSL 1.1).

## Roadmap

- Cursor / Gemini CLI capture adapters.
- Per-member team identity + key rotation (sync v2).
- Long-turn chunking for finer retrieval.

## License

MIT
