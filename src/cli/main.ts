#!/usr/bin/env node
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// recalld — single dispatcher bin. Subcommand modules are imported lazily so
// `recalld --version` doesn't load the embedding stack.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HELP = `recalld — local-first memory for your coding agents

Usage: recalld <command> [options]

  setup            Install/update the runtime, shims, hooks; start the daemon
                   (--runtime-only, --no-backfill, --from <spec>)
  daemon           Run the daemon in the foreground
  status           Show install + daemon + database status
  doctor           Diagnose common problems, with fix hints
  update           Update the ~/.recall/app runtime to the latest release
  uninstall        Remove hooks, shims, autostart, runtime (--purge: data too)
  autostart on|off Start the daemon at login (schtasks/launchd/systemd)

  backfill         Index existing transcripts (--source claude-code|codex|all)
  redact           Retro-clean secrets from stored turns (--dry-run|--backfill)
  eval             Retrieval-quality harness (run|seed|label|build-fixture)
  distill          Promote durable facts from raw history (dry-run; --apply)
  facts            Manage distilled facts (list|add|edit|pin|archive|rm)
  sync             Team sync (init|join|now|push|pull|status|share|unshare)
  mcp              Run the MCP stdio server
  install-hooks    (Re)register Claude Code hooks only
  reproject        Recompute project labels after config changes
  prune-noise      Remove junk vectors from the index
  ingest-granola   Ingest Granola meeting notes

  --version        Print version
`;

function forward(script: string, args: string[]): never {
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
    stdio: "inherit",
  });
  process.exit(r.status ?? 1);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "--version":
    case "-v": {
      const { VERSION } = await import("../lib/version.js");
      console.log(VERSION);
      return;
    }
    case "setup": {
      const m = await import("./setup.js");
      return m.run(rest);
    }
    case "daemon": {
      await import("../daemon/server.js"); // self-starting
      return;
    }
    case "mcp": {
      await import("../mcp/server.js"); // self-starting
      return;
    }
    case "status": {
      const m = await import("./status.js");
      return m.run();
    }
    case "doctor": {
      const m = await import("./doctor.js");
      return m.run();
    }
    case "update": {
      const m = await import("./update.js");
      return m.run();
    }
    case "uninstall": {
      const m = await import("./uninstall.js");
      return m.run(rest);
    }
    case "autostart": {
      const m = await import("./autostart.js");
      return m.run(rest);
    }
    case "install-hooks": {
      const m = await import("./install-hooks.js");
      return m.run();
    }
    case "eval": {
      const m = await import("./eval.js");
      return m.run(rest);
    }
    case "sync": {
      const m = await import("./sync.js");
      return m.run(rest);
    }
    case "distill": {
      const m = await import("./distill.js");
      return m.run(rest);
    }
    case "facts": {
      const m = await import("./facts.js");
      return m.run(rest);
    }
    case "redact": {
      const m = await import("./redact-backfill.js");
      return m.run(rest);
    }
    case "backfill":
      return forward("backfill.js", rest);
    case "reproject":
      return forward("reproject.js", rest);
    case "prune-noise":
      return forward("prune-noise.js", rest);
    case "ingest-granola":
      return forward("ingest-granola.js", rest);
    default:
      console.log(HELP);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
