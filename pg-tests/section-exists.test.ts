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
    expect(result.length).toBe(7);
  });

  // Schedule filter tests use NOT EXISTS (violating meeting) semantics:
  // A section passes only if ALL its meetings are on filtered days AND
  // within the time windows. Meetings on unfiltered days disqualify.
  //
  // Fixture meeting recap:
  //   CS200 sec 1 (MWF 35700000-38700000), sec 2 (TR 46800000-51300000), sec 8 (T 55800000-58800000)
  //   CS400 sec 3 (MWF 39600000-42600000)
  //   MATH221 sec 4 (MWF 31800000-34800000), sec 5 (online, all NULLs)
  //   CS577 sec 6 (no meeting rows)
  //   CS302 sec 7 (TR 52200000-56700000)

  it("schedule filter: MWF availability returns MWF-compatible courses", async () => {
    // MWF 30000000-50000000. Unfiltered: tue, thu.
    // sec 1 (MWF in range) ✓, sec 3 (MWF in range) ✓, sec 4 (MWF in range) ✓
    // sec 5 (online) ✓, sec 6 (no meetings) ✓
    // sec 2/7 (TR) excluded — tue/thu times on unfiltered days
    // sec 8 (T) excluded — tue times on unfiltered day
    const result = await queryWithSectionFilters({
      mondayStartTime: "30000000",
      mondayEndTime: "50000000",
      wednesdayStartTime: "30000000",
      wednesdayEndTime: "50000000",
      fridayStartTime: "30000000",
      fridayEndTime: "50000000",
    });
    expect(result).toContain("uuid-cs200");   // via sec 1
    expect(result).toContain("uuid-cs400");   // via sec 3
    expect(result).toContain("uuid-math221"); // via sec 4 or 5
    expect(result).toContain("uuid-cs577");   // via sec 6 (no meetings)
    expect(result).not.toContain("uuid-cs302"); // TR only, no MWF section
  });

  it("schedule filter: unfiltered days exclude sections with meetings on those days", async () => {
    // Tuesday-only 40000000-60000000. Unfiltered: mon, wed, thu, fri.
    // sec 8 (T only, 55800000-58800000 overlaps [40M,60M)) ✓
    // sec 5 (online) ✓, sec 6 (no meetings) ✓
    // sec 1 (MWF) excluded — mon on unfiltered day
    // sec 2 (TR) excluded — thu on unfiltered day
    // sec 3 (MWF) excluded, sec 4 (MWF) excluded
    // sec 7 (TR) excluded — thu on unfiltered day
    const result = await queryWithSectionFilters({
      tuesdayStartTime: "40000000",
      tuesdayEndTime: "60000000",
    });
    expect(result).toContain("uuid-cs200");   // via sec 8 (T only)
    expect(result).toContain("uuid-math221"); // via sec 5 (online)
    expect(result).toContain("uuid-cs577");   // via sec 6 (no meetings)
    expect(result).not.toContain("uuid-cs400"); // MWF only
    expect(result).not.toContain("uuid-cs302"); // TR — thu is unfiltered
  });

  it("schedule filter: online sections pass any schedule filter", async () => {
    // Narrow Monday-only window that no in-person section can match.
    // MATH221 sec 5 (online, all NULLs) and CS577 sec 6 (no meetings) still pass.
    const result = await queryWithSectionFilters({
      mondayStartTime: "1000000",
      mondayEndTime: "2000000",
    });
    expect(result).toContain("uuid-math221"); // online section
    expect(result).toContain("uuid-cs577");   // no meeting rows
    expect(result).not.toContain("uuid-cs400");
    expect(result).not.toContain("uuid-cs302");
  });

  it("schedule filter: MWF narrow window excludes out-of-range", async () => {
    // MWF 32000000-36000000. Only sec 4 (31800000-34800000) overlaps.
    // sec 1 (MWF 35700000-38700000): end 38700000 > 36000000? overlap on mon
    //   but wait — 35700000 < 36000000 AND 38700000 > 32000000 → overlaps ✓
    // sec 3 (MWF 39600000-42600000): start 39600000 >= 36000000 → outside → violation
    // sec 4 (MWF 31800000-34800000): 31800000 < 36000000, 34800000 > 32000000 → overlaps ✓
    const result = await queryWithSectionFilters({
      mondayStartTime: "32000000",
      mondayEndTime: "36000000",
      wednesdayStartTime: "32000000",
      wednesdayEndTime: "36000000",
      fridayStartTime: "32000000",
      fridayEndTime: "36000000",
    });
    expect(result).toContain("uuid-cs200");   // sec 1 overlaps (starts at 35.7M < 36M)
    expect(result).toContain("uuid-math221"); // sec 4 overlaps + sec 5 online
    expect(result).not.toContain("uuid-cs400"); // sec 3 starts at 39.6M, outside
    expect(result).not.toContain("uuid-cs302"); // TR, unfiltered days
  });

  it("schedule filter: UTC-wrapped MWF window includes in-range sections", async () => {
    // MWF start=30000000, end=20000000 (wrapped: [30M, 86.4M) ∪ [0, 20M))
    // All MWF fixture times (31.8M-42.6M) are in [30M, 86.4M) → no violations
    const result = await queryWithSectionFilters({
      mondayStartTime: "30000000",
      mondayEndTime: "20000000",
      wednesdayStartTime: "30000000",
      wednesdayEndTime: "20000000",
      fridayStartTime: "30000000",
      fridayEndTime: "20000000",
    });
    expect(result).toContain("uuid-cs200");   // sec 1 MWF in range
    expect(result).toContain("uuid-cs400");   // sec 3 MWF in range
    expect(result).toContain("uuid-math221"); // sec 4 MWF in range + sec 5 online
    expect(result).not.toContain("uuid-cs302"); // TR, unfiltered days
  });

  it("schedule filter: UTC-wrapped tight MWF window excludes out-of-range", async () => {
    // MWF start=40000000, end=5000000 (wrapped: [40M, 86.4M) ∪ [0, 5M))
    // sec 1 (35.7M-38.7M): end 38.7M <= 40M AND start 35.7M >= 5M → violation
    // sec 3 (39.6M-42.6M): end 42.6M <= 40M? NO → no violation → passes
    // sec 4 (31.8M-34.8M): end 34.8M <= 40M AND start 31.8M >= 5M → violation
    const result = await queryWithSectionFilters({
      mondayStartTime: "40000000",
      mondayEndTime: "5000000",
      wednesdayStartTime: "40000000",
      wednesdayEndTime: "5000000",
      fridayStartTime: "40000000",
      fridayEndTime: "5000000",
    });
    expect(result).toContain("uuid-cs400");   // sec 3 in range
    expect(result).toContain("uuid-math221"); // sec 5 online
    expect(result).toContain("uuid-cs577");   // no meetings
    expect(result).not.toContain("uuid-cs302"); // TR
    // CS200 sec 1 is outside the tight window
    expect(result).not.toContain("uuid-cs200");
  });
});
