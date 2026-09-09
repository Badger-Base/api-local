import { describe, test, expect } from "bun:test";
import { renderCourseDetail, renderCourseVariants } from "../pg/mcp/render.ts";
import type { CourseResponse, SectionResponse } from "../pg/types.ts";

const section = (o: Record<string, unknown> = {}) =>
  ({
    section_id: "LEC001",
    section_uuid: "s1",
    status: "OPEN",
    available_seats: 12,
    waitlist_total: 0,
    capacity: 100,
    enrolled: 88,
    instruction_mode: "In Person",
    is_asynchronous: false,
    section_avg_rating: 4.1,
    section_avg_difficulty: 2.9,
    section_total_ratings: 30,
    section_avg_would_take_again: 88,
    section_requisites: null,
    instructors: [{ full_name: "Ada Lovelace", avg_rating: 4.1 }],
    meetings: [{ days: "MWF", start_time: "09:55", end_time: "10:45", building: "CS", room: "1240" }],
    ...o,
  }) as unknown as SectionResponse;

const course = (o: Record<string, unknown> = {}) =>
  ({
    course_uuid: "u1",
    course_designation: "COMP SCI 400",
    full_course_designation: "COMP SCI 400",
    course_title: "Programming III",
    minimum_credits: 3,
    maximum_credits: 3,
    cumulative_gpa: 3.21,
    course_description: "Object-oriented design and data structures.",
    enrollment_prerequisites: "COMP SCI 300",
    sections: [section()],
    ...o,
  }) as unknown as CourseResponse;

describe("renderCourseDetail", () => {
  test("includes the fields search deliberately drops", () => {
    const out = renderCourseDetail(course());
    expect(out).toContain("Object-oriented design");
    expect(out).toContain("COMP SCI 300");
    expect(out).toContain("Ada Lovelace");
    expect(out).toContain("MWF");
  });

  test("never emits undefined or null for missing optional fields", () => {
    const out = renderCourseDetail(
      course({
        course_description: null,
        enrollment_prerequisites: null,
        cumulative_gpa: null,
        course_title: null,
        sections: [section({ instructors: [], meetings: [], section_avg_rating: null })],
      })
    );
    expect(out).not.toMatch(/undefined|null|NaN/);
  });

  test("caps sections at 25 and says how many were omitted", () => {
    const many = Array.from({ length: 40 }, (_, i) => section({ section_id: `LEC${i}` }));
    const out = renderCourseDetail(course({ sections: many }));
    const shown = out.split("\n").filter((l) => l.includes("LEC")).length;
    expect(shown).toBeLessThanOrEqual(25);
    expect(out).toMatch(/15 more sections/);
  });

  test("says plainly when a course has no sections", () => {
    const out = renderCourseDetail(course({ sections: [] }));
    expect(out).toMatch(/no sections/i);
  });
});

describe("renderCourseVariants", () => {
  test("lists each variant with what distinguishes it, not full detail", () => {
    const out = renderCourseVariants(
      [
        course({ course_uuid: "a", course_title: "Topics: Vision" }),
        course({ course_uuid: "b", course_title: "Topics: Robotics" }),
      ],
      "PSYCH 621"
    );
    expect(out).toContain("PSYCH 621");
    expect(out).toContain("Topics: Vision");
    expect(out).toContain("Topics: Robotics");
    expect(out).not.toContain("Object-oriented design");
    expect(out).toMatch(/2 courses|narrow|which/i);
  });
});
