import fs from "node:fs";
import type { SourceAdapter } from "./types.js";
import { claudeCode } from "./claude-code.js";
import { codex } from "./codex.js";
import { loadConfig } from "../config.js";
import { codexSessionsDir } from "../paths.js";

const ADAPTERS: Record<string, SourceAdapter> = {
  [claudeCode.name]: claudeCode,
  [codex.name]: codex,
};

export function getAdapter(name: string): SourceAdapter | null {
  return ADAPTERS[name] ?? null;
}

/**
 * Sources that should capture on this machine. Defaults: claude-code always;
 * codex when ~/.codex/sessions exists. Explicit config wins either way.
 */
export function enabledAdapters(): SourceAdapter[] {
  const cfg = loadConfig().sources ?? {};
  const out: SourceAdapter[] = [];
  for (const adapter of Object.values(ADAPTERS)) {
    const explicit = cfg[adapter.name]?.enabled;
    const byDefault =
      adapter.name === "claude-code" ||
      (adapter.name === "codex" && fs.existsSync(codexSessionsDir()));
    if (explicit ?? byDefault) out.push(adapter);
  }
  return out;
}

export function allAdapters(): SourceAdapter[] {
  return Object.values(ADAPTERS);
}
