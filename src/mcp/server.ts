import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { recall, recentSessions, type Snippet } from "../lib/recall.js";

function formatSnippets(snippets: Snippet[]): string {
  if (!snippets.length) return "No relevant past context found.";
  return snippets
    .map((s, i) => {
      const when = s.ts ? s.ts.slice(0, 10) : "unknown date";
      const where = s.project ? ` · ${s.project}` : "";
      return `### ${i + 1}. ${s.role} (${when}${where}, score ${s.score.toFixed(2)})\n${s.content}`;
    })
    .join("\n\n");
}

const server = new Server(
  { name: "recall", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "recall",
      description:
        "Search your own past AI coding sessions (across projects) for relevant context. " +
        "Use when you need to remember a prior decision, approach, or detail you worked on before.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for in past sessions." },
          limit: { type: "number", description: "Max snippets to return (default 5)." },
          project: { type: "string", description: "Optional: restrict to a project name." },
          minScore: {
            type: "number",
            description: "Optional: minimum cosine similarity 0..1 (default 0).",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "recent_sessions",
      description: "List your most recent captured coding sessions with project and turn counts.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max sessions to return (default 10)." },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params as {
    name: string;
    arguments?: Record<string, any>;
  };

  if (name === "recall") {
    const snippets = await recall(String(args.query ?? ""), {
      limit: typeof args.limit === "number" ? args.limit : undefined,
      project: typeof args.project === "string" ? args.project : undefined,
      minScore: typeof args.minScore === "number" ? args.minScore : undefined,
    });
    return { content: [{ type: "text", text: formatSnippets(snippets) }] };
  }

  if (name === "recent_sessions") {
    const limit = typeof args.limit === "number" ? args.limit : 10;
    return {
      content: [{ type: "text", text: JSON.stringify(recentSessions(limit), null, 2) }],
    };
  }

  throw new Error(`unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[recall-mcp] stdio server connected");
