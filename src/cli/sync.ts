import { randomUUID } from "node:crypto";
import { getDb } from "../lib/db.js";
import {
  decodeInvite,
  encodeInvite,
  loadSyncConfig,
  push,
  pull,
  saveSyncConfig,
  syncConfigPath,
} from "../lib/sync.js";

// recalld sync init --server <url> [--name team]   create a team, print invite
// recalld sync join <invite>                       join from an invite code
// recalld sync push|pull|now                       move facts (now = both)
// recalld sync status
// recalld sync share <fact-id-prefix> [--allow-secret] | share --project P --all
// recalld sync unshare <fact-id-prefix>

function requireConfig() {
  const cfg = loadSyncConfig();
  if (!cfg) {
    console.error("Not in a team yet — `recalld sync init --server <url>` or `recalld sync join <invite>`.");
    process.exit(1);
  }
  return cfg;
}

function arg(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

async function factByPrefix(prefix: string) {
  const db = getDb();
  const rows = db.prepare(`SELECT id FROM facts WHERE id LIKE ?`).all(`${prefix}%`) as any[];
  if (rows.length !== 1) {
    console.error(rows.length ? `ambiguous prefix (${rows.length} matches)` : "no such fact");
    process.exit(1);
  }
  return rows[0].id as string;
}

export async function run(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const db = getDb();

  if (sub === "init") {
    const server = arg(rest, "--server");
    if (!server) {
      console.error("Usage: recalld sync init --server https://sync.example.com [--name myteam]");
      process.exit(1);
    }
    const res = await fetch(`${server.replace(/\/$/, "")}/v1/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: arg(rest, "--name") ?? undefined }),
    });
    if (!res.ok) {
      console.error(`team creation failed: ${res.status} ${await res.text()}`);
      process.exit(1);
    }
    const { teamId, token } = (await res.json()) as any;
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    saveSyncConfig({ serverUrl: server, teamId, token, key, deviceId: randomUUID() });
    console.log(`Team created. Config at ${syncConfigPath()} (mode 600).\n`);
    console.log(`Invite (SECRET — whoever holds it can read/write team memory):\n`);
    console.log(encodeInvite({ serverUrl: server, teamId, token, key }));
    return;
  }

  if (sub === "join") {
    if (!rest[0]) {
      console.error("Usage: recalld sync join <invite>");
      process.exit(1);
    }
    const base = decodeInvite(rest[0]);
    saveSyncConfig({ ...base, deviceId: randomUUID() });
    console.log(`Joined team ${base.teamId}. Run \`recalld sync now\` to sync.`);
    return;
  }

  if (sub === "push" || sub === "pull" || sub === "now") {
    const cfg = requireConfig();
    if (sub !== "pull") {
      const r = await push(cfg);
      console.log(`push: ${r.sent} sent, ${r.deduped} deduped`);
      for (const b of r.blocked) {
        console.log(
          `  BLOCKED ${b.factId.slice(0, 8)} — redaction hit (${b.spans.join(", ")}); ` +
            `edit the fact, or re-share with: recalld sync share ${b.factId.slice(0, 8)} --allow-secret`,
        );
      }
    }
    if (sub !== "push") {
      const r = await pull(cfg);
      console.log(
        `pull: ${r.applied} applied${r.conflicts ? ` (${r.conflicts} conflict cop${r.conflicts === 1 ? "y" : "ies"})` : ""}, up to seq ${r.upTo}`,
      );
    }
    return;
  }

  if (sub === "status") {
    const cfg = loadSyncConfig();
    if (!cfg) return console.log("sync: not configured");
    const state = db.prepare(`SELECT * FROM sync_state WHERE team_id = ?`).get(cfg.teamId) as any;
    const shared = (db.prepare(`SELECT COUNT(*) n FROM facts WHERE shared > 0`).get() as any).n;
    const pending = (
      db.prepare(`SELECT COUNT(*) n FROM facts WHERE shared > 0 AND version > synced_version`).get() as any
    ).n;
    console.log(`server:   ${cfg.serverUrl}`);
    console.log(`team:     ${cfg.teamId}`);
    console.log(`device:   ${cfg.deviceId}`);
    console.log(`shared:   ${shared} fact(s), ${pending} pending push`);
    console.log(`pulled:   seq ${state?.last_seq ?? 0}${state?.last_sync ? ` at ${state.last_sync}` : ""}`);
    return;
  }

  if (sub === "share") {
    const level = rest.includes("--allow-secret") ? 2 : 1;
    if (rest.includes("--all")) {
      const project = arg(rest, "--project");
      const where = project ? `project = ?` : `1=1`;
      const rows = db
        .prepare(`SELECT id, content FROM facts WHERE archived = 0 AND shared = 0 AND ${where}`)
        .all(...(project ? [project] : [])) as any[];
      if (!rows.length) return console.log("nothing to share");
      console.log(`Sharing ${rows.length} fact(s):`);
      for (const r of rows) console.log(`  ${r.id.slice(0, 8)} ${r.content.slice(0, 80)}`);
      db.prepare(`UPDATE facts SET shared = ?, version = version + 1 WHERE archived = 0 AND shared = 0 AND ${where}`).run(
        ...(project ? [level, project] : [level]),
      );
      console.log("Marked. Run `recalld sync push`.");
      return;
    }
    const id = await factByPrefix(rest[0] ?? "");
    db.prepare(`UPDATE facts SET shared = ?, version = version + 1 WHERE id = ?`).run(level, id);
    console.log(`shared${level === 2 ? " (secret override)" : ""} — run: recalld sync push`);
    return;
  }

  if (sub === "unshare") {
    const id = await factByPrefix(rest[0] ?? "");
    db.prepare(`UPDATE facts SET shared = 0 WHERE id = ?`).run(id);
    console.log("unshared (stops future pushes; already-synced copies remain with the team)");
    return;
  }

  console.log(
    "Usage: recalld sync init --server <url> | join <invite> | now | push | pull | status | share <id> [--allow-secret] | share --all [--project P] | unshare <id>",
  );
  process.exit(1);
}
