import fs from "node:fs";
import path from "node:path";
import type { ParsedLine, SessionMeta, SourceAdapter, Turn } from "./types.js";
import { deriveProject } from "../project.js";
import { claudeProjectsDir } from "../paths.js";

// Claude Code transcript adapter. Parsing moved verbatim from the original
// transcript.ts — turn ids remain the raw line uuids, so every row ingested
// before the adapter refactor stays valid.

const MAX_CONTENT = 8000;

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

/** Extract prose text + tool-call names from an Anthropic message.content. */
function textFromContent(content: unknown): { text: string; toolNames: string[] } {
  if (typeof content === "string") return { text: content.trim(), toolNames: [] };
  if (!Array.isArray(content)) return { text: "", toolNames: [] };
  const parts: string[] = [];
  const toolNames: string[] = [];
  for (const block of content as any[]) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "tool_use" && typeof block.name === "string") toolNames.push(block.name);
  }
  return { text: parts.join("\n").trim(), toolNames };
}

export function parseLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const sessionId = obj.sessionId;
  if (!sessionId || typeof sessionId !== "string") return null;
  const ts = typeof obj.timestamp === "string" ? obj.timestamp : null;

  let session: SessionMeta | null = null;
  if (obj.cwd || obj.gitBranch) {
    session = {
      id: sessionId,
      project: deriveProject(obj.cwd),
      gitBranch: typeof obj.gitBranch === "string" ? obj.gitBranch : null,
      cwd: typeof obj.cwd === "string" ? obj.cwd : null,
      ts,
    };
  }

  let turn: Turn | null = null;
  if ((obj.type === "user" || obj.type === "assistant") && obj.message && obj.uuid) {
    const role = obj.type as "user" | "assistant";
    const { text, toolNames } = textFromContent(obj.message.content);
    if (text) {
      turn = {
        id: obj.uuid,
        sessionId,
        role,
        content: clip(text, MAX_CONTENT),
        toolSummary: toolNames.length ? toolNames.join(", ") : null,
        ts,
      };
    }
  }

  if (!session && !turn) return null;
  return { sessionId, session, turn };
}

function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJsonl(full));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

export const claudeCode: SourceAdapter = {
  name: "claude-code",
  discover: () => walkJsonl(claudeProjectsDir()),
  watchRoots: () => [], // the Stop hook is the push path; no watcher needed
  parseLine: (line) => parseLine(line),
};
