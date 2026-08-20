import type { SelectQueryBuilder } from "kysely";
import type { Database } from "../types.ts";

type GradeQuery = SelectQueryBuilder<Database, "courses" | "madgrades_course_grades", any>;

/**
 * Applies madgrades-derived WHERE clauses to a Kysely query that has
 * already joined `madgrades_course_grades`: min_cumulative_gpa,
 * min_most_recent_gpa, median_grade, min_a_percent.
 */
export function applyGradeFilters(query: GradeQuery, params: Record<string, string>): GradeQuery {
  const { min_cumulative_gpa, min_most_recent_gpa, median_grade, min_a_percent } = params;

  if (min_cumulative_gpa) {
    query = query.where("madgrades_course_grades.cumulative_gpa", ">=", parseFloat(min_cumulative_gpa));
  }
  if (min_most_recent_gpa) {
    query = query.where("madgrades_course_grades.most_recent_gpa", ">=", parseFloat(min_most_recent_gpa));
  }
  if (median_grade) {
    query = query.where("madgrades_course_grades.median_grade", "=", median_grade);
  }
  if (min_a_percent) {
    query = query.where("madgrades_course_grades.a_percentage", ">=", parseFloat(min_a_percent));
  }

  return query;
}
