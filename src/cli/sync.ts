import os from "node:os";
import { getDb } from "../lib/db.js";
import { loadSyncConfig, push as pushV1, pull as pullV1, syncConfigPath } from "../lib/sync.js";
import {
  createTeamV2,
  drainPending,
  isV2,
  issueInvite,
  joinTeamV2,
  pullV2,
  pushV2,
  refreshTeamState,
  rotateTeam,
  syncNow,
  syncStatusV2,
  upgradeFromV1,
} from "../lib/team.js";

// recalld sync init --server <url> [--name team] [--me displayName]
// recalld sync join <invite> [--me displayName]
// recalld sync invite                              (admin) print a fresh invite
// recalld sync now | push | pull
// recalld sync rotate                              (admin) new key generation
// recalld sync revoke <member-id-prefix>           (admin) revoke + rotate
// recalld sync upgrade [--me displayName]          v1 team -> v2 identity
// recalld sync status
// recalld sync share <fact-id-prefix> [--allow-secret] | share --all [--project P]
// recalld sync unshare <fact-id-prefix>

function arg(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function requireConfig(): any {
  const cfg = loadSyncConfig();
  if (!cfg) {
    console.error("Not in a team yet — `recalld sync init --server <url>` or `recalld sync join <invite>`.");
    process.exit(1);
  }
  return cfg;
}

function requireV2Admin(cfg: any) {
  if (!isV2(cfg) || !cfg.isAdmin) {
    console.error("This command needs a v2 team admin. (v1 team? run: recalld sync upgrade)");
    process.exit(1);
  }
  return cfg;
}

async function factByPrefix(prefix: string): Promise<string> {
  const rows = getDb().prepare(`SELECT id FROM facts WHERE id LIKE ?`).all(`${prefix}%`) as any[];
  if (rows.length !== 1) {
    console.error(rows.length ? `ambiguous prefix (${rows.length} matches)` : "no such fact");
    process.exit(1);
  }
  return rows[0].id as string;
}

function memberByPrefix(prefix: string): string {
  const rows = getDb()
    .prepare(`SELECT member_id FROM team_members WHERE member_id LIKE ? AND status != 'revoked'`)
    .all(`${prefix}%`) as any[];
  if (rows.length !== 1) {
    console.error(rows.length ? `ambiguous member prefix (${rows.length} matches)` : "no such member (see: recalld sync status)");
    process.exit(1);
  }
  return rows[0].member_id as string;
}

function printPushPull(push: any, pull: any): void {
  console.log(`push: ${push.sent} sent, ${push.deduped} deduped`);
  for (const b of push.blocked ?? []) {
    console.log(
      `  BLOCKED ${b.factId.slice(0, 8)} — redaction hit (${b.spans.join(", ")}); ` +
        `edit the fact, or re-share with: recalld sync share ${b.factId.slice(0, 8)} --allow-secret`,
    );
  }
  console.log(
    `pull: ${pull.applied} applied${pull.conflicts ? ` (${pull.conflicts} conflict cop${pull.conflicts === 1 ? "y" : "ies"})` : ""}, up to seq ${pull.upTo}`,
  );
}

export async function run(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const db = getDb();

  if (sub === "init") {
    const server = arg(rest, "--server");
    if (!server) {
      console.error("Usage: recalld sync init --server https://hub.example.com [--name myteam] [--me Carter]");
      process.exit(1);
    }
    if (loadSyncConfig()) {
      console.error(`Already in a team (${syncConfigPath()}). Remove that file first if you mean it.`);
      process.exit(1);
    }
    const me = arg(rest, "--me") ?? os.userInfo().username;
    const cfg = await createTeamV2(server, arg(rest, "--name") ?? "team", me, arg(rest, "--token") ?? undefined);
    console.log(`Team created (${cfg.teamId}). You are the admin (${cfg.memberId}).`);
    console.log(`Config at ${syncConfigPath()} (mode 600) — the admin key lives there; backing it up is on you.\n`);
    const invite = await issueInvite(cfg);
    console.log(`Invite (SECRET — single use, 7 days):\n\n${invite}`);
    return;
  }

  if (sub === "join") {
    if (!rest[0]) {
      console.error("Usage: recalld sync join <invite> [--me displayName]");
      process.exit(1);
    }
    // v2 invite codes decode to {u,t,a,j}; v1 to {u,t,k,K}.
    const decoded = JSON.parse(Buffer.from(rest[0].trim(), "base64url").toString("utf8"));
    if (decoded.a && decoded.j) {
      const cfg = await joinTeamV2(rest[0], arg(rest, "--me") ?? undefined);
      console.log(
        `Join requested as ${cfg.name} (${cfg.memberId}) — pending until the team admin's next sync approves you.\n` +
          `Run \`recalld sync now\` in a bit to check.`,
      );
    } else {
      const { decodeInvite, saveSyncConfig } = await import("../lib/sync.js");
      const base = decodeInvite(rest[0]);
      saveSyncConfig({ ...base, deviceId: crypto.randomUUID() });
      console.log(`Joined v1 team ${base.teamId}. (Consider asking the admin to run: recalld sync upgrade)`);
    }
    return;
  }

  if (sub === "invite") {
    const cfg = requireV2Admin(requireConfig());
    console.log(await issueInvite(cfg));
    return;
  }

  if (sub === "now") {
    requireConfig();
    const r = await syncNow();
    if (!r) return;
    if (r.approved) console.log(`approved ${r.approved} pending member${r.approved === 1 ? "" : "s"}`);
    printPushPull(r.push, r.pull);
    return;
  }

  if (sub === "push" || sub === "pull") {
    const cfg = requireConfig();
    if (isV2(cfg)) {
      const state = await refreshTeamState(cfg);
      if (state.status === "pending") return console.log("still pending admin approval");
      if (cfg.isAdmin) await drainPending(cfg);
      if (sub === "push") {
        const p = await pushV2(cfg);
        printPushPull(p, { applied: 0, conflicts: 0, upTo: "-" });
      } else {
        const p = await pullV2(cfg);
        printPushPull({ sent: 0, deduped: 0, blocked: [] }, p);
      }
    } else {
      if (sub === "push") printPushPull(await pushV1(cfg), { applied: 0, conflicts: 0, upTo: "-" });
      else printPushPull({ sent: 0, deduped: 0, blocked: [] }, await pullV1(cfg));
    }
    return;
  }

  if (sub === "rotate") {
    const cfg = requireV2Admin(requireConfig());
    const gen = await rotateTeam(cfg);
    console.log(`rotated to key generation ${gen} — new content is invisible to anyone without the new lockbox`);
    return;
  }

  if (sub === "revoke") {
    const cfg = requireV2Admin(requireConfig());
    if (!rest[0]) {
      console.error("Usage: recalld sync revoke <member-id-prefix>");
      process.exit(1);
    }
    const memberId = memberByPrefix(rest[0]);
    if (memberId === cfg.memberId) {
      console.error("You are the admin — you cannot revoke yourself.");
      process.exit(1);
    }
    const gen = await rotateTeam(cfg, memberId);
    console.log(
      `revoked ${memberId.slice(0, 10)}… — server access is off now, and generation ${gen} is invisible to them.\n` +
        `(They keep what they already pulled; that's physics, not a bug.)`,
    );
    return;
  }

  if (sub === "upgrade") {
    const cfg = requireConfig();
    if (isV2(cfg)) return console.log("already a v2 team");
    const me = arg(rest, "--me") ?? os.userInfo().username;
    const v2 = await upgradeFromV1(cfg, me);
    console.log(
      `Upgraded to v2. You are the admin (${v2.memberId}); the old shared token is dead and the team is on key generation ${v2.currentGen}.\n` +
        `Teammates rejoin with: recalld sync join <invite> — issue invites via: recalld sync invite`,
    );
    return;
  }

  if (sub === "status") {
    const cfg = loadSyncConfig() as any;
    if (!cfg) return console.log("sync: not configured");
    console.log(`server:   ${cfg.serverUrl}`);
    console.log(`team:     ${cfg.teamId}`);
    if (isV2(cfg)) {
      const s = syncStatusV2(cfg);
      console.log(`you:      ${cfg.name} (${cfg.memberId})${cfg.isAdmin ? " — admin" : ""}${cfg.pending ? " — PENDING" : ""}`);
      console.log(`keys:     generation ${s.currentGen} (${Object.keys(cfg.gens).length} held)`);
      console.log(`chain:    seq ${s.recordsHead.seq} · head ${s.recordsHead.hash.slice(0, 16)}…  (compare out-of-band to detect a split view)`);
      console.log(`members:`);
      for (const m of s.members) {
        console.log(`  ${m.status === "revoked" ? "✗" : "•"} ${(m.name ?? "(unnamed)").padEnd(20)} ${m.member_id.slice(0, 10)}… ${m.role}${m.status === "revoked" ? " (revoked)" : ""}`);
      }
    } else {
      console.log(`device:   ${cfg.deviceId} (v1 team — run \`recalld sync upgrade\` for member identity)`);
    }
    const shared = (db.prepare(`SELECT COUNT(*) n FROM facts WHERE shared > 0`).get() as any).n;
    const pending = (db.prepare(`SELECT COUNT(*) n FROM facts WHERE shared > 0 AND version > synced_version`).get() as any).n;
    console.log(`shared:   ${shared} fact(s), ${pending} pending push`);
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
      console.log("Marked. Run `recalld sync now`.");
      return;
    }
    const id = await factByPrefix(rest[0] ?? "");
    db.prepare(`UPDATE facts SET shared = ?, version = version + 1 WHERE id = ?`).run(level, id);
    console.log(`shared${level === 2 ? " (secret override)" : ""} — run: recalld sync now`);
    return;
  }

  if (sub === "unshare") {
    const id = await factByPrefix(rest[0] ?? "");
    db.prepare(`UPDATE facts SET shared = 0 WHERE id = ?`).run(id);
    console.log("unshared (stops future pushes; already-synced copies remain with the team)");
    return;
  }

  console.log(
    "Usage: recalld sync init --server <url> [--name t] [--me n] | join <invite> [--me n] | invite | now | push | pull |\n" +
      "       rotate | revoke <member> | upgrade [--me n] | status | share <id> [--allow-secret] | share --all [--project P] | unshare <id>",
  );
  process.exit(1);
}
