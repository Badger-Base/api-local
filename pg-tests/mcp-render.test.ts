import { describe, test, expect } from "bun:test";
import { renderCourseResults } from "../pg/mcp/render.ts";
import type { ApiQueryResponse, CourseResponse } from "../pg/types.ts";

const course = (o: Partial<CourseResponse> = {}): CourseResponse =>
  ({
    course_uuid: "u1",
    course_id: "000001",
    subject_code: "COMP SCI",
    course_designation: "COMP SCI 400",
    full_course_designation: "COMP SCI 400",
    course_title: "Programming III",
    catalog_number: 400,
    minimum_credits: 3,
    maximum_credits: 3,
    cumulative_gpa: 3.21,
    sections: [],
    ...o,
  }) as unknown as CourseResponse;

const response = (data: CourseResponse[], total = data.length): ApiQueryResponse => ({
  data,
  count: data.length,
  total_count: total,
  has_more: total > data.length,
});

describe("renderCourseResults", () => {
  test("renders one line per course with the fields a student picks on", () => {
    const out = renderCourseResults(response([course()]), {});
    expect(out).toContain("COMP SCI 400");
    expect(out).toContain("Programming III");
    expect(out).toContain("3.21");
  });

  test("stays compact — no raw JSON, no description dumps", () => {
    const out = renderCourseResults(
      response([course({ course_description: "x".repeat(5000) })]),
      {}
    );
    expect(out.length).toBeLessThan(600);
    expect(out).not.toContain("course_uuid");
  });

  test("reports the total and says how to narrow when truncated", () => {
    const out = renderCourseResults(response([course()], 240), {});
    expect(out).toContain("240");
    expect(out).toMatch(/narrow|refine|filter/i);
  });

  test("says plainly when nothing matched", () => {
    const out = renderCourseResults(response([], 0), { subject_code: "BASKET" });
    expect(out).toMatch(/no (courses|results)/i);
    expect(out).not.toMatch(/undefined|null/);
  });

  test("never emits undefined for missing optional fields", () => {
    const out = renderCourseResults(
      response([course({ course_title: null, cumulative_gpa: null, minimum_credits: null })]),
      {}
    );
    expect(out).not.toMatch(/undefined|null|NaN/);
  });

  test("scales linearly — 25 courses stay within a sane budget", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      course({ course_designation: `COMP SCI ${400 + i}`, course_uuid: `u${i}` })
    );
    const out = renderCourseResults(response(many, 25), {});
    expect(out.length).toBeLessThan(4000);
  });

  test("reports how many sections are open", () => {
    const out = renderCourseResults(
      response([
        course({
          sections: [
            { status: "OPEN" },
            { status: "CLOSED" },
            { status: "OPEN" },
          ] as CourseResponse["sections"],
        }),
      ]),
      {}
    );
    expect(out).toContain("2/3 sections open");
  });
});
