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
