import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDb, type TestDb } from "./setup.ts";
import { runCourseQuery } from "../pg/query.ts";
import { fixture } from "./fixtures/default.ts";

let testDb: TestDb;

const mockCache = {
  get: async () => null,
  set: async () => {},
  bustAll: async () => {},
};

beforeAll(async () => {
  testDb = await setupTestDb();
  await testDb.seed(fixture);
});
afterAll(async () => {
  await testDb.teardown();
});

describe("runCourseQuery", () => {
  test("returns the same shape the REST route returns", async () => {
    const res = await runCourseQuery(testDb.db, mockCache, { limit: "5" });
    expect(Array.isArray(res.data)).toBe(true);
    expect(typeof res.total_count).toBe("number");
    expect(typeof res.has_more).toBe("boolean");
    expect(res.count).toBe(res.data.length);
  });

  test("honours limit and reports has_more", async () => {
    const res = await runCourseQuery(testDb.db, mockCache, { limit: "1" });
    expect(res.data.length).toBeLessThanOrEqual(1);
    if (res.total_count > 1) expect(res.has_more).toBe(true);
  });

  test("filters by subject_code", async () => {
    const res = await runCourseQuery(testDb.db, mockCache, { subject_code: "COMP SCI" });
    for (const course of res.data) expect(course.subject_code).toBe("COMP SCI");
  });
});
