---
description: One-time recall runtime setup — installs the local memory engine and indexes your history
---

Finish setting up the recall plugin's local runtime. Do exactly this:

1. Run `npx recalld@latest setup --runtime-only --yes` in the terminal and show
   the user its progress. This installs recall's local runtime (~550MB of
   dependencies, mostly the on-device embedding engine) to `~/.recall/app`,
   downloads a ~130MB embedding model once, indexes existing Claude Code
   transcripts, and starts the local daemon. Nothing is uploaded anywhere —
   storage, embeddings, and search are all local. `--runtime-only` is
   important: the plugin already provides the hooks, so setup must NOT write
   hooks into `~/.claude/settings.json`.
2. If the user previously installed recall from a git clone, the old
   clone-era hook entries in `~/.claude/settings.json` are stale. Run
   `npx recalld@latest install-hooks` ONLY if the user says they had a clone
   install AND they are not using this plugin's hooks — otherwise leave
   settings.json alone.
3. When setup finishes, run `npx recalld@latest doctor` and summarize the
   result for the user. Tell them memory activates for new sessions, and that
   `recalld status` shows what's captured.
