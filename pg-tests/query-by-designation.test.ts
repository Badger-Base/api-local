import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDb, type TestDb } from "./setup.ts";
import { fixture } from "./fixtures/default.ts";
import { findCoursesByDesignation } from "../pg/query.ts";

let testDb: TestDb;
const mockCache = { get: async () => null, set: async () => {}, bustAll: async () => {} };

beforeAll(async () => {
  testDb = await setupTestDb();
  await testDb.seed(fixture);
});
afterAll(async () => {
  await testDb.teardown();
});

// The fixture's only designation with exactly one match (and a
// madgrades_course_grades row, required for a course to qualify at all —
// see runCourseQuery's inner join) is COMP SCI 400.
describe("findCoursesByDesignation", () => {
  test("finds a course by its exact designation", async () => {
    const found = await findCoursesByDesignation(testDb.db, mockCache, "COMP SCI 400");
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].course_designation).toBe("COMP SCI 400");
  });

  test("is case- and whitespace-insensitive", async () => {
    const found = await findCoursesByDesignation(testDb.db, mockCache, "  comp sci 400 ");
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].course_designation).toBe("COMP SCI 400");
  });

  test("collapses doubled internal spaces", async () => {
    // The trim/case path and the \s+ collapse are separate branches; the
    // case above only exercises the first.
    const found = await findCoursesByDesignation(testDb.db, mockCache, "COMP  SCI   400");
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].course_designation).toBe("COMP SCI 400");
  });

  test("returns an empty array for an unknown designation", async () => {
    expect(await findCoursesByDesignation(testDb.db, mockCache, "BASKET 999")).toEqual([]);
  });

  test("returns hydrated sections, which detail rendering depends on", async () => {
    const found = await findCoursesByDesignation(testDb.db, mockCache, "COMP SCI 400");
    // Array.isArray alone would still pass if hydration regressed to always
    // returning [], which is exactly the failure get_course would suffer.
    expect(found[0].sections.length).toBeGreaterThan(0);
    const withInstructors = found[0].sections.some((s) => s.instructors.length > 0);
    const withMeetings = found[0].sections.some((s) => s.meetings.length > 0);
    expect(withInstructors).toBe(true);
    expect(withMeetings).toBe(true);
  });
});
