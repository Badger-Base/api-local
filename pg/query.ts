import type { Kysely } from "kysely";
import type { Database, ApiQueryResponse, CourseResponse } from "./types.ts";
import type { QueryCache } from "./cache.ts";
import { applyCourseFilters } from "./builders/course-filter.ts";
import { applySectionExists } from "./builders/section-exists.ts";
import { applyGradeFilters } from "./builders/grade-filter.ts";
import { applySort } from "./builders/sort.ts";
import { hydrateCourses } from "./hydrate.ts";

/**
 * Runs the pg-backed course query:
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
 *
 * Shared by the REST `/api/query` route and the MCP query tool so both go
 * through the exact same code path.
 */
export async function runCourseQuery(
  db: Kysely<Database>,
  cache: QueryCache,
  params: Record<string, string>
): Promise<ApiQueryResponse> {
  // Check cache
  const cached = await cache.get<ApiQueryResponse>(params);
  if (cached) return cached;

  const limit = parseInt(params.limit || "10");
  const page = parseInt(params.page || "1");

  // Step 1: Qualifying query — find all matching course IDs
  // LEFT, not INNER: madgrades only has rows for courses that have been
  // graded before, so an inner join silently hides every course with no
  // grade history — 224 of 5,655 in production (4%), which is mostly new
  // courses and first-year seminars. `hydrate.ts` already left-joins this
  // same table, so the rest of the pipeline was always written to expect a
  // course with no grades; only this qualifying query disagreed.
  let qualifyQuery = db
    .selectFrom("courses")
    .leftJoin(
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
    return emptyResponse;
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

  return response;
}

/**
 * Every course sharing a designation. `course_designation` is NOT unique —
 * 366 designations cover 1,148 of 5,655 courses, mostly topics courses and
 * seminars that share a code but differ in content — so this returns all
 * matches and lets the caller decide how to present them.
 *
 * Runs through `runCourseQuery` so hydration, section shaping and caching
 * are identical to the REST route rather than a second, drifting path.
 *
 * limit: "100", not runCourseQuery's usual default. search_param is an
 * ILIKE spanning course_designation, course_title, full_course_designation
 * AND instructor names (see the search_param block above), so a popular
 * designation can rack up matches beyond just the designation itself
 * (title/instructor hits) before this function's exact-match filter below
 * narrows them back down. The worst case measured against the live catalog
 * is PSYCH 621 at 39 rows — 100 leaves comfortable margin.
 */
export async function findCoursesByDesignation(
  db: Kysely<Database>,
  cache: QueryCache,
  designation: string
): Promise<CourseResponse[]> {
  const normalized = designation.trim().replace(/\s+/g, " ").toUpperCase();
  if (normalized.length === 0) return [];

  const res = await runCourseQuery(db, cache, {
    search_param: normalized,
    limit: "100",
  });

  return res.data.filter(
    (c) =>
      c.course_designation?.toUpperCase() === normalized ||
      c.full_course_designation?.toUpperCase() === normalized
  );
}
