import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDb, type TestDb } from "./setup.ts";
import { fixture } from "./fixtures/default.ts";
import { applyCourseFilters } from "../pg/builders/course-filter.ts";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await setupTestDb();
  await testDb.seed(fixture);
});

afterAll(async () => {
  await testDb.teardown();
});

async function queryWithFilters(params: Record<string, string>) {
  let query = testDb.db
    .selectFrom("courses")
    .select("courses.course_uuid");
  query = applyCourseFilters(query, params);
  const rows = await query.execute();
  return rows.map((r) => r.course_uuid).sort();
}

describe("course-level filters", () => {
  it("level filters single value", async () => {
    const result = await queryWithFilters({ level: "Advanced" });
    expect(result).toEqual(["uuid-cs577"]);
  });

  it("level filters comma-separated", async () => {
    const result = await queryWithFilters({ level: "Elementary,Advanced" });
    expect(result).toContain("uuid-cs200");
    expect(result).toContain("uuid-math221");
    expect(result).toContain("uuid-cs577");
  });

  it("ethnic_studies boolean filter", async () => {
    const result = await queryWithFilters({ ethnic_studies: "true" });
    expect(result).toEqual(["uuid-cs302"]);
  });

  it("natural_science boolean filter", async () => {
    const result = await queryWithFilters({ natural_science: "true" });
    expect(result).toEqual(["uuid-math221"]);
  });

  it("no_prereqs filter", async () => {
    const result = await queryWithFilters({ no_prereqs: "true" });
    expect(result).toContain("uuid-cs200");
    expect(result).toContain("uuid-math221");
    expect(result).not.toContain("uuid-cs400");
  });

  it("min_credits filter", async () => {
    const result = await queryWithFilters({ min_credits: "4" });
    expect(result).toContain("uuid-math221");
    expect(result).toContain("uuid-cs577");
    expect(result).not.toContain("uuid-cs200");
  });

  it("max_credits filter", async () => {
    const result = await queryWithFilters({ max_credits: "3" });
    expect(result).toContain("uuid-cs200");
    expect(result).toContain("uuid-cs400");
    expect(result).toContain("uuid-cs302");
    expect(result).not.toContain("uuid-math221");
    expect(result).not.toContain("uuid-cs577");
  });

  it("gen_ed filter", async () => {
    const result = await queryWithFilters({ gen_ed: "QR-A" });
    expect(result).toEqual(["uuid-math221"]);
  });

  it("l_and_s filter", async () => {
    const result = await queryWithFilters({ l_and_s: "true" });
    // All fixture courses have letters_and_science_credits: true
    expect(result).toEqual(
      ["uuid-cs200", "uuid-cs302", "uuid-cs400", "uuid-cs577", "uuid-math221"].sort()
    );
  });

  it("humanities boolean filter", async () => {
    const result = await queryWithFilters({ humanities: "true" });
    expect(result).toEqual(["uuid-cs400"]);
  });

  it("social_science boolean filter", async () => {
    const result = await queryWithFilters({ social_science: "true" });
    expect(result).toEqual(["uuid-cs302"]);
  });

  it("junior_standing filter", async () => {
    const result = await queryWithFilters({ junior_standing: "true" });
    expect(result).toEqual(["uuid-cs577"]);
  });

  it("sophomore_standing filter matches nothing in fixture", async () => {
    const result = await queryWithFilters({ sophomore_standing: "true" });
    expect(result).toEqual([]);
  });

  it("senior_standing filter matches nothing in fixture", async () => {
    const result = await queryWithFilters({ senior_standing: "true" });
    expect(result).toEqual([]);
  });

  it("no filters returns all courses", async () => {
    const result = await queryWithFilters({});
    expect(result.length).toBe(5);
  });

  it("multiple filters compose with AND", async () => {
    const result = await queryWithFilters({
      level: "Elementary",
      no_prereqs: "true",
    });
    expect(result).toContain("uuid-cs200");
    expect(result).toContain("uuid-math221");
    expect(result).not.toContain("uuid-cs577");
  });

  it("does not implement search_param (Task 8 owns it)", async () => {
    // search_param is intentionally ignored by applyCourseFilters — it
    // should have no filtering effect here.
    const result = await queryWithFilters({ search_param: "Algorithms" });
    expect(result.length).toBe(5);
  });
});
