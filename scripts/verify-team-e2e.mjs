// Team sync v2 end-to-end verification. Three isolated "machines" (child
// processes with their own USERPROFILE/.recall) against a real hub:
// create → invite → pending join → admin approval → attributed sync →
// rotation → stale-gen retry → revocation → v1 upgrade with history.
// Usage: node scripts/verify-team-e2e.mjs
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const REPO = path.dirname(path.dirname(SELF));
const mod = (p) => pathToFileURL(path.join(REPO, p)).href;

/* ---------------- child mode ---------------- */
if (process.argv[2] === "step") {
  const step = process.argv[3];
  const env = process.env;
  const team = await import(mod("dist/lib/team.js"));
  const sync = await import(mod("dist/lib/sync.js"));
  const facts = await import(mod("dist/lib/facts.js"));
  const { getDb } = await import(mod("dist/lib/db.js"));
  const db = getDb();
  const out = {};

  const cfg = () => sync.loadSyncConfig();

  if (step === "a-init") {
    const c = await team.createTeamV2(env.HUB_URL, "e2e", "Alice");
    out.teamId = c.teamId;
    out.memberId = c.memberId;
    out.invite = await team.issueInvite(c);
  } else if (step === "join") {
    const c = await team.joinTeamV2(env.INVITE, env.MY_NAME);
    out.memberId = c.memberId;
    const s = await team.refreshTeamState(c);
    out.status = s.status;
  } else if (step === "admin-sync") {
    const r = await team.syncNow();
    out.approved = r.approved ?? 0;
  } else if (step === "check-active") {
    const c = cfg();
    const s = await team.refreshTeamState(c);
    out.status = s.status;
    out.gens = Object.keys(c.gens);
    out.members = db.prepare(`SELECT member_id, name, status FROM team_members ORDER BY name`).all();
  } else if (step === "share-push") {
    const r = await facts.addFact({ kind: "decision", content: env.FACT_CONTENT, origin: "manual" });
    db.prepare(`UPDATE facts SET shared = 1, version = version + 1 WHERE id = ?`).run(r.id);
    const c = cfg();
    await team.refreshTeamState(c);
    if (c.isAdmin) await team.drainPending(c);
    out.push = await team.pushV2(c);
    out.factId = r.id;
  } else if (step === "stale-push") {
    // Deliberately DO NOT refresh: our cfg still has the old generation, so
    // the hub must 409 and pushV2 must self-heal and retry.
    const r = await facts.addFact({ kind: "gotcha", content: env.FACT_CONTENT, origin: "manual" });
    db.prepare(`UPDATE facts SET shared = 1, version = version + 1 WHERE id = ?`).run(r.id);
    const c = cfg();
    out.genBefore = c.currentGen;
    out.push = await team.pushV2(c);
    out.genAfter = c.currentGen;
  } else if (step === "pull") {
    const c = cfg();
    await team.refreshTeamState(c);
    out.pull = await team.pullV2(c);
    const f = env.FACT_ID ? db.prepare(`SELECT * FROM facts WHERE id = ?`).get(env.FACT_ID) : null;
    out.fact = f ? { content: f.content, origin_member: f.origin_member } : null;
    if (f?.origin_member) {
      out.originName = db.prepare(`SELECT name FROM team_members WHERE member_id = ?`).get(f.origin_member)?.name ?? null;
    }
  } else if (step === "rotate") {
    out.gen = await team.rotateTeam(cfg());
  } else if (step === "revoke") {
    out.gen = await team.rotateTeam(cfg(), env.TARGET_MEMBER);
  } else if (step === "expect-401") {
    try {
      await team.refreshTeamState(cfg());
      out.error = "no error";
    } catch (e) {
      out.error = String(e.status ?? e.message);
    }
  } else if (step === "new-invite") {
    const c = cfg();
    await team.refreshTeamState(c);
    out.invite = await team.issueInvite(c);
  } else if (step === "v1-init") {
    // Old-style team: bearer token + shared key, one v1 op pushed.
    const res = await fetch(`${env.HUB_URL}/v1/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "v1-e2e" }),
    });
    const { teamId, token } = await res.json();
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 11) % 256)).toString("base64");
    const v1 = { serverUrl: env.HUB_URL, teamId, token, key, deviceId: "device-v1" };
    sync.saveSyncConfig(v1);
    const r = await facts.addFact({ kind: "reference", content: "v1-era fact: the legacy hub port was 8787", origin: "manual" });
    db.prepare(`UPDATE facts SET shared = 1, version = version + 1 WHERE id = ?`).run(r.id);
    out.push = await sync.push(v1);
    out.teamId = teamId;
  } else if (step === "v1-upgrade") {
    const c = await team.upgradeFromV1(cfg(), "Dana");
    out.memberId = c.memberId;
    out.gen = c.currentGen; // should be 2 (auto-rotate after upgrade)
    out.invite = await team.issueInvite(c);
  }

  console.log("###" + JSON.stringify(out));
  process.exit(0);
}

/* ---------------- parent mode ---------------- */
const HUB_DIR = process.env.SYNC_SERVER_DIR ?? "C:/Users/carter/Documents/Claude/Carter/Projects/recall-sync-server";
const PORT = 8901;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recall-team-e2e-"));
const machines = {};
for (const m of ["a", "b", "c", "d", "e"]) {
  machines[m] = path.join(tmp, m);
  fs.mkdirSync(path.join(machines[m], ".recall"), { recursive: true });
}

const hub = spawn(process.execPath, [path.join(HUB_DIR, "dist", "server.js")], {
  env: { ...process.env, SYNC_PORT: String(PORT), SYNC_DB_PATH: path.join(tmp, "hub.db"), SYNC_BIND: "127.0.0.1" },
  stdio: ["ignore", "ignore", "pipe"],
});
await new Promise((r) => setTimeout(r, 1500));
const HUB_URL = `http://127.0.0.1:${PORT}`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

function on(machine, step, extraEnv = {}) {
  let out;
  const env = {
    ...process.env,
    USERPROFILE: machines[machine],
    HOME: machines[machine],
    RECALL_DB_PATH: path.join(machines[machine], ".recall", "memory.db"),
    RECALL_MODEL_DIR: path.join(os.homedir(), ".recall", "models"),
    HUB_URL,
    ...extraEnv,
  };
  try {
    out = execFileSync(process.execPath, [SELF, "step", step], { encoding: "utf8", env });
  } catch (e) {
    out = e.stdout ?? "";
    if (!out.includes("###")) {
      console.error(e.stderr ?? e.message);
      throw e;
    }
  }
  return JSON.parse(out.split("###").pop());
}

/* --- create + join + approve --- */
const a = on("a", "a-init");
check("A created v2 team + invite", !!a.teamId && !!a.invite);

const b = on("b", "join", { INVITE: a.invite, MY_NAME: "Bob" });
check("B lands pending", b.status === "pending", JSON.stringify(b));

const approve = on("a", "admin-sync");
check("A's sync approves B", approve.approved === 1);

const bActive = on("b", "check-active");
check("B is active with gen-1 key", bActive.status === "active" && bActive.gens.includes("1"), JSON.stringify(bActive.gens));
check(
  "B sees member names from the E2E chain",
  bActive.members.some((m) => m.name === "Alice") && bActive.members.some((m) => m.name === "Bob"),
  JSON.stringify(bActive.members.map((m) => m.name)),
);

/* --- attributed sync --- */
const ap = on("a", "share-push", { FACT_CONTENT: "we standardized on jittered backoff for reconnect storms" });
check("A pushed with identity", ap.push.sent === 1, JSON.stringify(ap.push));

const bp = on("b", "pull", { FACT_ID: ap.factId });
check("B pulled + attributed to Alice", bp.pull.applied === 1 && bp.originName === "Alice", JSON.stringify({ o: bp.fact?.origin_member, n: bp.originName }));

/* --- hub opacity: no plaintext, no names --- */
{
  const dump = fs.readFileSync(path.join(tmp, "hub.db"), "latin1");
  check("hub stores no fact plaintext", !dump.includes("jittered backoff"));
  check("hub stores no member names", !dump.includes("Alice") && !dump.includes("Bob"));
}

/* --- rotation + stale-gen self-heal --- */
const rot = on("a", "rotate");
check("A rotated to gen 2", rot.gen === 2);

const stale = on("b", "stale-push", { FACT_CONTENT: "post-rotation gotcha: hub 409s stale generations" });
check("B's stale push self-heals via 409", stale.push.sent === 1 && stale.genBefore === 1 && stale.genAfter === 2, JSON.stringify(stale));

const ap2 = on("a", "pull", {});
check("A pulls B's gen-2 op", ap2.pull.applied === 1, JSON.stringify(ap2.pull));

/* --- revocation --- */
const inv2 = on("a", "new-invite");
const c = on("c", "join", { INVITE: inv2.invite, MY_NAME: "Cleo" });
on("a", "admin-sync");
const cActive = on("c", "check-active");
check("C joined and holds gens 1+2", cActive.status === "active" && cActive.gens.length === 2, JSON.stringify(cActive.gens));

const rev = on("a", "revoke", { TARGET_MEMBER: c.memberId });
check("revoking C rotated to gen 3", rev.gen === 3);

const cAfter = on("c", "expect-401");
check("C's server access is dead", cAfter.error === "401", `got ${cAfter.error}`);

const bAfterRevoke = on("b", "check-active");
check("B unaffected, holds gen 3", bAfterRevoke.status === "active" && bAfterRevoke.gens.includes("3"), JSON.stringify(bAfterRevoke.gens));

/* --- v1 → v2 upgrade with history --- */
const d1 = on("d", "v1-init");
check("v1 team seeded with a legacy op", d1.push.sent === 1);

const up = on("d", "v1-upgrade");
check("upgrade self-elects admin + auto-rotates to gen 2", up.gen === 2, JSON.stringify(up));

const e1 = on("e", "join", { INVITE: up.invite, MY_NAME: "Evan" });
on("d", "admin-sync");
const ePull = on("e", "pull", {});
check(
  "post-upgrade joiner reads v1-era history",
  ePull.pull.applied >= 1,
  JSON.stringify(ePull.pull),
);
void e1;

hub.kill();
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} FAILED` : "\nall team v2 e2e checks passed");
process.exit(failed ? 1 : 0);
