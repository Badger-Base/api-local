import type { StudentSubscriptions } from "../subscriptions-query.ts";

/**
 * Renders what a student is watching, for a model rather than a browser.
 * Section lines carry status and seat count because "is my waitlisted
 * section open yet" is the question these subscriptions exist to answer.
 */
export function renderSubscriptions(subs: StudentSubscriptions): string {
  if (subs.courses.length === 0 && subs.sections.length === 0) {
    return "You are not watching any courses or sections. Subscribing to one on BadgerBase sends you an email when seats open.";
  }

  const lines: string[] = [];

  if (subs.courses.length > 0) {
    lines.push(`Courses you're watching (${subs.courses.length}):`);
    for (const c of subs.courses) {
      lines.push(`  ${c.designation}${c.title ? ` — ${c.title}` : ""}`);
    }
  }

  if (subs.sections.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Sections you're watching (${subs.sections.length}):`);
    for (const s of subs.sections) {
      lines.push(
        `  ${s.designation} ${s.section_id} · ${s.status} · ${s.available_seats} seats open`
      );
    }
  }

  return lines.join("\n");
}
