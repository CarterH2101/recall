import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

// recalld eval run [--fixture] [--dataset <file>] [--md <out>] [--json]
// recalld eval build-fixture     (local only — needs the real model)
// recalld eval seed [--n 120]    (sample real history into candidates.jsonl)
// recalld eval label             (interactive y/n/f/s labeling loop)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const fixtureDir = path.join(repoRoot, "eval", "fixtures");
const fixtureDb = path.join(fixtureDir, "fixture.db");
const corpusFile = path.join(fixtureDir, "corpus.jsonl");
const syntheticFile = path.join(fixtureDir, "synthetic.jsonl");
const vecsFile = path.join(fixtureDir, "query-vecs.json");
const personalDir = path.join(os.homedir(), ".recall", "eval");

function arg(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

async function cmdRun(argv: string[]): Promise<void> {
  const fixture = argv.includes("--fixture");
  if (fixture) {
    if (!fs.existsSync(fixtureDb)) {
      console.error("fixture.db missing — run: recalld eval build-fixture");
      process.exit(1);
    }
    process.env.RECALL_DB_PATH = fixtureDb;
  }
  const { loadDataset, runDataset, renderReport, usePrecomputedVectors } = await import(
    "../eval/runner.js"
  );
  if (fixture) usePrecomputedVectors(vecsFile);

  const datasetPath =
    arg(argv, "--dataset") ?? (fixture ? syntheticFile : path.join(personalDir, "personal.jsonl"));
  if (!fs.existsSync(datasetPath)) {
    console.error(`dataset not found: ${datasetPath}`);
    process.exit(1);
  }
  const cases = loadDataset(datasetPath);
  const report = await runDataset(cases);

  if (argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          cases: report.cases,
          recallAt1: report.recallAt1,
          recallAt3: report.recallAt3,
          recallAt5: report.recallAt5,
          mrr: report.mrr,
          hookPrecision: report.hook.precision,
          hookNoiseRate: report.hook.noiseRate,
          hookRecall: report.hook.recallAt,
          recommendedMinScore: report.recommended.minScore,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(renderReport(report));
  }
  const mdOut = arg(argv, "--md");
  if (mdOut) {
    fs.writeFileSync(mdOut, renderReport(report, true) + "\n");
    console.error(`\nwrote ${mdOut}`);
  }
}

async function cmdBuildFixture(): Promise<void> {
  // Fresh db each time; model name + corpus hash go into a meta table so the
  // runner can detect staleness.
  for (const f of [fixtureDb, `${fixtureDb}-wal`, `${fixtureDb}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* absent */
    }
  }
  process.env.RECALL_DB_PATH = fixtureDb;
  const { getDb, vecBlob } = await import("../lib/db.js");
  const { embed } = await import("../lib/embed.js");
  const { isLowSignal } = await import("../lib/signal.js");
  const { queryHash, loadDataset } = await import("../eval/runner.js");
  const { createHash } = await import("node:crypto");

  const corpusRaw = fs.readFileSync(corpusFile, "utf8");
  const lines = corpusRaw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const db = getDb();

  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
  const model = process.env.RECALL_MODEL || "Xenova/bge-small-en-v1.5";
  const corpusHash = createHash("sha256").update(corpusRaw).digest("hex").slice(0, 16);
  db.prepare(`INSERT OR REPLACE INTO meta VALUES ('model', ?)`).run(model);
  db.prepare(`INSERT OR REPLACE INTO meta VALUES ('corpus_hash', ?)`).run(corpusHash);

  const insSession = db.prepare(
    `INSERT INTO sessions (id, source_agent, project, cwd, started_at, last_seen_at)
     VALUES (@id, 'claude-code', @project, @cwd, @ts, @ts)`,
  );
  const insTurn = db.prepare(
    `INSERT INTO turns (id, session_id, role, content, tool_summary, ts, redaction_count)
     VALUES (@id, @sessionId, @role, @content, NULL, @ts, 0)`,
  );
  const insVec = db.prepare(`INSERT INTO vec_turns (rowid, embedding) VALUES (?, ?)`);

  const counters = new Map<string, number>();
  const toEmbed: { rowid: bigint; content: string }[] = [];
  for (const line of lines) {
    if (line.type === "session") {
      insSession.run({ id: line.id, project: line.project ?? null, cwd: line.cwd ?? null, ts: line.ts ?? "2026-05-01T00:00:00Z" });
    } else if (line.type === "turn") {
      const n = (counters.get(line.sessionId) ?? 0) + 1;
      counters.set(line.sessionId, n);
      const info = insTurn.run({
        id: `fx:${line.sessionId}:${n}`,
        sessionId: line.sessionId,
        role: line.role,
        content: line.content,
        ts: line.ts ?? null,
      });
      if (!isLowSignal(line.role, line.content)) {
        toEmbed.push({ rowid: BigInt(info.lastInsertRowid), content: line.content });
      }
    }
  }
  console.log(`embedding ${toEmbed.length} corpus turns...`);
  const vecs = await embed(toEmbed.map((t) => t.content.slice(0, 1500)));
  const tx = db.transaction(() => {
    for (let i = 0; i < toEmbed.length; i++) insVec.run(toEmbed[i].rowid, vecBlob(vecs[i]));
  });
  tx();

  const cases = loadDataset(syntheticFile);
  console.log(`embedding ${cases.length} query vectors...`);
  const qvecs = await embed(cases.map((c) => c.query.slice(0, 1500)));
  const table: Record<string, number[]> = {};
  for (let i = 0; i < cases.length; i++) table[queryHash(cases[i].query)] = Array.from(qvecs[i]);
  fs.writeFileSync(vecsFile, JSON.stringify(table));
  db.pragma("wal_checkpoint(TRUNCATE)");
  console.log(`built ${fixtureDb} (${toEmbed.length} vectors) + ${path.basename(vecsFile)}`);
}

async function cmdSeed(argv: string[]): Promise<void> {
  const n = Number(arg(argv, "--n") ?? 120);
  const { getDb } = await import("../lib/db.js");
  const { recallCandidates } = await import("../lib/recall.js");
  const db = getDb();

  // Stratified sample of embedded user turns (pre-filtered from junk by the
  // embed gate), spread across projects and time.
  const rows = db
    .prepare(
      `SELECT t.id, t.session_id, t.content, t.ts, s.project
       FROM turns t
       JOIN vec_turns v ON v.rowid = t.rowid
       JOIN sessions s ON s.id = t.session_id
       WHERE t.role = 'user' AND length(t.content) BETWEEN 40 AND 400
       ORDER BY random() LIMIT ?`,
    )
    .all(n) as any[];

  fs.mkdirSync(personalDir, { recursive: true });
  const out = path.join(personalDir, "candidates.jsonl");
  const lines: string[] = [];
  for (const [i, r] of rows.entries()) {
    const cands = await recallCandidates(r.content, { excludeSessionId: r.session_id, limit: 5 });
    lines.push(
      JSON.stringify({
        id: `seed-${String(i + 1).padStart(4, "0")}`,
        query: r.content,
        origin_session: r.session_id,
        project: r.project,
        ts: r.ts,
        retrieved: cands.slice(0, 5).map((c) => ({
          turnId: c.turnId,
          sessionId: c.sessionId,
          score: Number(c.score.toFixed(3)),
          preview: c.content.slice(0, 200),
        })),
      }),
    );
    if ((i + 1) % 20 === 0) console.log(`${i + 1}/${rows.length}`);
  }
  fs.writeFileSync(out, lines.join("\n") + "\n");
  console.log(`wrote ${rows.length} candidates to ${out}\nNext: recalld eval label`);
}

async function cmdLabel(): Promise<void> {
  const inFile = path.join(personalDir, "candidates.jsonl");
  const outFile = path.join(personalDir, "personal.jsonl");
  if (!fs.existsSync(inFile)) {
    console.error(`no candidates at ${inFile} — run: recalld eval seed`);
    process.exit(1);
  }
  const done = new Set<string>();
  if (fs.existsSync(outFile)) {
    for (const l of fs.readFileSync(outFile, "utf8").split("\n").filter(Boolean)) {
      done.add(JSON.parse(l).id);
    }
  }
  const candidates = fs
    .readFileSync(inFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((c) => !done.has(c.id));

  console.log(`${candidates.length} unlabeled candidates. Keys: y=relevant n=irrelevant f=forbidden s=skip case q=quit\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

  for (const c of candidates) {
    console.log(`\n━━━ [${c.id}] ${c.query.slice(0, 120)}`);
    const expected_session_ids: string[] = [];
    const expected_turn_ids: string[] = [];
    const forbidden_turn_ids: string[] = [];
    let skip = false;
    for (const r of c.retrieved) {
      console.log(`\n  (${r.score}) [${r.sessionId.slice(0, 8)}] ${r.preview.replace(/\n/g, " ")}`);
      const a = (await ask("  y/n/f/s/q> ")).trim().toLowerCase();
      if (a === "q") {
        rl.close();
        console.log(`\nProgress saved to ${outFile}`);
        return;
      }
      if (a === "s") {
        skip = true;
        break;
      }
      if (a === "y") expected_session_ids.push(r.sessionId);
      if (a === "f") forbidden_turn_ids.push(r.turnId);
    }
    if (skip || (!expected_session_ids.length && !expected_turn_ids.length)) continue;
    fs.appendFileSync(
      outFile,
      JSON.stringify({
        id: c.id,
        query: c.query,
        expected_session_ids: [...new Set(expected_session_ids)],
        expected_turn_ids,
        forbidden_turn_ids,
        exclude_session_id: c.origin_session,
        source: "seed-label",
        created_at: new Date().toISOString().slice(0, 10),
      }) + "\n",
    );
  }
  rl.close();
  console.log(`\nDone. Labels in ${outFile} — run: recalld eval run`);
}

export async function run(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === "run") return cmdRun(rest);
  if (sub === "build-fixture") return cmdBuildFixture();
  if (sub === "seed") return cmdSeed(rest);
  if (sub === "label") return cmdLabel();
  console.log("Usage: recalld eval run [--fixture] [--dataset f] [--md out] [--json] | build-fixture | seed [--n N] | label");
  process.exit(1);
}
