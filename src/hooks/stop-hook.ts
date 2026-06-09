import { ingestRemote } from "../daemon/client.js";

// Claude Code Stop hook. Captures the just-finished turn's transcript into
// local memory. Never blocks the agent: any failure exits 0 silently.

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  let payload: any = {};
  try {
    payload = JSON.parse((await readStdin()) || "{}");
  } catch {
    return;
  }
  const transcriptPath = payload.transcript_path;
  if (transcriptPath && typeof transcriptPath === "string") {
    await ingestRemote(transcriptPath);
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
