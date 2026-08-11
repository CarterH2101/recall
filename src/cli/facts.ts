import {
  addFact,
  deleteFact,
  editFact,
  getFact,
  listFacts,
  setArchived,
  setPinned,
  type FactKind,
} from "../lib/facts.js";

// recalld facts list [--archived] [--project P]
// recalld facts add <kind> <content...> [--project P] [--pin]
// recalld facts show|edit|pin|unpin|archive|unarchive|rm <id>

const KINDS = new Set(["decision", "gotcha", "preference", "reference"]);

export async function run(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;

  if (sub === "list" || !sub) {
    const projIdx = rest.indexOf("--project");
    const facts = listFacts({
      archived: rest.includes("--archived"),
      project: projIdx >= 0 ? rest[projIdx + 1] : undefined,
    });
    if (!facts.length) return console.log("no facts yet — try: recalld distill");
    for (const f of facts) {
      const flags = `${f.pinned ? "📌" : "  "}${f.edited ? "✎" : " "}`;
      console.log(
        `${flags} ${f.id.slice(0, 8)} [${f.kind}]${f.project ? ` (${f.project})` : ""} ${f.content.replace(/\s+/g, " ").slice(0, 110)}`,
      );
    }
    return;
  }

  if (sub === "add") {
    const kind = rest[0] as FactKind;
    if (!KINDS.has(kind)) {
      console.error("Usage: recalld facts add <decision|gotcha|preference|reference> <content...>");
      process.exit(1);
    }
    const projIdx = rest.indexOf("--project");
    const contentWords: string[] = [];
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "--project") {
        i++; // skip its value too
        continue;
      }
      if (rest[i].startsWith("--")) continue;
      contentWords.push(rest[i]);
    }
    const content = contentWords.join(" ");
    const r = await addFact({
      kind,
      content,
      project: projIdx >= 0 ? rest[projIdx + 1] : null,
      origin: "manual",
      pinned: rest.includes("--pin"),
    });
    console.log(`${r.action}: ${r.id}${r.similarTo ? ` (near-duplicate of ${r.similarTo})` : ""}`);
    return;
  }

  const id = resolveId(rest[0]);
  if (!id) {
    console.error(`Usage: recalld facts ${sub} <id>`);
    process.exit(1);
  }

  switch (sub) {
    case "show": {
      const f = getFact(id)!;
      console.log(JSON.stringify(f, null, 2));
      return;
    }
    case "edit": {
      const content = rest.slice(1).join(" ");
      if (!content) {
        console.error("Usage: recalld facts edit <id> <new content...>");
        process.exit(1);
      }
      await editFact(id, content);
      console.log("edited + re-embedded");
      return;
    }
    case "pin":
      setPinned(id, true);
      return console.log("pinned");
    case "unpin":
      setPinned(id, false);
      return console.log("unpinned");
    case "archive":
      await setArchived(id, true);
      return console.log("archived (removed from ranking)");
    case "unarchive":
      await setArchived(id, false);
      return console.log("unarchived + re-embedded");
    case "rm":
      deleteFact(id);
      return console.log("deleted");
    default:
      console.log("Usage: recalld facts list|add|show|edit|pin|unpin|archive|unarchive|rm");
      process.exit(1);
  }
}

/** Accept full ids or unambiguous 8-char prefixes. */
function resolveId(prefix: string | undefined): string | null {
  if (!prefix) return null;
  if (getFact(prefix)) return prefix;
  const all = [...listFacts({}), ...listFacts({ archived: true })];
  const hits = all.filter((f) => f.id.startsWith(prefix));
  return hits.length === 1 ? hits[0].id : null;
}
