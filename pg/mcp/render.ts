import type { ApiQueryResponse, CourseResponse, SectionResponse } from "../types.ts";

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

/** At most this many sections are rendered for one course. */
const MAX_SECTIONS = 25;

function renderSection(s: SectionResponse): string {
  const seats =
    s.status === "OPEN"
      ? `${s.available_seats} seats open`
      : s.waitlist_total > 0
        ? `waitlist ${s.waitlist_total}`
        : "full";
  const mode = s.instruction_mode ? ` · ${s.instruction_mode}` : "";
  const names = s.instructors.map((i) => i.name).filter(Boolean);
  const who = names.length ? ` · ${names.join(", ")}` : "";
  const rating =
    s.section_avg_rating == null ? "" : ` (RMP ${s.section_avg_rating.toFixed(1)})`;
  const when = s.meetings
    .map((m) => [m.meeting_days, m.start_time && m.end_time ? `${m.start_time}-${m.end_time}` : null]
      .filter(Boolean)
      .join(" "))
    .filter((t) => t.length > 0)
    .join("; ");
  const meets = when ? ` · ${when}` : "";
  return `  ${s.section_id} · ${s.status} · ${seats}${mode}${who}${rating}${meets}`;
}

export function renderCourseDetail(c: CourseResponse): string {
  const name = c.full_course_designation ?? c.course_designation;
  const lines: string[] = [c.course_title ? `${name} — ${c.course_title}` : name];

  const credits =
    c.minimum_credits != null && c.maximum_credits != null && c.minimum_credits !== c.maximum_credits
      ? `${c.minimum_credits}-${c.maximum_credits} cr`
      : c.minimum_credits ?? c.maximum_credits;
  if (credits != null) lines.push(`Credits: ${credits}`);
  if (c.cumulative_gpa != null) lines.push(`Average GPA: ${c.cumulative_gpa.toFixed(2)}`);
  if (c.course_description) lines.push(`\n${c.course_description}`);
  if (c.enrollment_prerequisites) lines.push(`\nPrerequisites: ${c.enrollment_prerequisites}`);

  const sections = Array.isArray(c.sections) ? c.sections : [];
  if (sections.length === 0) {
    lines.push("\nThis course has no sections listed.");
    return lines.join("\n");
  }

  const shown = sections.slice(0, MAX_SECTIONS);
  lines.push(`\nSections (${sections.length}):`);
  for (const s of shown) lines.push(renderSection(s));
  if (sections.length > shown.length) {
    const more = sections.length - shown.length;
    lines.push(`  …and ${more} more section${more === 1 ? "" : "s"}.`);
  }
  return lines.join("\n");
}

export function renderCourseVariants(courses: CourseResponse[], designation: string): string {
  const lines = [
    `${designation} matches ${courses.length} courses — they share a designation but differ in content. Use search_courses to narrow by title, then ask again:`,
  ];
  for (const c of courses) {
    const title = c.course_title ?? "(untitled)";
    const count = Array.isArray(c.sections) ? c.sections.length : 0;
    lines.push(`  ${title} · ${count} section${count === 1 ? "" : "s"}`);
  }
  return lines.join("\n");
}
