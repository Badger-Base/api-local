import type { SelectQueryBuilder, ExpressionBuilder } from "kysely";
import type { Database } from "../types.ts";

type AnyQuery = SelectQueryBuilder<Database, "courses", any>;

/**
 * Applies course-level WHERE clauses to a Kysely query on the `courses`
 * table: min_credits, max_credits, level (comma-separated), gen_ed, all
 * breadth booleans, l_and_s, no_prereqs, sophomore_standing,
 * junior_standing, senior_standing.
 *
 * NOTE: `search_param` is intentionally NOT handled here. Task 8 (route
 * handler) owns all search_param logic, including an EXISTS subquery over
 * instructor names — applying search_param in both places would
 * double-filter results.
 */
export function applyCourseFilters(query: AnyQuery, params: Record<string, string>): AnyQuery {
  const {
    subject_code,
    min_credits,
    max_credits,
    level,
    gen_ed,
    ethnic_studies,
    social_science,
    humanities,
    biological_science,
    physical_science,
    natural_science,
    literature,
    l_and_s,
    no_prereqs,
    sophomore_standing,
    junior_standing,
    senior_standing,
  } = params;

  if (subject_code) {
    query = query.where(
      "courses.course_designation",
      "ilike",
      `${subject_code} %`
    );
  }

  if (min_credits) {
    query = query.where("courses.minimum_credits", ">=", parseInt(min_credits));
  }
  if (max_credits) {
    query = query.where("courses.maximum_credits", "<=", parseInt(max_credits));
  }

  if (level) {
    const levels = level.split(",").map((l) => l.trim());
    query = query.where("courses.level", "in", levels);
  }

  if (gen_ed) {
    query = query.where("courses.general_education", "=", gen_ed);
  }

  // Breadth booleans
  const breadthFields = [
    ["ethnic_studies", ethnic_studies],
    ["social_science", social_science],
    ["humanities", humanities],
    ["biological_science", biological_science],
    ["physical_science", physical_science],
    ["natural_science", natural_science],
    ["literature", literature],
  ] as const;

  for (const [field, value] of breadthFields) {
    if (value === "true") {
      query = query.where(`courses.${field}` as any, "=", true);
    }
  }

  if (l_and_s === "true") {
    query = query.where("courses.letters_and_science_credits", "=", true);
  }

  // Prerequisite filters — these compose with OR among themselves
  const prereqConditions: Array<(eb: ExpressionBuilder<Database, "courses">) => any> = [];
  if (no_prereqs === "true") {
    prereqConditions.push((eb) => eb("courses.enrollment_prerequisites", "=", "None"));
  }
  if (sophomore_standing === "true") {
    prereqConditions.push((eb) =>
      eb.or([
        eb("courses.enrollment_prerequisites", "=", "Sophomore standing"),
        eb("courses.enrollment_prerequisites", "=", "Sophomore standing only"),
      ])
    );
  }
  if (junior_standing === "true") {
    prereqConditions.push((eb) =>
      eb.or([
        eb("courses.enrollment_prerequisites", "=", "Junior standing"),
        eb("courses.enrollment_prerequisites", "=", "Junior standing only"),
      ])
    );
  }
  if (senior_standing === "true") {
    prereqConditions.push((eb) =>
      eb.or([
        eb("courses.enrollment_prerequisites", "=", "Senior standing"),
        eb("courses.enrollment_prerequisites", "=", "Senior standing only"),
      ])
    );
  }
  if (prereqConditions.length > 0) {
    query = query.where((eb) => eb.or(prereqConditions.map((fn) => fn(eb))));
  }

  return query;
}
