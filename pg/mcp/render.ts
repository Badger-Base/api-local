import type { ApiQueryResponse, CourseResponse } from "../types.ts";

/**
 * Renders search results for a language model rather than a browser.
 *
 * CourseResponse carries thirty-odd fields per course plus nested sections,
 * meetings and instructors. Handing that back as JSON would fill the model's
 * context in a couple of calls and degrade worst on broad searches, which are
 * exactly the ones a student asks first. So this emits one line per course
 * with only what a choice actually turns on, and states the total separately
 * so the model can tell "these are all of them" from "these are the first
 * few".
 */
function credits(c: CourseResponse): string {
  const min = c.minimum_credits;
  const max = c.maximum_credits;
  if (min == null && max == null) return "";
  if (min != null && max != null && min !== max) return ` · ${min}-${max} cr`;
  return ` · ${min ?? max} cr`;
}

function gpa(c: CourseResponse): string {
  return c.cumulative_gpa == null ? "" : ` · GPA ${c.cumulative_gpa.toFixed(2)}`;
}

function openSections(c: CourseResponse): string {
  const sections = c.sections;
  if (!Array.isArray(sections) || sections.length === 0) return "";
  const open = sections.filter((s) => s.status === "OPEN").length;
  return ` · ${open}/${sections.length} sections open`;
}

export function renderCourseResults(
  res: ApiQueryResponse,
  params: Record<string, string>
): string {
  if (res.data.length === 0) {
    const applied = Object.entries(params)
      .filter(([k]) => k !== "limit" && k !== "page")
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    return applied
      ? `No courses matched ${applied}. Try removing a filter.`
      : "No courses matched.";
  }

  const lines = res.data.map((c) => {
    const name = c.full_course_designation ?? c.course_designation;
    const title = c.course_title ? ` — ${c.course_title}` : "";
    return `${name}${title}${credits(c)}${gpa(c)}${openSections(c)}`;
  });

  const header =
    res.total_count === res.data.length
      ? `${res.total_count} course${res.total_count === 1 ? "" : "s"}:`
      : `Showing ${res.data.length} of ${res.total_count} courses — narrow with subject_code, level, or min_gpa to see the rest:`;

  return [header, ...lines].join("\n");
}
