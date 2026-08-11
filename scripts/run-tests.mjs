import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Node 20's `node --test` neither expands globs nor reliably takes directory
// args on Windows — pass explicit files so every supported Node/OS agrees.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist-test", "tests");
const files = readdirSync(dir).filter((f) => f.endsWith(".test.js")).map((f) => path.join(dir, f));
if (!files.length) {
  console.error(`no test files in ${dir} — did the build run?`);
  process.exit(1);
}
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
