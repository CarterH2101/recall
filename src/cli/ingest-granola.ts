import fs from "node:fs";
import { ingestGranolaMeetings, type GranolaMeeting } from "../lib/granola.js";
import { warmup } from "../lib/embed.js";

// Ingest Granola meeting notes into the brain as source_agent='granola'.
//
//   recall-ingest-granola <meetings.json>
//
// The JSON file is an array of { id, title, ts, content }. Granola's API is
// only reachable through its MCP server (an agent session), so the flow is:
// an agent pulls meetings via MCP, writes this JSON, then runs this command.

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: recall-ingest-granola <meetings.json>");
    process.exit(1);
  }
  let meetings: GranolaMeeting[];
  try {
    meetings = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`Could not read/parse ${file}: ${(e as Error).message}`);
    process.exit(1);
  }
  if (!Array.isArray(meetings)) {
    console.error("Expected a JSON array of meetings.");
    process.exit(1);
  }

  console.log(`Loaded ${meetings.length} meetings from ${file}`);
  console.log("Warming embedding model...");
  await warmup();

  const r = await ingestGranolaMeetings(meetings);
  console.log(`Done. ${r.newTurns} new meeting notes embedded (${r.total} seen).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
