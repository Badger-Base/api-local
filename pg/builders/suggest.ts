import { sql, type Kysely } from "kysely";
import type { Database, Suggestion } from "../types.ts";

/**
 * Minimum trigram similarity for a fuzzy (non-substring) match to qualify.
 * Matches Postgres' own `pg_trgm.similarity_threshold` default, which the
 * `%` operator in the index-using prefilter relies on.
 */
export const SIMILARITY_FLOOR = 0.3;

export interface ScoredSuggestion extends Suggestion {
  score: number;
}

/**
 * Escapes LIKE/ILIKE metacharacters so user input matches literally.
 * Backslash must be escaped first, or it would double-escape the
 * backslashes this function itself inserts.
 */
export function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Scoring tiers are inlined in the SQL below rather than factored into a
 * helper: Kysely's `sql` tag binds parameters positionally, so a composed
 * fragment cannot reuse a named binding across call sites. The repetition is
 * deliberate — the tier constants are spaced by 1.0, which exceeds the
 * maximum possible similarity, so tiers can never interleave.
 */

interface CourseRow {
  course_uuid: string;
  course_designation: string;
  course_title: string | null;
  score: number;
}

/**
 * Returns scored course suggestions, best first.
 *
 * The inner query's WHERE clause exists to hit the GIN trigram indexes:
 * `ILIKE '%x%'` and the `%` similarity operator are both index-supported by
 * `gin_trgm_ops` — but only against the bare column. A GIN index on
 * `course_title` cannot serve a predicate on the *expression*
 * `COALESCE(course_title, '')`, so the six prefilter predicates below use
 * bare columns, not COALESCE-wrapped ones. This is result-preserving:
 * `NULL ILIKE ...` and `NULL % ...` both evaluate to NULL, which an
 * OR-chain treats the same as FALSE. The scoring CASE expressions above
 * still use COALESCE — they run only on rows that already passed the
 * prefilter, aren't index-servable regardless, and need COALESCE so
 * `similarity(NULL, ...)` doesn't produce a NULL score. The outer query
 * then applies the explicit floor, which cannot live in the inner WHERE
 * because it references the computed alias.
 */
export async function searchCourses(
  db: Kysely<Database>,
  q: string,
  limit: number
): Promise<ScoredSuggestion[]> {
  const escaped = escapeLikePattern(q);
  const prefixPattern = `${escaped}%`;
  const containsPattern = `%${escaped}%`;

  const result = await sql<CourseRow>`
    SELECT * FROM (
      SELECT
        c.course_uuid,
        c.course_designation,
        c.course_title,
        c.catalog_number,
        GREATEST(
          CASE
            WHEN c.course_designation ILIKE ${prefixPattern} THEN 2.0 + similarity(c.course_designation, ${q})
            WHEN c.course_designation ILIKE ${containsPattern} THEN 1.0 + similarity(c.course_designation, ${q})
            ELSE similarity(c.course_designation, ${q})
          END,
          CASE
            WHEN COALESCE(c.course_title, '') ILIKE ${prefixPattern} THEN 2.0 + similarity(COALESCE(c.course_title, ''), ${q})
            WHEN COALESCE(c.course_title, '') ILIKE ${containsPattern} THEN 1.0 + similarity(COALESCE(c.course_title, ''), ${q})
            ELSE similarity(COALESCE(c.course_title, ''), ${q})
          END,
          CASE
            WHEN COALESCE(c.full_course_designation, '') ILIKE ${prefixPattern} THEN 2.0 + similarity(COALESCE(c.full_course_designation, ''), ${q})
            WHEN COALESCE(c.full_course_designation, '') ILIKE ${containsPattern} THEN 1.0 + similarity(COALESCE(c.full_course_designation, ''), ${q})
            ELSE similarity(COALESCE(c.full_course_designation, ''), ${q})
          END
        ) AS score
      FROM courses c
      WHERE c.course_designation ILIKE ${containsPattern}
         OR c.course_title ILIKE ${containsPattern}
         OR c.full_course_designation ILIKE ${containsPattern}
         OR c.course_designation % ${q}
         OR c.course_title % ${q}
         OR c.full_course_designation % ${q}
    ) scored
    WHERE scored.score >= ${SIMILARITY_FLOOR}
    ORDER BY scored.score DESC, scored.catalog_number ASC NULLS LAST
    LIMIT ${limit}
  `.execute(db);

  return result.rows.map((row) => ({
    type: "course" as const,
    value: row.course_designation,
    label: row.course_designation,
    sublabel: row.course_title,
    course_uuid: row.course_uuid,
    score: Number(row.score),
  }));
}

interface InstructorRow {
  name: string;
  section_count: number;
  score: number;
}

/**
 * Returns scored instructor suggestions, best first, one row per distinct
 * instructor name. The score expression is computed on the GROUP BY key, so
 * it needs no aggregate wrapper.
 */
export async function searchInstructors(
  db: Kysely<Database>,
  q: string,
  limit: number
): Promise<ScoredSuggestion[]> {
  const escaped = escapeLikePattern(q);
  const prefixPattern = `${escaped}%`;
  const containsPattern = `%${escaped}%`;

  const result = await sql<InstructorRow>`
    SELECT * FROM (
      SELECT
        si.instructor_name AS name,
        COUNT(DISTINCT si.section_id)::int AS section_count,
        CASE
          WHEN si.instructor_name ILIKE ${prefixPattern} THEN 2.0 + similarity(si.instructor_name, ${q})
          WHEN si.instructor_name ILIKE ${containsPattern} THEN 1.0 + similarity(si.instructor_name, ${q})
          ELSE similarity(si.instructor_name, ${q})
        END AS score
      FROM section_instructors si
      WHERE si.instructor_name ILIKE ${containsPattern}
         OR si.instructor_name % ${q}
      GROUP BY si.instructor_name
    ) scored
    WHERE scored.score >= ${SIMILARITY_FLOOR}
    ORDER BY scored.score DESC, scored.section_count DESC, scored.name ASC
    LIMIT ${limit}
  `.execute(db);

  return result.rows.map((row) => ({
    type: "instructor" as const,
    value: row.name,
    label: row.name,
    sublabel: `Instructor · ${row.section_count} ${
      row.section_count === 1 ? "section" : "sections"
    }`,
    course_uuid: null,
    score: Number(row.score),
  }));
}

/**
 * Merges the two result sets by score, then guarantees an instructor slot:
 * a student searching a professor's name should never get a dropdown of
 * only course codes. Drops the internal score from the returned objects.
 */
export function mergeSuggestions(
  courses: ScoredSuggestion[],
  instructors: ScoredSuggestion[],
  limit: number
): Suggestion[] {
  const ranked = [...courses, ...instructors].sort((a, b) => b.score - a.score);
  const top = ranked.slice(0, limit);

  const hasInstructor = top.some((s) => s.type === "instructor");
  if (!hasInstructor && instructors.length > 0 && top.length === limit) {
    top[top.length - 1] = instructors[0];
  }

  return top.map(({ score, ...suggestion }) => suggestion);
}
