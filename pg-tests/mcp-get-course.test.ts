import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDb, type TestDb } from "./setup.ts";
import { createMcpApp } from "../pg/mcp/server.ts";
import { fixture } from "./fixtures/default.ts";

let testDb: TestDb;
let app: ReturnType<typeof createMcpApp>;
const mockCache = { get: async () => null, set: async () => {}, bustAll: async () => {} };

beforeAll(async () => {
  testDb = await setupTestDb();
  await testDb.seed(fixture);
  app = createMcpApp({ db: testDb.db, cache: mockCache, requireAuth: false });
});
afterAll(async () => {
  await testDb.teardown();
});

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await app.request("http://localhost/", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return res.text();
};

describe("get_course with an ambiguous designation", () => {
  // No fixture course shares a designation, so the matches.length > 1 branch
  // never ran end to end — despite covering roughly 20% of the real catalog
  // (366 designations over 1,148 of 5,655 courses). Seed the collision here.
  beforeAll(async () => {
    await testDb.db
      .insertInto("courses")
      .values({
        id: 900,
        course_uuid: "uuid-dup-900",
        course_id: "900900",
        subject_code: "COMP SCI",
        course_designation: "COMP SCI 400",
        full_course_designation: "COMP SCI 400",
        course_title: "Programming III: Special Topics",
        catalog_number: 400,
        minimum_credits: 3,
        maximum_credits: 3,
        level: "Advanced",
      } as never)
      .execute();
    // No second madgrades row: both courses share the designation, so they
    // join to the one that already exists. Adding another would fan the join
    // out and report each variant twice.
  });

  test("lists the variants instead of guessing one", async () => {
    const out = await call("get_course", { designation: "COMP SCI 400" });
    expect(out).toContain("matches 2 courses");
    expect(out).toContain("Special Topics");
  });

  test("points at a recovery the tool can actually perform", async () => {
    // It previously said "Ask about one by its title", but get_course takes
    // only a designation — following that advice always missed.
    const out = await call("get_course", { designation: "COMP SCI 400" });
    expect(out).toContain("search_courses");
    expect(out).not.toMatch(/ask about one by its title/i);
  });
});

describe("get_course", () => {
  test("is advertised in tools/list", async () => {
    const res = await app.request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(await res.text()).toContain("get_course");
  });

  // COMP SCI 300 does not exist as a course in this fixture (it only
  // appears as prerequisite text on other courses) — using it here would
  // always exercise the "no course matched" branch, never the detail
  // renderer this test is meant to cover. COMP SCI 400 is a real fixture
  // course with a single match and a madgrades_course_grades row (required
  // by runCourseQuery's inner join — see query-by-designation.test.ts).
  test("returns detail the search tool omits", async () => {
    const out = await call("get_course", { designation: "COMP SCI 400" });
    expect(out).toContain("COMP SCI 400");
    expect(out).toMatch(/Sections|no sections/i);
  });

  test("an unknown designation reads as an answer, not an error", async () => {
    const out = await call("get_course", { designation: "BASKET 999" });
    expect(out).toMatch(/no course|not find|didn't match/i);
    expect(out).not.toMatch(/"isError":true/);
  });

  test("never returns raw course JSON", async () => {
    const out = await call("get_course", { designation: "COMP SCI 400" });
    expect(out).not.toContain("course_uuid");
  });
});
