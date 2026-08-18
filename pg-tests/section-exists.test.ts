import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDb, type TestDb } from "./setup.ts";
import { fixture } from "./fixtures/default.ts";
import { applySectionExists } from "../pg/builders/section-exists.ts";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await setupTestDb();
  await testDb.seed(fixture);
});

afterAll(async () => {
  await testDb.teardown();
});

async function queryWithSectionFilters(params: Record<string, string>) {
  let query = testDb.db.selectFrom("courses").select("courses.course_uuid");
  query = applySectionExists(query, params);
  const rows = await query.execute();
  return rows.map((r) => r.course_uuid).sort();
}

describe("section EXISTS builder", () => {
  // THE CROSS-SECTION BUG TEST
  // CS200: sec 1 is OPEN (Bad Prof, rating 2.0), sec 2 is CLOSED (Good Prof, rating 4.5)
  // Filtering status=OPEN AND min_rating=4.0 should NOT return CS200
  // because no single section is both OPEN and has rating >= 4.0
  it("conjunctive filtering: status + RMP on same section", async () => {
    const result = await queryWithSectionFilters({
      status: "OPEN",
      min_section_avg_rating: "4.0",
    });
    expect(result).not.toContain("uuid-cs200"); // This is the bug fix
    expect(result).toContain("uuid-cs400");     // CS400 sec 3: OPEN + Good Prof (4.5)
    expect(result).toContain("uuid-cs302");     // CS302 sec 7: OPEN + Data Scientist (4.0)
  });

  it("status filter single value", async () => {
    const result = await queryWithSectionFilters({ status: "OPEN" });
    expect(result).toContain("uuid-cs200");   // has OPEN section
    expect(result).toContain("uuid-cs400");
    expect(result).not.toContain("uuid-cs577"); // all sections CLOSED
  });

  it("status filter comma-separated", async () => {
    const result = await queryWithSectionFilters({ status: "OPEN,WAITLISTED" });
    expect(result).toContain("uuid-cs200");
    expect(result).toContain("uuid-math221"); // has WAITLISTED and OPEN sections
  });

  it("min_available_seats filter", async () => {
    const result = await queryWithSectionFilters({ min_available_seats: "20" });
    expect(result).toContain("uuid-cs200");   // sec 1: 50 seats
    expect(result).toContain("uuid-cs400");   // sec 3: 30 seats
    expect(result).toContain("uuid-cs302");   // sec 7: 25 seats
    expect(result).not.toContain("uuid-cs577"); // sec 6: 0 seats
  });

  it("instruction_mode filter", async () => {
    const result = await queryWithSectionFilters({ instruction_mode: "Online" });
    expect(result).toEqual(["uuid-math221"]); // only MATH 221 sec 5 is Online
  });

  it("no section filters returns all courses", async () => {
    const result = await queryWithSectionFilters({});
    expect(result.length).toBe(5);
  });

  it("schedule filter: monday time range", async () => {
    // Filter for sections that meet on Monday between 9:00 AM and 11:00 AM
    // (32400000 ms to 39600000 ms)
    // Should match CS200 sec 1 (mon 35700000-38700000) and MATH 221 sec 4 (mon 31800000-34800000)
    const result = await queryWithSectionFilters({
      mondayStartTime: "32400000",
      mondayEndTime: "39600000",
    });
    expect(result).toContain("uuid-cs200");
    expect(result).toContain("uuid-math221");
  });
});
