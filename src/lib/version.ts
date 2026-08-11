import { createRequire } from "node:module";

// Single source of truth for the version: package.json, resolved relative to
// the built file (dist/lib/version.js -> ../../package.json).
const require = createRequire(import.meta.url);

function resolveVersion(): string {
  try {
    return require("../../package.json").version;
  } catch {
    // Plugin bundles may run from a location with no adjacent package.json;
    // callers that need the *installed* version use the install manifest.
    return "0.0.0";
  }
}

export const VERSION: string = resolveVersion();
export const SERVICE = "recalld";
