import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ParsedLine, ParseContext, SessionMeta, SourceAdapter, Turn } from "./types.js";
import { deriveProject } from "../project.js";
import { codexSessionsDir } from "../paths.js";

// Codex CLI rollout adapter. Format verified against real files spanning
// cli 0.119.0-alpha.11 (Apr 2026) → 0.142.2 (Jul 2026): JSONL lines of
// {timestamp, type, payload}. Defensive throughout — unknown/drifted lines
// return null, never throw.
//
// What we keep:   response_item messages with role user|assistant.
// What we skip:   role 'developer' (permissions/apps boilerplate), user
//                 messages that are injected context (<environment_context>,
//                 <user_instructions>, …), reasoning (encrypted), function
//                 calls, turn_context, and ALL event_msg records — their
//                 user_message/agent_message events duplicate the
//                 response_item messages and would double-ingest.
// Never stored:   session_meta.base_instructions (full system prompt).

const MAX_CONTENT = 8000;

const FILE_UUID =
  /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const INJECTED_CONTEXT =
  /^<(environment_context|user_instructions|permissions|apps_instructions|ide_|turn_context|collaboration_mode)/i;

/** Session id comes from the rollout filename: the payload only carries it on
 *  line 1, and the byte cursor resumes mid-file. */
export function sessionIdFromFile(filePath: string): string | null {
  const m = FILE_UUID.exec(path.basename(filePath));
  return m ? m[1].toLowerCase() : null;
}

function textFrom(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as any[]) {
    if (!block || typeof block !== "object") continue;
    // input_text (user) / output_text (assistant); accept bare `text` for drift
    if (typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

function turnId(sessionId: string, role: string, ts: string | null, text: string): string {
  const h = createHash("sha1").update(`${role}\n${ts ?? ""}\n${text}`).digest("hex").slice(0, 20);
  return `codex:${sessionId}:${h}`;
}

export function parseCodexLine(line: string, ctx?: ParseContext): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const sessionId = ctx?.filePath ? sessionIdFromFile(ctx.filePath) : null;
  if (!sessionId) return null; // unrecognized filename → skip the whole file

  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || !obj.type || !obj.payload) return null;
  const ts = typeof obj.timestamp === "string" ? obj.timestamp : null;

  if (obj.type === "session_meta") {
    const p = obj.payload;
    const session: SessionMeta = {
      id: sessionId,
      project: deriveProject(typeof p.cwd === "string" ? p.cwd : null),
      gitBranch: typeof p.git?.branch === "string" ? p.git.branch : null,
      cwd: typeof p.cwd === "string" ? p.cwd : null,
      ts: typeof p.timestamp === "string" ? p.timestamp : ts,
    };
    return { sessionId, session, turn: null };
  }

  if (obj.type !== "response_item") return null;
  const p = obj.payload;
  if (p.type !== "message") return null;
  const role = p.role;
  if (role !== "user" && role !== "assistant") return null; // drops 'developer'

  const text = textFrom(p.content);
  if (!text) return null;
  // Injected context masquerading as user messages: tag-prefixed blocks, and
  // anything tag-shaped that's suspiciously long.
  if (role === "user" && (INJECTED_CONTEXT.test(text) || (text.length > 6000 && text.startsWith("<")))) {
    return null;
  }

  const turn: Turn = {
    id: turnId(sessionId, role, ts, text),
    sessionId,
    role,
    content: text.slice(0, MAX_CONTENT),
    toolSummary: null,
    ts,
  };
  return { sessionId, session: null, turn };
}

function walkRollouts(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkRollouts(full));
    else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(full);
  }
  return out;
}

export const codex: SourceAdapter = {
  name: "codex",
  discover: () => walkRollouts(codexSessionsDir()),
  watchRoots: () => (fs.existsSync(codexSessionsDir()) ? [codexSessionsDir()] : []),
  parseLine: parseCodexLine,
};
