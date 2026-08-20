import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDb, type TestDb } from "./setup.ts";
import { fixture } from "./fixtures/default.ts";
import { applyGradeFilters } from "../pg/builders/grade-filter.ts";
import { applySort } from "../pg/builders/sort.ts";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await setupTestDb();
  await testDb.seed(fixture);
});

afterAll(async () => {
  await testDb.teardown();
});

describe("grade filters", () => {
  async function queryWithGrades(params: Record<string, string>) {
    let query = testDb.db
      .selectFrom("courses")
      .innerJoin("madgrades_course_grades", "madgrades_course_grades.course_name", "courses.course_designation")
      .select("courses.course_uuid");
    query = applyGradeFilters(query, params);
    const rows = await query.execute();
    return rows.map((r) => r.course_uuid).sort();
  }

  it("min_cumulative_gpa filter", async () => {
    const result = await queryWithGrades({ min_cumulative_gpa: "3.0" });
    expect(result).toContain("uuid-cs200"); // 3.40
    expect(result).toContain("uuid-cs577"); // 3.10
    expect(result).toContain("uuid-cs302"); // 3.30
    expect(result).not.toContain("uuid-cs400"); // 2.90
    expect(result).not.toContain("uuid-math221"); // 2.60
  });

  it("min_most_recent_gpa filter", async () => {
    const result = await queryWithGrades({ min_most_recent_gpa: "3.0" });
    expect(result).toContain("uuid-cs200"); // 3.50
    expect(result).toContain("uuid-cs577"); // 3.00
    expect(result).toContain("uuid-cs302"); // 3.35
    expect(result).not.toContain("uuid-cs400"); // 2.85
    expect(result).not.toContain("uuid-math221"); // 2.55
  });

  it("min_a_percent filter", async () => {
    const result = await queryWithGrades({ min_a_percent: "30" });
    expect(result).toContain("uuid-cs200"); // 35%
    expect(result).toContain("uuid-cs302"); // 30%
    expect(result).not.toContain("uuid-cs400"); // 20%
  });

  it("median_grade filter", async () => {
    const result = await queryWithGrades({ median_grade: "AB" });
    expect(result).toContain("uuid-cs200");
    expect(result).toContain("uuid-cs302");
    expect(result).not.toContain("uuid-cs400");
  });

  it("combines multiple filters (AND)", async () => {
    const result = await queryWithGrades({ min_cumulative_gpa: "3.0", median_grade: "AB" });
    expect(result).toContain("uuid-cs200"); // 3.40, AB
    expect(result).toContain("uuid-cs302"); // 3.30, AB
    expect(result).not.toContain("uuid-cs577"); // 3.10 but median B
  });

  it("no params returns all courses joined to grades", async () => {
    const result = await queryWithGrades({});
    expect(result).toEqual(
      ["uuid-cs200", "uuid-cs302", "uuid-cs400", "uuid-cs577", "uuid-math221"].sort()
    );
  });
});

describe("sort", () => {
  async function queryWithSort(sortParam: string) {
    let query = testDb.db
      .selectFrom("courses")
      .innerJoin("madgrades_course_grades", "madgrades_course_grades.course_name", "courses.course_designation")
      .select(["courses.course_uuid", "courses.catalog_number"]);
    query = applySort(query, { sort: sortParam });
    const rows = await query.execute();
    return rows.map((r) => r.course_uuid);
  }

  it("default sort by catalog_number ASC", async () => {
    const result = await queryWithSort("");
    expect(result).toEqual(["uuid-cs200", "uuid-math221", "uuid-cs302", "uuid-cs400", "uuid-cs577"]);
  });

  it("sort by cumulative_gpa DESC", async () => {
    const result = await queryWithSort("cumulative_gpa");
    expect(result).toEqual(["uuid-cs200", "uuid-cs302", "uuid-cs577", "uuid-cs400", "uuid-math221"]);
  });

  it("sort by recent_gpa DESC", async () => {
    const result = await queryWithSort("recent_gpa");
    expect(result).toEqual(["uuid-cs200", "uuid-cs302", "uuid-cs577", "uuid-cs400", "uuid-math221"]);
  });

  it("is case-insensitive for sort value", async () => {
    const result = await queryWithSort("CUMULATIVE_GPA");
    expect(result[0]).toBe("uuid-cs200");
  });
});
