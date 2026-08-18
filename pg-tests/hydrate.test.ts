import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDb, type TestDb } from "./setup.ts";
import { fixture } from "./fixtures/default.ts";
import { hydrateCourses } from "../pg/hydrate.ts";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await setupTestDb();
  await testDb.seed(fixture);
});

afterAll(async () => {
  await testDb.teardown();
});

describe("hydrateCourses", () => {
  it("returns full course tree for given IDs", async () => {
    const courses = await hydrateCourses(testDb.db, [1]); // CS200
    expect(courses).toHaveLength(1);

    const cs200 = courses[0];
    expect(cs200.course_uuid).toBe("uuid-cs200");
    expect(cs200.course_title).toBe("Programming I");
    expect(cs200.ethnic_studies).toBe(false);
    expect(cs200.sections.length).toBeGreaterThanOrEqual(2);
  });

  it("sections have nested instructors", async () => {
    const courses = await hydrateCourses(testDb.db, [1]);
    const sec1 = courses[0].sections.find((s) => s.section_id === 1);
    expect(sec1).toBeDefined();
    expect(sec1!.instructors).toHaveLength(1);
    expect(sec1!.instructors[0].name).toBe("Bad Prof");
    expect(sec1!.instructors[0].avg_rating).toBe(2.0);
    expect(sec1!.instructors[0].rmp_instructor_id).toBe("rmp-1");
  });

  it("sections have nested meetings", async () => {
    const courses = await hydrateCourses(testDb.db, [1]);
    const sec1 = courses[0].sections.find((s) => s.section_id === 1);
    expect(sec1!.meetings).toHaveLength(1);
    expect(sec1!.meetings[0].meeting_days).toBe("MWF");
    expect(sec1!.meetings[0].building_name).toBe("Computer Sciences");
  });

  it("sections have computed RMP averages", async () => {
    const courses = await hydrateCourses(testDb.db, [1]);
    const sec1 = courses[0].sections.find((s) => s.section_id === 1);
    expect(sec1!.section_avg_rating).toBe(2.0); // Bad Prof only
  });

  it("includes madgrades data", async () => {
    const courses = await hydrateCourses(testDb.db, [1]);
    expect(courses[0].cumulative_gpa).toBe(3.4);
    expect(courses[0].median_grade).toBe("AB");
    expect(courses[0].a_percent).toBe(35.0);
  });

  it("handles multiple course IDs", async () => {
    const courses = await hydrateCourses(testDb.db, [1, 2, 3]);
    expect(courses).toHaveLength(3);
  });

  it("returns empty array for empty input", async () => {
    const courses = await hydrateCourses(testDb.db, []);
    expect(courses).toEqual([]);
  });
});
