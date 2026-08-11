import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, formatSnippets, daemonUp, daemonRecall, daemonRecent } from "./shared.js";
import { VERSION } from "../lib/version.js";

// MCP stdio server. Daemon-first: queries go over HTTP so this process never
// loads its own copy of the embedding model. Only if the daemon can't come up
// does it fall back to the in-process library (lazy import — the heavy stack
// stays unloaded on the happy path).

const server = new Server(
  { name: "recall", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params as {
    name: string;
    arguments?: Record<string, any>;
  };

  if (name === "recall") {
    if (await daemonUp()) {
      const snippets = await daemonRecall(args);
      if (snippets) return { content: [{ type: "text", text: formatSnippets(snippets) }] };
    }
    const { recall } = await import("../lib/recall.js");
    const snippets = await recall(String(args.query ?? ""), {
      limit: typeof args.limit === "number" ? args.limit : undefined,
      project: typeof args.project === "string" ? args.project : undefined,
      minScore: typeof args.minScore === "number" ? args.minScore : undefined,
    });
    return { content: [{ type: "text", text: formatSnippets(snippets) }] };
  }

  if (name === "recent_sessions") {
    const limit = typeof args.limit === "number" ? args.limit : 10;
    if (await daemonUp()) {
      const sessions = await daemonRecent();
      if (sessions) {
        return {
          content: [{ type: "text", text: JSON.stringify(sessions.slice(0, limit), null, 2) }],
        };
      }
    }
    const { recentSessions } = await import("../lib/recall.js");
    return {
      content: [{ type: "text", text: JSON.stringify(recentSessions(limit), null, 2) }],
    };
  }

  throw new Error(`unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[recall-mcp] stdio server connected");
