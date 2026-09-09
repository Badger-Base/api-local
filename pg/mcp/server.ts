import { Hono } from "hono";
import type { Kysely } from "kysely";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { requireMcpAuth } from "@better-auth/mcp";
import type { JWTPayload } from "jose";
import type { Database } from "../types.ts";
import type { QueryCache } from "../cache.ts";
import { runCourseQuery } from "../query.ts";
import { renderCourseResults } from "./render.ts";
import { auth, mcpResourceUrl } from "../../auth.ts";

interface McpAppDeps {
  db: Kysely<Database>;
  cache: QueryCache;
  /**
   * Whether `/mcp` requires a valid OAuth access token. Defaults to `true`
   * — this is the security property of this option: the production mount
   * in `server.ts` gets authentication without opting in. Only tests that
   * exercise transport/tool behaviour directly (not auth) opt out.
   */
  requireAuth?: boolean;
}

/**
 * `limit` bounds how much course text gets stuffed into a model's context on
 * a single call — a broad, unfiltered search is exactly the kind of call a
 * model makes first, so this cap holds regardless of what a filtered
 * request asks for.
 */
const MAX_LIMIT = 25;
const MIN_LIMIT = 1;
const DEFAULT_LIMIT = 10;

/**
 * The model-facing input schema for `search_courses`.
 *
 * IMPORTANT — every value here reaches `runCourseQuery` as a string.
 * `pg/query.ts` and the builders under `pg/builders/` all read
 * `Record<string, string>`: booleans are compared with `=== "true"`
 * (`course-filter.ts`), comma-separated lists are split on raw strings
 * (`level`, `status`), and numbers are parsed with `parseInt`/`parseFloat`.
 * A schema that handed those functions real booleans/numbers would make
 * `true === "true"` evaluate to false and silently drop every gen-ed,
 * breadth, and ethnic-studies filter — the query would run unfiltered
 * with no error. So this schema declares natural types for the model's
 * benefit (that's what makes the tool legible), and `normalizeToolArgs`
 * below converts everything to strings — exactly what `c.req.query()`
 * would have handed the REST route — before the query ever runs.
 */
const searchCoursesShape = {
  search_param: z
    .string()
    .optional()
    .describe("Free text search over course designation, title, and instructor name."),
  subject_code: z
    .string()
    .optional()
    .describe('Subject code, e.g. "COMP SCI" or "MATH". Exact match.'),
  level: z
    .string()
    .optional()
    .describe(
      'Course level. One of "Elementary", "Intermediate", "Advanced", or a comma-separated list of these to match any.'
    ),
  min_gpa: z
    .number()
    .optional()
    .describe("Minimum cumulative GPA earned by past students in this course (0-4 scale)."),
  status: z
    .string()
    .optional()
    .describe(
      'Section enrollment status. One of "OPEN", "WAITLISTED", "CLOSED", or a comma-separated list of these to match any.'
    ),
  min_credits: z.number().optional().describe("Minimum number of credits."),
  max_credits: z.number().optional().describe("Maximum number of credits."),
  general_education: z
    .string()
    .optional()
    .describe(
      'General education requirement code this course satisfies, e.g. "QR-A" or "QR-B". Exact match — not a yes/no flag.'
    ),
  ethnic_studies: z.boolean().optional().describe("Only courses satisfying the Ethnic Studies requirement."),
  humanities: z.boolean().optional().describe("Only courses satisfying the Humanities breadth requirement."),
  social_science: z
    .boolean()
    .optional()
    .describe("Only courses satisfying the Social Science breadth requirement."),
  natural_science: z
    .boolean()
    .optional()
    .describe("Only courses satisfying the Natural Science breadth requirement."),
  limit: z
    .number()
    .optional()
    .describe(`Maximum number of courses to return. Default ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}.`),
  page: z.number().optional().describe("1-based page number for pagination. Default 1."),
} as const;

/**
 * Maps schema field names to the query-param names the builders actually
 * read, where the two differ. Both mismatches below were found by reading
 * the builders directly (not documented in the tool's own spec) and, left
 * unmapped, would silently drop the filter — the same failure mode as the
 * boolean-stringification bug this file guards against elsewhere:
 *
 * - `min_gpa` -> `min_cumulative_gpa`: `pg/builders/grade-filter.ts` reads
 *   `min_cumulative_gpa`, not `min_gpa`. (`pg/mcp/render.ts`'s own
 *   "narrow with subject_code, level, or min_gpa" hint text confirms
 *   `min_gpa` is the intended model-facing name.) There is no builder
 *   support anywhere for an upper-bound GPA filter, so this schema does
 *   not expose a `max_gpa` field — adding one would accept a value that
 *   silently does nothing.
 * - `general_education` -> `gen_ed`: `pg/builders/course-filter.ts` reads
 *   `gen_ed` and compares it for equality against the `general_education`
 *   column, which holds a specific requirement code (e.g. "QR-A") or
 *   `null` — it is not a boolean flag, so this field is typed as a string
 *   rather than the boolean a literal reading of the tool spec would
 *   suggest.
 */
const KEY_MAP: Record<string, string> = {
  min_gpa: "min_cumulative_gpa",
  general_education: "gen_ed",
};

type SearchCoursesArgs = Partial<{
  search_param: string;
  subject_code: string;
  level: string;
  min_gpa: number;
  status: string;
  min_credits: number;
  max_credits: number;
  general_education: string;
  ethnic_studies: boolean;
  humanities: boolean;
  social_science: boolean;
  natural_science: boolean;
  limit: number;
  page: number;
}>;

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Clamps to [MIN_LIMIT, MAX_LIMIT], falling back to DEFAULT_LIMIT for anything non-numeric. */
function normalizeLimit(value: unknown): string {
  const n = toFiniteNumber(value);
  if (n === undefined) return String(DEFAULT_LIMIT);
  return String(Math.min(Math.max(Math.trunc(n), MIN_LIMIT), MAX_LIMIT));
}

/** Floors to MIN_LIMIT; returns undefined (omit) when absent, matching the REST route's `page` default. */
function normalizePage(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const n = toFiniteNumber(value);
  if (n === undefined) return undefined;
  return String(Math.max(Math.trunc(n), MIN_LIMIT));
}

/**
 * Converts validated tool arguments (natural types, model-facing key
 * names) into the `Record<string, string>` shape `runCourseQuery` expects
 * (REST-route param names, every value a string). This is also where the
 * global 25-item cap is enforced, so it holds even for a caller that
 * bypasses the Zod schema entirely.
 *
 * `undefined` keys are omitted rather than becoming the literal string
 * `"undefined"`. Exported so the clamp/default/omission behavior — which
 * an integration test cannot observe once results are already capped at
 * 25 by fixture size — can be unit-tested directly.
 */
export function normalizeToolArgs(args: SearchCoursesArgs): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(args)) {
    if (key === "limit" || key === "page") continue;
    if (value === undefined) continue;
    out[KEY_MAP[key] ?? key] = String(value);
  }

  out.limit = normalizeLimit(args.limit);
  const page = normalizePage(args.page);
  if (page !== undefined) out.page = page;

  return out;
}

function registerTools(
  server: McpServer,
  db: Kysely<Database>,
  cache: QueryCache,
  claims: JWTPayload | null
): void {
  server.registerTool(
    "search_courses",
    {
      description: "Search UW-Madison courses by subject, level, title keywords, or instructor.",
      inputSchema: searchCoursesShape,
    },
    async (args) => {
      const params = normalizeToolArgs(args);
      try {
        const res = await runCourseQuery(db, cache, params);
        return { content: [{ type: "text" as const, text: renderCourseResults(res, params) }] };
      } catch (error) {
        // Match the REST route's hygiene (`pg/routes/courses.ts`): log the
        // real error server-side, never let a raw error message reach an
        // unauthenticated caller.
        console.error("Error in MCP search_courses:", error);
        return {
          content: [{ type: "text" as const, text: "Internal server error" }],
          isError: true,
        };
      }
    }
  );
}

/**
 * Handles one MCP Streamable HTTP request. Runs stateless:
 * `sessionIdGenerator` is left undefined, so no session state is created,
 * stored, or expired, and a fresh `McpServer`/transport pair is built per
 * request — the pattern the SDK's own stateless example uses — since both
 * are cheap to construct and this avoids any state (initialization,
 * in-flight streams) leaking or colliding across unrelated requests.
 */
async function handleMcpRequest(
  req: Request,
  db: Kysely<Database>,
  cache: QueryCache,
  claims: JWTPayload | null
): Promise<Response> {
  const server = new McpServer({ name: "badgerbase-mcp", version: "1.0.0" });
  registerTools(server, db, cache, claims);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  req.signal.addEventListener("abort", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  return transport.handleRequest(req);
}

/**
 * Mounts the MCP Streamable HTTP transport at the app root (the caller
 * mounts this sub-app at `/mcp`).
 *
 * `requireAuth` (default `true`) wraps every request with `requireMcpAuth`,
 * which verifies the bearer access token against better-auth's own JWKS and
 * responds with a 401 plus an RFC 9728 `WWW-Authenticate` header (naming the
 * protected-resource metadata URL) when it's missing or invalid — that
 * header is how an MCP client discovers where to authorize. Only `resource`
 * is passed explicitly; `issuer` and `jwksUrl` are left to `requireMcpAuth`'s
 * defaults. `resource` must be overridden because its default is this
 * server's own base URL, which is wrong here: the resource is the public MCP
 * endpoint (`mcpResourceUrl`), a different host from this API. `issuer` and
 * `jwksUrl` describe the authorization server instead, and the authorization
 * server IS this API's better-auth instance regardless of what host the
 * resource lives on — so `requireMcpAuth`'s defaults (both derived from
 * `(await auth.$context).baseURL`) are already correct and must be left
 * alone. Overriding `issuer` here previously pointed it at
 * `BETTER_AUTH_URL` (an origin), while better-auth signs tokens with
 * `ctx.context.baseURL` (that origin plus its `/api/auth` base path) as the
 * `iss` claim — a mismatch that made `jwtVerify` reject every real token.
 *
 * `requireMcpAuth` is not Hono middleware — it wraps a `Request` handler and
 * returns a `Request` handler — so it's applied around `handleMcpRequest`
 * rather than mounted with `app.use`.
 */
export function createMcpApp({ db, cache, requireAuth = true }: McpAppDeps): Hono {
  const app = new Hono();

  const wrappedHandler = requireAuth
    ? requireMcpAuth(
        auth,
        (req: Request, accessTokenClaims: JWTPayload) => handleMcpRequest(req, db, cache, accessTokenClaims),
        { resource: mcpResourceUrl }
      )
    : (req: Request) => handleMcpRequest(req, db, cache, null);

  app.all("/", (c) => wrappedHandler(c.req.raw));

  return app;
}
