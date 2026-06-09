import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataDir, ensureDir } from "./paths.js";

function tokenFile(): string {
  return path.join(dataDir(), "token");
}

/** Get the API token for non-localhost requests, creating one on first use. */
export function getOrCreateToken(): string {
  const file = tokenFile();
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t) return t;
  } catch {
    /* fall through to create */
  }
  ensureDir(dataDir());
  const t = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}
