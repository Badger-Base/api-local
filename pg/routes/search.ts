import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { Database, SuggestResponse } from "../types.ts";
import type { QueryCache } from "../cache.ts";
import { apiKeyAuth } from "../../middleware.ts";
import {
  searchCourses,
  searchInstructors,
  mergeSuggestions,
} from "../builders/suggest.ts";

interface PgSearchAppDeps {
  db: Kysely<Database>;
  cache: QueryCache;
  apiKey: string;
}

/** Below this length a query matches too much to be useful. */
const MIN_QUERY_LENGTH = 2;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 10;

const EMPTY: SuggestResponse = { suggestions: [] };

function parseLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_LIMIT);
}

/**
 * Autocomplete suggestions for the search box. Separate from `createPgApp`
 * (the /api/query pipeline) because it has its own cache namespace, its own
 * response shape, and no filter/pagination concerns.
 *
 * Over-short and unmatched queries both return 200 with an empty list — the
 * dropdown treats "nothing to suggest" as a normal state, not an error.
 */
export function createPgSearchApp({ db, cache, apiKey }: PgSearchAppDeps) {
  const app = new Hono();

  app.use("/api/*", apiKeyAuth(apiKey));

  app.get("/api/search/suggest", async (c) => {
    try {
      const q = (c.req.query("q") ?? "").trim();
      const limit = parseLimit(c.req.query("limit"));

      if (q.length < MIN_QUERY_LENGTH) return c.json(EMPTY);

      const cacheParams = { q, limit: String(limit) };
      const cached = await cache.get<SuggestResponse>(cacheParams);
      if (cached) return c.json(cached);

      // Each side is asked for a full page; merge decides the final mix.
      const [courses, instructors] = await Promise.all([
        searchCourses(db, q, limit),
        searchInstructors(db, q, limit),
      ]);

      const response: SuggestResponse = {
        suggestions: mergeSuggestions(courses, instructors, limit),
      };

      await cache.set(cacheParams, response);
      return c.json(response);
    } catch (error) {
      console.error("Error in pg /api/search/suggest:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  return app;
}
