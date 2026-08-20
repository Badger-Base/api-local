import { sql, type SelectQueryBuilder, type ExpressionBuilder } from "kysely";
import type { Database } from "../types.ts";

type AnyCoursesQuery = SelectQueryBuilder<Database, "courses", any>;

interface SectionFilterParams {
  status?: string;
  min_available_seats?: string;
  instruction_mode?: string;
  min_section_avg_rating?: string;
  min_section_avg_difficulty?: string;
  min_section_total_ratings?: string;
  min_section_avg_would_take_again?: string;
  in_person_only?: string;
  mondayStartTime?: string;
  mondayEndTime?: string;
  tuesdayStartTime?: string;
  tuesdayEndTime?: string;
  wednesdayStartTime?: string;
  wednesdayEndTime?: string;
  thursdayStartTime?: string;
  thursdayEndTime?: string;
  fridayStartTime?: string;
  fridayEndTime?: string;
}

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"] as const;

/**
 * Adds an `EXISTS (SELECT 1 FROM sections WHERE sections.course_ref = courses.id
 * AND ...)` subquery to `query`, conjoining ALL section-level predicates
 * (status, seats, instruction mode, RMP rating, schedule) inside that single
 * EXISTS. This is the fix for the cross-section filtering bug: a course only
 * qualifies if at least one of its sections satisfies every predicate
 * simultaneously (e.g. an OPEN section taught by a highly-rated instructor),
 * rather than each predicate independently matching against possibly
 * different sections of the same course.
 */
export function applySectionExists(
  query: AnyCoursesQuery,
  params: Record<string, string>
): AnyCoursesQuery {
  const p: SectionFilterParams = params;

  const hasSectionFilter = !!(
    p.status ||
    p.min_available_seats ||
    p.instruction_mode ||
    p.min_section_avg_rating ||
    p.min_section_avg_difficulty ||
    p.min_section_total_ratings ||
    p.min_section_avg_would_take_again ||
    p.in_person_only ||
    p.mondayStartTime ||
    p.tuesdayStartTime ||
    p.wednesdayStartTime ||
    p.thursdayStartTime ||
    p.fridayStartTime
  );

  if (!hasSectionFilter) return query;

  return query.where(({ exists, selectFrom }) =>
    exists(buildSectionSubquery(selectFrom, p))
  ) as AnyCoursesQuery;
}

function buildSectionSubquery(
  selectFrom: ExpressionBuilder<Database, "courses">["selectFrom"],
  p: SectionFilterParams
) {
  let sub = (selectFrom as any)("sections")
    .select(sql`1`.as("one"))
    .whereRef("sections.course_ref", "=", "courses.id");

  // Status filter (comma-separated list, e.g. "OPEN,WAITLISTED")
  if (p.status) {
    const statuses = p.status.split(",").map((s) => s.trim().toUpperCase());
    sub = sub.where("sections.status", "in", statuses);
  }

  if (p.min_available_seats) {
    sub = sub.where(
      "sections.available_seats",
      ">=",
      parseInt(p.min_available_seats)
    );
  }

  if (p.instruction_mode) {
    sub = sub.where("sections.instruction_mode", "=", p.instruction_mode);
  }

  // RMP filters — require an inner EXISTS over section_instructors joined to
  // rmp_cleaned, correlated to THIS section (sections.id), so the rating
  // predicate applies to the same section as the status/seats/mode
  // predicates above.
  const needsRmp = !!(
    p.min_section_avg_rating ||
    p.min_section_avg_difficulty ||
    p.min_section_total_ratings ||
    p.min_section_avg_would_take_again
  );

  if (needsRmp) {
    sub = sub.where(({ exists, selectFrom: innerSelect }: any) =>
      exists(
        (() => {
          let rmpSub = innerSelect("section_instructors")
            .innerJoin(
              "rmp_cleaned",
              "rmp_cleaned.full_name",
              "section_instructors.instructor_name"
            )
            .select(sql`1`.as("one"))
            .whereRef("section_instructors.section_id", "=", "sections.id")
            .groupBy("section_instructors.section_id");

          if (p.min_section_avg_rating) {
            rmpSub = rmpSub.having(
              sql`AVG(rmp_cleaned.avg_rating)`,
              ">=",
              parseFloat(p.min_section_avg_rating)
            );
          }
          if (p.min_section_avg_difficulty) {
            rmpSub = rmpSub.having(
              sql`AVG(rmp_cleaned.avg_difficulty)`,
              ">=",
              parseFloat(p.min_section_avg_difficulty)
            );
          }
          if (p.min_section_total_ratings) {
            rmpSub = rmpSub.having(
              sql`SUM(rmp_cleaned.num_ratings)`,
              ">=",
              parseInt(p.min_section_total_ratings)
            );
          }
          if (p.min_section_avg_would_take_again) {
            rmpSub = rmpSub.having(
              sql`AVG(rmp_cleaned.would_take_again_percent)`,
              ">=",
              parseFloat(p.min_section_avg_would_take_again)
            );
          }

          return rmpSub;
        })()
      )
    );
  }

  // In-person filter: section must have at least one in-person meeting.
  // Separate from schedule because it's an EXISTS (positive) condition.
  if (p.in_person_only === "true") {
    sub = sub.where(({ exists, selectFrom: innerSelect }: any) =>
      exists(
        innerSelect("section_meetings")
          .select(sql`1`.as("one"))
          .whereRef("section_meetings.section_id", "=", "sections.id")
          .where("section_meetings.location", "!=", "ONLINE")
          .where("section_meetings.location", "!=", "OFF CAMPUS")
      )
    );
  }

  // Schedule filter: ALL meetings of the section must be compatible with the
  // user's availability. A meeting violates if it has times on an unfiltered
  // day, or times on a filtered day that fall outside the availability window.
  // NOT EXISTS (violating meeting) ensures every meeting fits.
  const dayFilters = DAYS.filter(
    (day) => p[`${day}StartTime` as keyof SectionFilterParams]
  );

  if (dayFilters.length > 0) {
    sub = sub.where(({ selectFrom: innerSelect }: any) => {
      let violatorSub = innerSelect("section_meetings")
        .select(sql`1`.as("one"))
        .whereRef("section_meetings.section_id", "=", "sections.id");

      violatorSub = violatorSub.where((eb: any) => {
        const violations: any[] = [];

        for (const day of DAYS) {
          if (!dayFilters.includes(day)) {
            violations.push(
              eb(
                `section_meetings.${day}_meeting_start` as any,
                "is not",
                null
              )
            );
          }
        }

        for (const day of dayFilters) {
          const start = parseInt(
            p[`${day}StartTime` as keyof SectionFilterParams]!
          );
          const end = parseInt(
            p[`${day}EndTime` as keyof SectionFilterParams]!
          );
          const startCol = `section_meetings.${day}_meeting_start` as any;
          const endCol = `section_meetings.${day}_meeting_end` as any;

          if (end > start) {
            violations.push(
              eb.and([
                eb(startCol, "is not", null),
                eb.or([eb(startCol, ">=", end), eb(endCol, "<=", start)]),
              ])
            );
          } else {
            // UTC wrapping: window is [start, MAX) ∪ [0, end).
            // Outside both sub-intervals: end_col <= start AND start_col >= end
            violations.push(
              eb.and([
                eb(startCol, "is not", null),
                eb(endCol, "<=", start),
                eb(startCol, ">=", end),
              ])
            );
          }
        }

        return eb.or(violations);
      });

      return sql`NOT EXISTS (${violatorSub})`;
    });
  }

  return sub;
}
