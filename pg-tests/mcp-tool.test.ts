import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDb, type TestDb } from "./setup.ts";
import { createMcpApp, normalizeToolArgs } from "../pg/mcp/server.ts";
import { fixture } from "./fixtures/default.ts";

let testDb: TestDb;
let app: ReturnType<typeof createMcpApp>;

beforeAll(async () => {
  testDb = await setupTestDb();
  await testDb.seed(fixture);
  app = createMcpApp({
    db: testDb.db,
    cache: { get: async () => null, set: async () => {}, bustAll: async () => {} },
    requireAuth: false,
  });
});
afterAll(async () => {
  await testDb.teardown();
});

const call = async (args: Record<string, unknown>) => {
  const res = await app.request("http://localhost/", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "search_courses", arguments: args },
    }),
  });
  return res.text();
};

describe("normalizeToolArgs", () => {
  // The integration tests below can't observe the clamp directly: the
  // fixture holds only 6 COMP SCI courses out of 14 total, so a
  // `limit: 500` call returns 6 lines whether or not a clamp exists. The
  // normalizer is unit-tested directly instead.

  test("limit above the cap is clamped to 25", () => {
    expect(normalizeToolArgs({ limit: 500 }).limit).toBe("25");
  });

  test("negative limit is floored to 1, not left negative", () => {
    expect(normalizeToolArgs({ limit: -5 }).limit).toBe("1");
  });

  test("zero limit is floored to 1", () => {
    expect(normalizeToolArgs({ limit: 0 }).limit).toBe("1");
  });

  test("non-numeric limit falls back to the default of 10", () => {
    // @ts-expect-error - exercising a client that ignores the schema
    expect(normalizeToolArgs({ limit: "abc" }).limit).toBe("10");
  });

  test("absent limit defaults to 10", () => {
    expect(normalizeToolArgs({}).limit).toBe("10");
  });

  test("absent page is omitted, matching the REST route's own default", () => {
    expect(normalizeToolArgs({})).not.toHaveProperty("page");
  });

  test("a boolean filter becomes the string \"true\"", () => {
    expect(normalizeToolArgs({ ethnic_studies: true }).ethnic_studies).toBe("true");
  });

  test("a boolean filter set to false becomes the string \"false\", not omitted", () => {
    expect(normalizeToolArgs({ ethnic_studies: false }).ethnic_studies).toBe("false");
  });

  test("a numeric filter is mapped to its builder key and stringified", () => {
    // min_gpa is the model-facing name; pg/builders/grade-filter.ts reads
    // min_cumulative_gpa. Unmapped, this filter would be silently ignored.
    const out = normalizeToolArgs({ min_gpa: 3.5 });
    expect(out.min_cumulative_gpa).toBe("3.5");
    expect(out).not.toHaveProperty("min_gpa");
  });

  test("general_education is mapped to gen_ed and kept as a string code", () => {
    // course-filter.ts reads gen_ed as an equality check against a
    // requirement code (e.g. "QR-A"), not a boolean.
    const out = normalizeToolArgs({ general_education: "QR-A" });
    expect(out.gen_ed).toBe("QR-A");
    expect(out).not.toHaveProperty("general_education");
  });

  test("undefined keys are omitted rather than becoming the string \"undefined\"", () => {
    const out = normalizeToolArgs({ subject_code: undefined });
    expect(out).not.toHaveProperty("subject_code");
  });
});

describe("search_courses", () => {
  test("returns text, never raw course JSON", async () => {
    const out = await call({ subject_code: "COMP SCI" });
    expect(out).not.toContain("course_uuid");
  });

  test("caps limit at 25 even when a model asks for more", async () => {
    const out = await call({ subject_code: "COMP SCI", limit: 500 });
    // The renderer prints one line per returned course; 25 is the ceiling.
    const lines = out.split("\n").filter((l) => l.includes("COMP SCI"));
    expect(lines.length).toBeLessThanOrEqual(25);
  });

  test("an unmatched search reads as an answer, not an error", async () => {
    const out = await call({ subject_code: "NOT A SUBJECT" });
    expect(out).toMatch(/No courses matched/i);
    expect(out).not.toMatch(/"error"/);
  });
});

describe("free_* availability conversion", () => {
  // These convert local Madison clock times into the UTC millisecond pairs
  // pg/builders/section-exists.ts parses. The +6h offset is not a guess: it
  // mirrors the frontend's cstToUtcMilliseconds, which produced the values
  // actually stored against sections.
  const HOUR = 3600000;

  test("converts a single block to a UTC millisecond pair", () => {
    const out = normalizeToolArgs({ free_monday: "09:00-11:00" });
    // 09:00 local -> 540 + 360 = 900 min; 11:00 -> 660 + 360 = 1020 min
    expect(out.mondayStartTime).toBe(String(15 * HOUR));
    expect(out.mondayEndTime).toBe(String(17 * HOUR));
    expect(out.free_monday).toBeUndefined();
  });

  test("keeps multiple blocks paired and in order", () => {
    const out = normalizeToolArgs({ free_tuesday: "09:00-11:00,14:00-16:00" });
    expect(out.tuesdayStartTime).toBe(`${15 * HOUR},${20 * HOUR}`);
    expect(out.tuesdayEndTime).toBe(`${17 * HOUR},${22 * HOUR}`);
  });

  test("wraps an evening block past UTC midnight", () => {
    // 19:00 local -> 1140 + 360 = 1500 -> wraps to 60 min. The builder has a
    // branch for exactly this, where the UTC end lands before the UTC start.
    const out = normalizeToolArgs({ free_wednesday: "19:00-21:00" });
    expect(out.wednesdayStartTime).toBe(String(1 * HOUR));
    expect(out.wednesdayEndTime).toBe(String(3 * HOUR));
  });

  test("drops a malformed day rather than emitting half a filter", () => {
    // A dropped filter returns too many courses; a malformed one returns
    // nonsense, which is worse because it looks like an answer.
    for (const bad of ["", "morning", "9-11", "25:00-26:00", "11:00-09:00", "09:00"]) {
      const out = normalizeToolArgs({ free_thursday: bad });
      expect(out.thursdayStartTime).toBeUndefined();
      expect(out.thursdayEndTime).toBeUndefined();
    }
  });

  test("a valid day survives alongside a malformed one", () => {
    const out = normalizeToolArgs({ free_monday: "09:00-11:00", free_friday: "nonsense" });
    expect(out.mondayStartTime).toBe(String(15 * HOUR));
    expect(out.fridayStartTime).toBeUndefined();
  });
});

describe("the newly exposed section filters", () => {
  test("maps model-facing names onto the builder's params", () => {
    const out = normalizeToolArgs({
      min_professor_rating: 4,
      max_professor_difficulty: 3,
      min_professor_ratings_count: 10,
      min_would_take_again_percent: 80,
      min_open_seats: 5,
      sort: "cumulative_gpa",
    });
    expect(out.min_section_avg_rating).toBe("4");
    expect(out.max_section_avg_difficulty).toBe("3");
    expect(out.min_section_total_ratings).toBe("10");
    expect(out.min_section_avg_would_take_again).toBe("80");
    expect(out.min_available_seats).toBe("5");
    expect(out.sort).toBe("cumulative_gpa");
  });
});
