import { daemonPort, spawnDaemon } from "../daemon/client.js";
import { identify } from "../daemon/lifecycle.js";

export interface SnippetLike {
  role: string;
  content: string;
  ts: string | null;
  project: string | null;
  score: number;
}

export function formatSnippets(snippets: SnippetLike[]): string {
  if (!snippets.length) return "No relevant past context found.";
  return snippets
    .map((s, i) => {
      const when = s.ts ? s.ts.slice(0, 10) : "unknown date";
      const where = s.project ? ` · ${s.project}` : "";
      return `### ${i + 1}. ${s.role} (${when}${where}, score ${s.score.toFixed(2)})\n${s.content}`;
    })
    .join("\n\n");
}

export const TOOLS = [
  {
    name: "recall",
    description:
      "Search the user's past AI coding sessions (raw transcripts, all projects, local index). " +
      "Use when resuming prior work, or when you need a detail curated memory files don't hold: " +
      "an exact error message, a command or query that worked, a decision made in a one-off session. " +
      "Results are Q+A units (matched turn paired with its reply) with date, project, and score. " +
      "Try it before saying you don't remember something the user says happened before.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for in past sessions." },
        limit: { type: "number", description: "Max snippets to return (default 5)." },
        project: { type: "string", description: "Optional: restrict to a project name." },
        minScore: {
          type: "number",
          description: "Optional: minimum cosine similarity 0..1 (default 0).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "recent_sessions",
    description: "List your most recent captured coding sessions with project and turn counts.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max sessions to return (default 10)." },
      },
    },
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the daemon answers, spawning it if needed. */
export async function daemonUp(spawnWaitMs = 8000): Promise<boolean> {
  if (await identify(daemonPort(), 400)) return true;
  spawnDaemon();
  const deadline = Date.now() + spawnWaitMs;
  while (Date.now() < deadline) {
    if (await identify(daemonPort(), 400)) return true;
    await sleep(400);
  }
  return false;
}

export async function daemonRecall(args: Record<string, any>): Promise<SnippetLike[] | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort()}/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: String(args.query ?? ""),
        limit: typeof args.limit === "number" ? args.limit : undefined,
        project: typeof args.project === "string" ? args.project : undefined,
        minScore: typeof args.minScore === "number" ? args.minScore : undefined,
        source: "mcp",
      }),
      signal: AbortSignal.timeout(30_000), // model may still be warming
    });
    if (!res.ok) return null;
    return ((await res.json()) as any).snippets ?? [];
  } catch {
    return null;
  }
}

export async function daemonRecent(): Promise<any[] | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort()}/recent`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return ((await res.json()) as any).sessions ?? [];
  } catch {
    return null;
  }
}
