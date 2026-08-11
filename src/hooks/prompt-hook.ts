import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recallRemote } from "../daemon/client.js";
import { readManifest } from "../lib/install.js";

// Set by scripts/bundle-plugin.mjs (esbuild --define) in the plugin bundles;
// undefined in the normal tsc build.
declare const PLUGIN_BUILD: boolean | undefined;
const IS_PLUGIN = typeof PLUGIN_BUILD !== "undefined" && PLUGIN_BUILD;

// Claude Code UserPromptSubmit hook — the differentiator. Pulls relevant
// context from PAST sessions and injects it into this prompt. Conservative
// (threshold + caps) and strictly fail-open: it can never block or break a
// prompt, even if the daemon is down or the network is off.

const ENABLED = (process.env.RECALL_ENABLED ?? "true") !== "false";
// Inject only strong matches. Weak-to-mid scores (0.6-0.72) are reaches that
// read as noise; below this bar the hook stays silent and the recall MCP tool
// is the pull-based path instead.
const MIN_SCORE = Number(process.env.RECALL_MIN_SCORE ?? "0.75");
const LIMIT = 3;
const MAX_CHARS = 2000;
const SNIPPET_CHARS = 700;

// Hard backstop: whatever happens, this process exits within 1.5s.
setTimeout(() => process.exit(0), 1500).unref();

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

async function main(): Promise<void> {
  if (!ENABLED) return;
  let payload: any = {};
  try {
    payload = JSON.parse((await readStdin()) || "{}");
  } catch {
    return;
  }
  const prompt = payload.prompt;
  const sessionId = payload.session_id;
  if (!prompt || typeof prompt !== "string") return;

  // Plugin installed but runtime not set up yet: nudge once per session,
  // then stay silent. (npm installs always have a manifest after setup;
  // clone/dev installs never enter this branch.)
  if (IS_PLUGIN && !readManifest()) {
    const marker = path.join(os.tmpdir(), `recall-nudge-${sessionId || "unknown"}`);
    if (fs.existsSync(marker)) return;
    try {
      fs.writeFileSync(marker, "1");
    } catch {
      /* still nudge */
    }
    process.stdout.write(
      JSON.stringify({
        systemMessage:
          "🧠 recall plugin is installed but its runtime isn't set up. Run /recall:setup to finish (one-time, ~5 min).",
      }),
    );
    return;
  }

  const snippets = await recallRemote(
    prompt,
    { excludeSessionId: sessionId, limit: LIMIT, minScore: MIN_SCORE, source: "hook" },
    800,
  );
  if (!snippets || !snippets.length) return;

  let body = "";
  let used = 0;
  const sources = new Set<string>();
  for (const s of snippets) {
    const when = s.ts ? String(s.ts).slice(0, 10) : "";
    const where = s.project ? ` · ${s.project}` : "";
    const prefix = s.kind === "fact" ? `📌 [${s.factKind}] ` : "";
    const piece = `- ${prefix}(${when}${where}, ${Number(s.score).toFixed(2)}) ${clip(s.content, SNIPPET_CHARS)}\n`;
    if (body.length + piece.length > MAX_CHARS) break;
    body += piece;
    used++;
    if (s.project) sources.add(s.project);
  }
  if (!body) return;

  const additionalContext =
    "Relevant context from your past AI coding sessions (auto-recalled):\n" + body;
  const topScore = Number(snippets[0].score).toFixed(2);
  const from = sources.size ? ` from ${[...sources].join(", ")}` : "";
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
      systemMessage: `🧠 recall: injected ${used} snippet${used === 1 ? "" : "s"}${from} (top ${topScore})`,
    }),
  );
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
