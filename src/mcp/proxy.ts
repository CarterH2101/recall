import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, formatSnippets, daemonUp, daemonRecall, daemonRecent } from "./shared.js";
import { VERSION } from "../lib/version.js";

// Plugin variant of the MCP server: HTTP-to-daemon ONLY, no in-process
// fallback — so the esbuild bundle carries zero native dependencies. If the
// runtime isn't installed yet, tools answer with setup instructions instead
// of failing opaquely.

const SETUP_MSG =
  "recall's runtime isn't installed on this machine yet. " +
  "Run `/recall:setup` (or `npx recalld@latest setup --runtime-only` in a terminal), " +
  "then try again.";

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

  if (!(await daemonUp())) {
    return { content: [{ type: "text", text: SETUP_MSG }] };
  }

  if (name === "recall") {
    const snippets = await daemonRecall(args);
    return {
      content: [
        { type: "text", text: snippets ? formatSnippets(snippets) : "recall daemon unreachable." },
      ],
    };
  }

  if (name === "recent_sessions") {
    const limit = typeof args.limit === "number" ? args.limit : 10;
    const sessions = await daemonRecent();
    return {
      content: [
        {
          type: "text",
          text: sessions ? JSON.stringify(sessions.slice(0, limit), null, 2) : "recall daemon unreachable.",
        },
      ],
    };
  }

  throw new Error(`unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[recall-mcp-proxy] stdio server connected");
