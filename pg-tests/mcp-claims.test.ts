import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDb, type TestDb } from "./setup.ts";
import { createMcpApp } from "../pg/mcp/server.ts";

let testDb: TestDb;
const mockCache = { get: async () => null, set: async () => {}, bustAll: async () => {} };

beforeAll(async () => {
  testDb = await setupTestDb();
});
afterAll(async () => {
  await testDb.teardown();
});

describe("claims threading", () => {
  test("an unauthenticated app still serves tools/list", async () => {
    const app = createMcpApp({ db: testDb.db, cache: mockCache, requireAuth: false });
    const res = await app.request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("search_courses");
  });
});
