import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "kysely";
import { setupTestDb, type TestDb } from "./setup.ts";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await setupTestDb();
});

afterAll(async () => {
  await testDb.teardown();
});

describe("schema migrations", () => {
  it("installs the pg_trgm extension", async () => {
    const result = await sql<{ extname: string }>`
      SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'
    `.execute(testDb.db);
    expect(result.rows.length).toBe(1);
  });

  it("creates trigram GIN indexes on all searchable columns", async () => {
    const result = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname LIKE '%_trgm'
    `.execute(testDb.db);
    const names = result.rows.map((r) => r.indexname).sort();
    expect(names).toEqual([
      "idx_courses_designation_trgm",
      "idx_courses_full_designation_trgm",
      "idx_courses_title_trgm",
      "idx_section_instructors_name_trgm",
    ]);
  });

  it("similarity() is callable and scores a near-miss above the 0.3 floor", async () => {
    const result = await sql<{ score: number }>`
      SELECT similarity('COMP SCI 200', 'COMP SIC 200') AS score
    `.execute(testDb.db);
    expect(result.rows[0].score).toBeGreaterThan(0.3);
  });
});
