import { Hono } from "hono";
import type { Kysely } from "kysely";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Database } from "../types.ts";
import type { QueryCache } from "../cache.ts";
import { runCourseQuery } from "../query.ts";
import { renderCourseResults } from "./render.ts";

interface McpAppDeps {
  db: Kysely<Database>;
  cache: QueryCache;
}

/**
 * `limit` bounds how much course text gets stuffed into a model's context on
 * a single call — a broad, unfiltered search is exactly the kind of call a
 * model makes first, so this cap holds regardless of what a future filtered
 * request (Task 6) asks for.
 */
const MAX_LIMIT = 25;

/** Clamps `limit` to MAX_LIMIT, leaving every other param untouched. */
function clampLimit(params: Record<string, string>): Record<string, string> {
  if (!params.limit) return params;
  const parsed = parseInt(params.limit, 10);
  if (Number.isNaN(parsed)) return params;
  return { ...params, limit: String(Math.min(parsed, MAX_LIMIT)) };
}

function registerTools(server: McpServer, db: Kysely<Database>, cache: QueryCache): void {
  // No input schema yet — Task 6 adds arguments and validation. Until then
  // every call runs the same unfiltered, capped search, which is enough to
  // prove the transport end-to-end.
  server.registerTool(
    "search_courses",
    {
      description: "Search UW-Madison courses by subject, level, title keywords, or instructor.",
    },
    async () => {
      const params = clampLimit({});
      const res = await runCourseQuery(db, cache, params);
      return { content: [{ type: "text" as const, text: renderCourseResults(res, params) }] };
    }
  );
}

/**
 * Mounts the MCP Streamable HTTP transport at the app root (the caller
 * mounts this sub-app at `/mcp`). Runs stateless: `sessionIdGenerator` is
 * left undefined, so no session state is created, stored, or expired, and
 * a fresh `McpServer`/transport pair is built per request — the pattern the
 * SDK's own stateless example uses — since both are cheap to construct and
 * this avoids any state (initialization, in-flight streams) leaking or
 * colliding across unrelated requests.
 *
 * No auth is applied here; that lands in a later task. A transport bug is
 * therefore distinguishable from an auth bug during rollout.
 */
export function createMcpApp({ db, cache }: McpAppDeps): Hono {
  const app = new Hono();

  app.all("/", async (c) => {
    const server = new McpServer({ name: "badgerbase-mcp", version: "1.0.0" });
    registerTools(server, db, cache);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    c.req.raw.signal.addEventListener("abort", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  return app;
}
