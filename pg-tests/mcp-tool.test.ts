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
