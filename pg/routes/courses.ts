import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { Database } from "../types.ts";
import type { QueryCache } from "../cache.ts";
import { apiKeyAuth } from "../../middleware.ts";
import { runCourseQuery } from "../query.ts";

interface PgAppDeps {
  db: Kysely<Database>;
  cache: QueryCache;
  apiKey: string;
}

/**
 * Assembles the pg-backed course query route:
 *   1. Check cache for this exact param set.
 *   2. Run a "qualifying query" — join courses to madgrades, apply course
 *      filters (Task 3), section EXISTS (Task 4, fixes the cross-section
 *      bug), grade filters (Task 5), search_param (owned here — it spans
 *      both course fields and instructor names, so it can't live in
 *      course-filter.ts without giving that builder knowledge of sections),
 *      and sort (Task 5) — to get every matching course id.
 *   3. Paginate the id list in application code (limit/page).
 *   4. Hydrate only the current page's ids into full nested course objects
 *      (Task 6) and cache the response.
 */
export function createPgApp({ db, cache, apiKey }: PgAppDeps) {
  const app = new Hono();

  app.use("/api/*", apiKeyAuth(apiKey));

  app.get("/api/query", async (c) => {
    try {
      const params = c.req.query() as Record<string, string>;
      return c.json(await runCourseQuery(db, cache, params));
    } catch (error) {
      console.error("Error in pg /api/query:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  app.get("/health", async (c) => {
    try {
      await db.selectFrom("courses").select("courses.id").limit(1).execute();
      return c.json({ status: "healthy", database: "postgres" });
    } catch {
      return c.json({ status: "unhealthy", database: "disconnected" }, 500);
    }
  });

  return app;
}
