// Compatibility shim: parsing moved into the source-adapter layer.
// Claude Code parsing lives in sources/claude-code.ts; the cwd→project
// mapping is adapter-neutral and lives in project.ts.
export type { Turn, SessionMeta, ParsedLine } from "./sources/types.js";
export { parseLine } from "./sources/claude-code.js";
export { deriveProject } from "./project.js";
