import { recallRemote } from "../daemon/client.js";

// Claude Code UserPromptSubmit hook — the differentiator. Pulls relevant
// context from PAST sessions and injects it into this prompt. Conservative
// (threshold + caps) and strictly fail-open: it can never block or break a
// prompt, even if the daemon is down or the network is off.

const ENABLED = (process.env.RECALL_ENABLED ?? "true") !== "false";
const MIN_SCORE = Number(process.env.RECALL_MIN_SCORE ?? "0.4");
const LIMIT = 3;
const MAX_CHARS = 1500;
const SNIPPET_CHARS = 500;

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

  const snippets = await recallRemote(
    prompt,
    { excludeSessionId: sessionId, limit: LIMIT, minScore: MIN_SCORE },
    800,
  );
  if (!snippets || !snippets.length) return;

  let body = "";
  let used = 0;
  const sources = new Set<string>();
  for (const s of snippets) {
    const when = s.ts ? String(s.ts).slice(0, 10) : "";
    const where = s.project ? ` · ${s.project}` : "";
    const piece = `- (${when}${where}, ${Number(s.score).toFixed(2)}) ${clip(s.content, SNIPPET_CHARS)}\n`;
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
