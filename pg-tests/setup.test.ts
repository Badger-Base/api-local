import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDb, type TestDb } from "./setup.ts";
import { fixture } from "./fixtures/default.ts";

describe("pg-tests setup", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb();
    await testDb.seed(fixture);
  });

  afterAll(async () => {
    await testDb.teardown();
  });

  it("seeds and reads back a course", async () => {
    const course = await testDb.db
      .selectFrom("courses")
      .selectAll()
      .where("course_id", "=", "CS200")
      .executeTakeFirstOrThrow();

    expect(course.course_title).toBe("Programming I");
    expect(course.subject_code).toBe("COMP SCI");
  });

  it("seeds all subjects, courses, and sections", async () => {
    const courses = await testDb.db.selectFrom("courses").selectAll().execute();
    const sections = await testDb.db.selectFrom("sections").selectAll().execute();
    expect(courses.length).toBe(7);
    expect(sections.length).toBe(11);
  });

  it("links section_instructors to the correct sections", async () => {
    const instructors = await testDb.db
      .selectFrom("section_instructors")
      .selectAll()
      .where("section_id", "in", [1, 2])
      .execute();

    const bySection = new Map(instructors.map((i) => [i.section_id, i.instructor_name]));
    expect(bySection.get(1)).toBe("Bad Prof");
    expect(bySection.get(2)).toBe("Good Prof");
  });

  it("exercises the cross-section filtering bug fixture", async () => {
    // CS200 (course id 1) has section 1 (OPEN, Bad Prof, rating 2.0) and
    // section 2 (CLOSED, Good Prof, rating 4.5). No single section is both
    // OPEN and taught by a highly-rated instructor, so a correct per-section
    // filter for status=OPEN AND min_rating>=4.0 must NOT match CS200.
    const matchingSections = await testDb.db
      .selectFrom("sections")
      .innerJoin("section_instructors", "section_instructors.section_id", "sections.id")
      .innerJoin("rmp_cleaned", "rmp_cleaned.full_name", "section_instructors.instructor_name")
      .select(["sections.id", "sections.course_ref"])
      .where("sections.course_ref", "=", 1)
      .where("sections.status", "=", "OPEN")
      .where("rmp_cleaned.avg_rating", ">=", 4.0)
      .execute();

    expect(matchingSections.length).toBe(0);
  });

  it("seeds rmp_cleaned with a null-rating instructor", async () => {
    const ta = await testDb.db
      .selectFrom("rmp_cleaned")
      .selectAll()
      .where("full_name", "=", "TA Person")
      .executeTakeFirstOrThrow();

    expect(ta.avg_rating).toBeNull();
  });

  it("seeds madgrades data for every course", async () => {
    const grades = await testDb.db.selectFrom("madgrades_course_grades").selectAll().execute();
    expect(grades.length).toBe(5);
  });
});
