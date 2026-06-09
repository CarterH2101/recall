import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { cursorDir, ensureDir } from "./paths.js";

function cursorFile(file: string): string {
  const h = crypto.createHash("sha1").update(path.resolve(file)).digest("hex");
  return path.join(cursorDir(), h + ".json");
}

/** Byte offset already ingested for this transcript file (0 if unseen). */
export function getOffset(file: string): number {
  try {
    const o = JSON.parse(fs.readFileSync(cursorFile(file), "utf8"));
    return typeof o.offset === "number" ? o.offset : 0;
  } catch {
    return 0;
  }
}

export function setOffset(file: string, offset: number): void {
  ensureDir(cursorDir());
  fs.writeFileSync(
    cursorFile(file),
    JSON.stringify({ offset, at: new Date().toISOString(), file: path.resolve(file) }),
  );
}
