import { sql } from "kysely";
import type { SelectQueryBuilder } from "kysely";
import type { Database } from "../types.ts";

type SortableQuery = SelectQueryBuilder<Database, "courses" | "madgrades_course_grades", any>;

/**
 * Applies ORDER BY to a Kysely query that has already joined
 * `madgrades_course_grades`. Recognized `sort` values: "cumulative_gpa"
 * (DESC), "recent_gpa" (DESC). Anything else (including missing/empty)
 * falls back to catalog_number ASC.
 */
export function applySort(query: SortableQuery, params: Record<string, string>): SortableQuery {
  const sort = params.sort?.toLowerCase();

  // NULLS LAST matters now that the qualifying query left-joins grades:
  // Postgres sorts NULLs FIRST on DESC, so without this a "highest GPA"
  // sort would lead with every course that has no GPA at all.
  if (sort === "cumulative_gpa") {
    return query.orderBy(sql`madgrades_course_grades.cumulative_gpa DESC NULLS LAST`);
  }
  if (sort === "recent_gpa") {
    return query.orderBy(sql`madgrades_course_grades.most_recent_gpa DESC NULLS LAST`);
  }

  return query.orderBy("courses.catalog_number", "asc");
}
