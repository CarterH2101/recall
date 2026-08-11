// R6 end-to-end verification: two "machines" as separate child processes
// (each gets its own RECALL_DB_PATH and module registry) against a real
// local sync hub. Usage: node verify-sync-tmp.mjs
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);

/* ---------------- child mode: run one step on one machine ---------------- */
if (process.argv[2] === "step") {
  const step = process.argv[3];
  const cfg = JSON.parse(process.env.SYNC_CFG);
  const facts = await import("./dist/lib/facts.js");
  const sync = await import("./dist/lib/sync.js");
  const { getDb } = await import("./dist/lib/db.js");
  const db = getDb();
  const out = {};

  if (step === "a-create-push") {
    const r = await facts.addFact({
      kind: "decision",
      content: `we standardized on jittered exponential backoff for reconnect storms (base 500ms cap 30s), decided at ${os.homedir()}\\work`,
      origin: "manual",
    });
    out.factId = r.id;
    db.prepare(`UPDATE facts SET shared = 1, version = version + 1 WHERE id = ?`).run(r.id);
    out.push1 = await sync.push(cfg);
    out.push2 = await sync.push(cfg);
  } else if (step === "b-pull") {
    out.pull = await sync.pull(cfg);
    const f = db.prepare(`SELECT * FROM facts WHERE id = ?`).get(process.env.FACT_ID);
    out.fact = f ? { origin: f.origin, content: f.content } : null;
    out.vecs = db.prepare(`SELECT COUNT(*) n FROM vec_facts`).get().n;
  } else if (step === "b-edit") {
    await facts.editFact(process.env.FACT_ID, "backoff decision: base 1s, cap 60s (B's divergent wording)");
  } else if (step === "a-edit-push") {
    await facts.editFact(process.env.FACT_ID, "backoff decision: base 500ms, cap 30s, FULL jitter (A's wording)");
    out.push = await sync.push(cfg);
  } else if (step === "b-conflict-pull") {
    out.pull = await sync.pull(cfg);
    out.winner = db.prepare(`SELECT content FROM facts WHERE id = ?`).get(process.env.FACT_ID).content;
    out.copies = db.prepare(`SELECT content FROM facts WHERE id LIKE ?`).all(`${process.env.FACT_ID}-conflict-%`).map((r) => r.content);
  } else if (step === "a-secret-push") {
    const r = await facts.addFact({ kind: "reference", content: `staging deploy key ${"AKIA"}IOSFODNN7EXAMPLE lives in vault`, origin: "manual" });
    db.prepare(`UPDATE facts SET shared = 1, version = version + 1 WHERE id = ?`).run(r.id);
    out.push = await sync.push(cfg);
  }
  console.log("###" + JSON.stringify(out));
  process.exit(0);
}

/* ---------------- parent mode: orchestrate ---------------- */
const SERVER_DIR =
  process.env.SYNC_SERVER_DIR ?? "C:/Users/carter/Documents/Claude/Carter/Projects/recall-sync-server";
const PORT = 8899;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recall-sync-e2e-"));
const dirA = path.join(tmp, "a");
const dirB = path.join(tmp, "b");
fs.mkdirSync(dirA, { recursive: true });
fs.mkdirSync(dirB, { recursive: true });

const server = spawn(process.execPath, [path.join(SERVER_DIR, "dist", "server.js")], {
  env: { ...process.env, SYNC_PORT: String(PORT), SYNC_DB_PATH: path.join(tmp, "hub.db"), SYNC_BIND: "127.0.0.1" },
  stdio: ["ignore", "ignore", "pipe"],
});
await new Promise((r) => setTimeout(r, 1500));

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const { teamId, token } = await (
  await fetch(`http://127.0.0.1:${PORT}/v1/teams`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "e2e" }),
  })
).json();
const key = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7) % 256)).toString("base64");
const base = { serverUrl: `http://127.0.0.1:${PORT}`, teamId, token, key };
check("team created on hub", !!teamId && !!token);

function onMachine(dir, device, step, extraEnv = {}) {
  let out;
  try {
    out = execFileSync(process.execPath, [SELF, "step", step], {
      encoding: "utf8",
      env: {
        ...process.env,
        RECALL_DB_PATH: path.join(dir, "memory.db"),
        RECALL_MODEL_DIR: path.join(os.homedir(), ".recall", "models"),
        SYNC_CFG: JSON.stringify({ ...base, deviceId: device }),
        ...extraEnv,
      },
    });
  } catch (e) {
    // onnxruntime teardown can trip a libuv assertion on Windows AFTER the
    // step's work and output are complete — salvage the result marker.
    out = e.stdout ?? "";
    if (!out.includes("###")) throw e;
  }
  return JSON.parse(out.split("###").pop());
}

const a1 = onMachine(dirA, "device-a", "a-create-push");
check("A pushed 1 op", a1.push1.sent === 1, JSON.stringify(a1.push1));
check("re-push is a no-op (state diff)", a1.push2.sent === 0 && a1.push2.blocked.length === 0);
const factId = a1.factId;

const ops = await (
  await fetch(`http://127.0.0.1:${PORT}/v1/${teamId}/ops?since=0`, {
    headers: { Authorization: `Bearer ${token}` },
  })
).json();
const raw = Buffer.from(ops.ops[0].payload, "base64").toString("latin1");
check("hub stores no plaintext", !raw.includes("backoff") && !raw.toLowerCase().includes("carter"), `${raw.length} bytes opaque`);

const b1 = onMachine(dirB, "device-b", "b-pull", { FACT_ID: factId });
check("B applied 1 op", b1.pull.applied === 1, JSON.stringify(b1.pull));
check("fact landed on B with origin=sync", b1.fact?.origin === "sync");
check("home dir neutralized in transit", b1.fact && !b1.fact.content.toLowerCase().includes("carter") && b1.fact.content.includes("~"));
check("B re-embedded locally", b1.vecs === 1);

// Conflict scenario: B edits first (earlier timestamp), A edits later and
// pushes — so the remote op wins LWW on B, whose unsynced edit must survive
// as a [conflict] copy.
onMachine(dirB, "device-b", "b-edit", { FACT_ID: factId });
await new Promise((r) => setTimeout(r, 1100)); // ensure A's timestamp is strictly later
onMachine(dirA, "device-a", "a-edit-push", { FACT_ID: factId });
const b2 = onMachine(dirB, "device-b", "b-conflict-pull", { FACT_ID: factId });
check("conflicting pull applied with conflict copy", b2.pull.applied === 1 && b2.pull.conflicts === 1, JSON.stringify(b2.pull));
check("LWW winner is A's edit", b2.winner.includes("A's wording"));
check("B's losing edit preserved as [conflict]", b2.copies.length === 1 && b2.copies[0].startsWith("[conflict]"));

const a3 = onMachine(dirA, "device-a", "a-secret-push");
check("secret fact hard-blocked at push", a3.push.sent === 0 && a3.push.blocked.length === 1, JSON.stringify(a3.push.blocked));

server.kill();
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} FAILED` : "\nall sync e2e checks passed");
process.exit(failed ? 1 : 0);
