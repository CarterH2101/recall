import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Regression gate: retrieval metrics on the committed fixture must not drop
// more than TOLERANCE vs eval/baseline.json. Intentional retrieval changes
// update the baseline in the same PR, where the diff is reviewable.

const TOLERANCE = 0.02;
const GATED = ["recallAt3", "mrr", "hookRecall"]; // higher is better
const GATED_INVERSE = ["hookNoiseRate"]; // lower is better

const baseline = JSON.parse(readFileSync("eval/baseline.json", "utf8"));
const out = execFileSync(process.execPath, ["dist/cli/main.js", "eval", "run", "--fixture", "--json"], {
  encoding: "utf8",
});
const current = JSON.parse(out);

let failed = false;
for (const key of GATED) {
  const drop = baseline[key] - current[key];
  const mark = drop > TOLERANCE ? "REGRESSION" : "ok";
  if (drop > TOLERANCE) failed = true;
  console.log(`${key.padEnd(16)} baseline ${baseline[key].toFixed(3)} -> ${current[key].toFixed(3)}  ${mark}`);
}
for (const key of GATED_INVERSE) {
  const rise = current[key] - baseline[key];
  const mark = rise > TOLERANCE ? "REGRESSION" : "ok";
  if (rise > TOLERANCE) failed = true;
  console.log(`${key.padEnd(16)} baseline ${baseline[key].toFixed(3)} -> ${current[key].toFixed(3)}  ${mark}`);
}

if (failed) {
  console.error(
    "\nRetrieval metrics regressed vs eval/baseline.json. If the change is intentional, update the baseline in this PR:\n  node dist/cli/main.js eval run --fixture --json > eval/baseline.json",
  );
  process.exit(1);
}
console.log("\neval gate: green");
