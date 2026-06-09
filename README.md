# recall

**Local-first memory for your coding agents — with voice access via Siri.**

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

## Install (the easy way)

Paste this into **Claude Code**:

```
Clone https://github.com/CarterH2101/recall, then inside it run
`npm install` and `npm run setup`, and show me the final status output.
```

That's it. Your agent installs its own memory: it indexes your existing
transcripts (one-time ~130MB local model download), registers the capture +
auto-recall hooks, and starts the local daemon. Restart your Claude Code
session and you'll see `🧠 recall: injected N snippets…` when past context is
found.

<details>
<summary>Manual install</summary>

```bash
git clone https://github.com/CarterH2101/recall
cd recall
npm install
npm run setup
```

Requires Node 20+. Windows, macOS, and Linux.
</details>

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
  MCP-capable agent: `node <repo>/dist/mcp/server.js`
- **Siri voice access.** A 3-minute Shortcut setup lets you ask your memory
  from anywhere — see **[docs/siri.md](docs/siri.md)**. Phone↔computer over
  your own LAN or Tailscale; token-authed; still no cloud.

## Configuration (env vars, all optional)

| Var | Default | Meaning |
|-----|---------|---------|
| `RECALL_DB_PATH` | `~/.recall/memory.db` | DB file location |
| `RECALL_PORT` | `4319` | Daemon port |
| `RECALL_BIND` | `127.0.0.1` | Set `0.0.0.0` to allow phone access (token required) |
| `RECALL_MODEL` | `Xenova/bge-small-en-v1.5` | Local embedding model |
| `RECALL_ENABLED` | `true` | Set `false` to instantly disable auto-inject |
| `RECALL_MIN_SCORE` | `0.4` | Min similarity for auto-injected snippets |
| `RECALL_ASK_MIN_SCORE` | `0.45` | Min similarity for Siri `/ask` answers |

## Uninstall

Remove the two `recall` entries from `hooks` in `~/.claude/settings.json`
(timestamped `.bak` backups were created at install), kill the `recalld`
process, and delete `~/.recall/`.

## Privacy model, stated plainly

- Capture reads transcript files Claude Code already writes to your disk.
- Embeddings run in-process with a local model (one-time download from
  Hugging Face; after that the network is never used).
- The daemon binds localhost by default. If you opt into `RECALL_BIND=0.0.0.0`
  for Siri, non-localhost requests require a bearer token, and using Tailscale
  keeps traffic end-to-end encrypted between your own devices.
- Transcripts can contain secrets. They stay in `~/.recall/memory.db` on your
  machine. Redaction-on-ingest is on the roadmap ahead of any sync feature.

## Roadmap

- **Codex CLI capture adapter** — makes memory cross-agent, not just
  cross-session.
- Cursor / Gemini CLI adapters.
- Secret redaction on ingest.
- Optional E2E-encrypted multi-machine sync.
- Long-turn chunking for finer retrieval.

## License

MIT
