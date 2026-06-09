# Ask your memory by voice — Siri setup

Talk to your agent memory from your iPhone: **"Hey Siri, Ask Recall"** → dictate
a question → Siri speaks back what your past coding sessions said.

No app install, no App Store, no cloud. Your phone talks directly to the
`recalld` daemon on your computer. Two network options below; Tailscale is
recommended because it works anywhere and stays end-to-end encrypted between
your own devices.

## 1. Expose the daemon to your phone

By default `recalld` listens on `127.0.0.1` only. To let your phone reach it,
set a bind address and restart the daemon:

```
# Windows (set as a user environment variable so it persists)
setx RECALL_BIND 0.0.0.0
```

Then restart the daemon (kill the `node ... daemon/server.js` process, or just
reboot — the hooks respawn it). Any request that isn't from localhost now
requires your API token (printed by `npm run setup`, or read
`~/.recall/token`).

**Option A — Tailscale (recommended):**
1. Install Tailscale on your computer and iPhone, sign in to the same tailnet.
2. Note your computer's Tailscale IP (e.g. `100.x.y.z`).
3. Your endpoint is `http://100.x.y.z:4319/ask` — reachable from anywhere,
   traffic never touches a third-party server.

**Option B — same Wi-Fi:**
1. Find your computer's LAN IP (`ipconfig` → IPv4, e.g. `192.168.1.50`).
2. Your endpoint is `http://192.168.1.50:4319/ask` — works only at home.
3. Windows will show a firewall prompt the first time the daemon binds — allow
   it on Private networks.

## 2. Build the Shortcut (≈3 minutes, once)

On your iPhone, open **Shortcuts** → **+** → add these actions in order:

1. **Dictate Text**
   - This is where Siri listens for your question.
2. **Get Contents of URL**
   - URL: `http://<YOUR-IP>:4319/ask`
   - Method: **POST**
   - Headers: `Authorization` = `Bearer <YOUR-TOKEN>`
   - Request Body: **JSON**, one field: `q` = *Dictated Text* (the variable
     from step 1)
3. **Get Dictionary Value**
   - Get value for key: `answer` in *Contents of URL*
4. **Speak Text**
   - Text: *Dictionary Value*

Name the shortcut **Ask Recall** (the name is the voice trigger).

## 3. Use it

> "Hey Siri, Ask Recall"
> *"what did I decide about the BenAI rate escalation rules?"*

Siri speaks back the most relevant turns from your past sessions, with when and
which project they came from.

## Tuning

| Env var | Default | Meaning |
|---|---|---|
| `RECALL_BIND` | `127.0.0.1` | Set `0.0.0.0` to allow phone access (token required) |
| `RECALL_ASK_MIN_SCORE` | `0.45` | Min similarity before /ask will use a snippet |

## Notes & limits

- Answers are stitched from your actual transcript turns — they are recalled,
  not re-written. Expect "what you said then," not a polished summary.
- `/ask` returns at most ~600 characters so Siri doesn't read you an essay.
- If nothing clears the relevance bar, Siri says it couldn't find anything —
  that's the threshold working, not a bug.
