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

  if (sort === "cumulative_gpa") {
    return query.orderBy("madgrades_course_grades.cumulative_gpa", "desc");
  }
  if (sort === "recent_gpa") {
    return query.orderBy("madgrades_course_grades.most_recent_gpa", "desc");
  }

  return query.orderBy("courses.catalog_number", "asc");
}
