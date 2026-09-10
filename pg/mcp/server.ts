import { Hono } from "hono";
import type { Kysely } from "kysely";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { requireMcpAuth } from "@better-auth/mcp";
import type { JWTPayload } from "jose";
import type { Database } from "../types.ts";
import type { QueryCache } from "../cache.ts";
import { runCourseQuery, findCoursesByDesignation } from "../query.ts";
import { resolveUserEmail, findSubscriptions } from "../subscriptions-query.ts";
import { renderCourseResults, renderCourseDetail, renderCourseVariants } from "./render.ts";
import { renderSubscriptions } from "./subscriptions-render.ts";
import { auth, mcpResourceUrl } from "../../auth.ts";

/** True when the access token's `scope` claim contains `wanted`. */
function hasScope(claims: JWTPayload | null, wanted: string): boolean {
  const raw = claims?.scope;
  if (typeof raw !== "string") return false;
  return raw.split(/\s+/).includes(wanted);
}

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
 * Shared description text for the five `free_{day}` fields. These are
 * schedule-fitting filters, not "find me a morning class" filters — the
 * semantics are easy to misuse, so this is stated plainly and repeated per
 * field rather than left to a general note the model might not connect to
 * the specific parameter it's about to call.
 */
function freeDayDescription(day: string): string {
  return (
    `Blocks of time you are FREE on ${day}s, in local Madison time — comma-separated ` +
    `"HH:MM-HH:MM" ranges, e.g. "13:00-17:00,18:00-20:00" for free 1-5pm and 6-8pm. ` +
    `A course matches only if one of its sections has EVERY meeting falling inside ` +
    `your free blocks on every day you specify with a free_* field. IMPORTANT: a ` +
    `section that meets on a day you did NOT specify is excluded entirely, even if ` +
    `you said nothing about that day. So do not set only one free_* field to mean ` +
    `"find me a morning class" in general — that also rejects every section meeting ` +
    `on the other four weekdays. Use these fields only when fitting a schedule ` +
    `around fixed commitments, and set every day that matters (e.g. both ` +
    `free_monday and free_wednesday together to check a Monday/Wednesday-only free ` +
    `window).`
  );
}

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
  min_professor_rating: z
    .number()
    .optional()
    .describe(
      "Minimum average RateMyProfessors rating (1-5 scale) among a section's instructors. A course matches if at least one of its sections clears this."
    ),
  max_professor_difficulty: z
    .number()
    .optional()
    .describe(
      "Maximum average RateMyProfessors difficulty (1-5 scale) among a section's instructors — a CEILING: keeps sections rated at most this difficult. There is no way with this field to require a harder course."
    ),
  min_professor_ratings_count: z
    .number()
    .optional()
    .describe(
      "Only sections whose instructors have at least this many combined RateMyProfessors ratings. Use this to avoid judging a professor on a single review."
    ),
  min_would_take_again_percent: z
    .number()
    .optional()
    .describe(
      "Minimum percent (0-100) of RateMyProfessors reviewers who said they would take the instructor again."
    ),
  min_open_seats: z
    .number()
    .optional()
    .describe("Only sections with at least this many seats currently open."),
  sort: z
    .string()
    .optional()
    .describe(
      'How to order results. "cumulative_gpa" sorts by highest all-time average course GPA first; "recent_gpa" sorts by the most recent semester\'s average GPA first. These are the only two supported values — anything else is ignored and results fall back to catalog-number order.'
    ),
  free_monday: z.string().optional().describe(freeDayDescription("Monday")),
  free_tuesday: z.string().optional().describe(freeDayDescription("Tuesday")),
  free_wednesday: z.string().optional().describe(freeDayDescription("Wednesday")),
  free_thursday: z.string().optional().describe(freeDayDescription("Thursday")),
  free_friday: z.string().optional().describe(freeDayDescription("Friday")),
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
 * - `min_professor_rating` -> `min_section_avg_rating`,
 *   `max_professor_difficulty` -> `max_section_avg_difficulty`,
 *   `min_professor_ratings_count` -> `min_section_total_ratings`,
 *   `min_would_take_again_percent` -> `min_section_avg_would_take_again`,
 *   `min_open_seats` -> `min_available_seats`: all five read from
 *   `pg/builders/section-exists.ts`, which names its RMP/seat params after
 *   the underlying columns rather than the model-facing concept. Note
 *   `max_section_avg_difficulty` is deliberately the only ceiling ("<=") in
 *   that group — the other three RMP predicates there are floors (">=").
 *
 * `free_monday` .. `free_friday` are NOT simple renames and are therefore
 * handled outside this map, in `convertFreeBlocks` below: one field expands
 * into two builder params (`{day}StartTime` / `{day}EndTime`) via a
 * timezone conversion, not a 1:1 key swap.
 */
const KEY_MAP: Record<string, string> = {
  min_gpa: "min_cumulative_gpa",
  general_education: "gen_ed",
  min_professor_rating: "min_section_avg_rating",
  max_professor_difficulty: "max_section_avg_difficulty",
  min_professor_ratings_count: "min_section_total_ratings",
  min_would_take_again_percent: "min_section_avg_would_take_again",
  min_open_seats: "min_available_seats",
};

/** Model-facing `free_{day}` field name -> the builder's day-name segment. */
const FREE_DAY_MAP: Record<string, string> = {
  free_monday: "monday",
  free_tuesday: "tuesday",
  free_wednesday: "wednesday",
  free_thursday: "thursday",
  free_friday: "friday",
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
  min_professor_rating: number;
  max_professor_difficulty: number;
  min_professor_ratings_count: number;
  min_would_take_again_percent: number;
  min_open_seats: number;
  sort: string;
  free_monday: string;
  free_tuesday: string;
  free_wednesday: string;
  free_thursday: string;
  free_friday: string;
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

/** One local "HH:MM" clock time as minutes since local midnight, or null if malformed. */
function parseClockMinutes(raw: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Six-hour CST->UTC offset, in minutes, matching the frontend's
 * `cstToUtcMilliseconds` (`components/availability-calendar.tsx`) — the
 * function that produces the millisecond values actually stored against
 * sections, so this must match it exactly rather than being re-derived.
 */
const CST_TO_UTC_OFFSET_MINUTES = 6 * 60;
const MINUTES_PER_DAY = 24 * 60;
const MS_PER_MINUTE = 60000;

/** Local minutes-since-midnight -> UTC milliseconds-since-midnight, wrapping past 24h. */
function localMinutesToUtcMs(localMinutes: number): number {
  return ((localMinutes + CST_TO_UTC_OFFSET_MINUTES) % MINUTES_PER_DAY) * MS_PER_MINUTE;
}

/**
 * Converts one day's free-time value (e.g. `"13:00-17:00,18:00-20:00"`,
 * local Madison time) into the comma-joined UTC-millisecond start/end
 * strings `pg/builders/section-exists.ts` parses via `parseDayBlocks`.
 *
 * Local time is compared as raw minutes (before the +6h wrap) to decide
 * whether a block is well-formed — "end after start" is a fact about the
 * student's local day, not about the wrapped UTC representation, which the
 * builder's own UTC-wrap branch (`section-exists.ts`'s "wrapping" comment)
 * already expects to see start > end for legitimate evening blocks (e.g.
 * 17:00-19:00 local wraps to a UTC end earlier than its UTC start). Once a
 * block passes local validation, both endpoints are converted independently
 * and emitted in whatever order that produces — the builder handles it.
 *
 * Returns null for any malformed block (bad format, out-of-range clock
 * value, end at or before start locally, or an empty/garbage value) so the
 * caller omits the day's params entirely rather than emitting a filter that
 * silently misbehaves.
 */
function convertFreeBlocks(value: string): { starts: string; ends: string } | null {
  const blocks = value
    .split(",")
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  if (blocks.length === 0) return null;

  const startsMs: number[] = [];
  const endsMs: number[] = [];

  for (const block of blocks) {
    const parts = block.split("-");
    if (parts.length !== 2) return null;

    const startLocal = parseClockMinutes(parts[0]);
    const endLocal = parseClockMinutes(parts[1]);
    if (startLocal === null || endLocal === null) return null;
    if (endLocal <= startLocal) return null;

    startsMs.push(localMinutesToUtcMs(startLocal));
    endsMs.push(localMinutesToUtcMs(endLocal));
  }

  return { starts: startsMs.join(","), ends: endsMs.join(",") };
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

    const day = FREE_DAY_MAP[key];
    if (day) {
      const converted = convertFreeBlocks(String(value));
      if (converted) {
        out[`${day}StartTime`] = converted.starts;
        out[`${day}EndTime`] = converted.ends;
      }
      // Malformed: omit both params for this day entirely, per spec — a
      // dropped filter over-returns, a half-formed one returns nonsense.
      continue;
    }

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

  server.registerTool(
    "get_course",
    {
      description:
        "Full detail for one course: description, prerequisites, every section with seats, instructors and meeting times. Use search_courses first to find the designation.",
      inputSchema: {
        designation: z
          .string()
          .describe('Course designation, e.g. "COMP SCI 400". Case-insensitive.'),
      },
    },
    async ({ designation }) => {
      try {
        const matches = await findCoursesByDesignation(db, cache, designation);
        if (matches.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No course matched ${designation}. Try search_courses to find the right designation.`,
              },
            ],
          };
        }
        const text =
          matches.length === 1
            ? renderCourseDetail(matches[0])
            : renderCourseVariants(matches, designation);
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        console.error("Error in MCP get_course:", error);
        return {
          content: [{ type: "text" as const, text: "Internal server error" }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "my_subscriptions",
    {
      description:
        "The courses and sections the signed-in student is watching for open seats. Takes no arguments — it always reports the caller's own subscriptions.",
      inputSchema: {},
    },
    async () => {
      // requireMcpAuth gates the endpoint, not individual tools, so the
      // per-tool scope boundary is enforced here.
      if (!hasScope(claims, "subscriptions:read")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "This connection was not granted the subscriptions:read permission, so it cannot see your subscriptions. Reconnect and approve it to enable this.",
            },
          ],
          isError: true,
        };
      }

      const userId = typeof claims?.sub === "string" ? claims.sub : null;
      if (!userId) {
        return {
          content: [{ type: "text" as const, text: "Could not identify the signed-in account." }],
          isError: true,
        };
      }

      try {
        const email = await resolveUserEmail(db, userId);
        if (!email) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No BadgerBase account matches this sign-in, so there are no subscriptions to show.",
              },
            ],
          };
        }
        const subs = await findSubscriptions(db, email);
        return { content: [{ type: "text" as const, text: renderSubscriptions(subs) }] };
      } catch (error) {
        console.error("Error in MCP my_subscriptions:", error);
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
        { resource: mcpResourceUrl, requiredScopes: ["courses:read"] }
      )
    : (req: Request) => handleMcpRequest(req, db, cache, null);

  app.all("/", (c) => wrappedHandler(c.req.raw));

  return app;
}
