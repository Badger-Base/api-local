import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { Database, ApiQueryResponse } from "../types.ts";
import type { QueryCache } from "../cache.ts";
import { apiKeyAuth } from "../../middleware.ts";
import { applyCourseFilters } from "../builders/course-filter.ts";
import { applySectionExists } from "../builders/section-exists.ts";
import { applyGradeFilters } from "../builders/grade-filter.ts";
import { applySort } from "../builders/sort.ts";
import { hydrateCourses } from "../hydrate.ts";

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

      // Check cache
      const cached = await cache.get<ApiQueryResponse>(params);
      if (cached) return c.json(cached);

      const limit = parseInt(params.limit || "10");
      const page = parseInt(params.page || "1");

      // Step 1: Qualifying query — find all matching course IDs
      let qualifyQuery = db
        .selectFrom("courses")
        .innerJoin(
          "madgrades_course_grades",
          "madgrades_course_grades.course_name",
          "courses.course_designation"
        )
        .select(["courses.id", "courses.catalog_number"]);

      // Apply course-level filters
      qualifyQuery = applyCourseFilters(qualifyQuery, params) as any;

      // Apply section-level EXISTS filter
      qualifyQuery = applySectionExists(qualifyQuery, params) as any;

      // Apply grade filters
      qualifyQuery = applyGradeFilters(qualifyQuery, params) as any;

      // search_param: spans course fields AND instructor names (via EXISTS
      // on sections -> section_instructors). ILIKE, combined with OR.
      if (params.search_param) {
        const pattern = `%${params.search_param}%`;
        qualifyQuery = qualifyQuery.where(({ or, exists, selectFrom, eb }) =>
          or([
            eb("courses.course_designation", "ilike", pattern),
            eb("courses.course_title", "ilike", pattern),
            eb("courses.full_course_designation", "ilike", pattern),
            exists(
              selectFrom("sections")
                .innerJoin(
                  "section_instructors",
                  "section_instructors.section_id",
                  "sections.id"
                )
                .whereRef("sections.course_ref", "=", "courses.id")
                .where("section_instructors.instructor_name", "ilike", pattern)
                .select("sections.id")
            ),
          ])
        ) as any;
      }

      // Apply sort
      qualifyQuery = applySort(qualifyQuery, params) as any;

      // Execute qualifying query — get ALL matching IDs
      const allMatches = await qualifyQuery.execute();
      const totalCount = allMatches.length;

      // Paginate in application code
      const offset = (page - 1) * limit;
      const pageIds = allMatches.slice(offset, offset + limit).map((r) => r.id);
      const hasMore = offset + limit < totalCount;

      if (pageIds.length === 0) {
        const emptyResponse: ApiQueryResponse = {
          data: [],
          count: 0,
          total_count: totalCount,
          has_more: hasMore,
        };
        await cache.set(params, emptyResponse);
        return c.json(emptyResponse);
      }

      // Step 2: Hydrate the page
      const data = await hydrateCourses(db, pageIds);

      const response: ApiQueryResponse = {
        data,
        count: data.length,
        total_count: totalCount,
        has_more: hasMore,
      };

      // Cache the result
      await cache.set(params, response);

      return c.json(response);
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
