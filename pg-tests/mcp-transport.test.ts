import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDb, type TestDb } from "./setup.ts";
import { createMcpApp } from "../pg/mcp/server.ts";

let testDb: TestDb;
let app: ReturnType<typeof createMcpApp>;

beforeAll(async () => {
  testDb = await setupTestDb();
  app = createMcpApp({
    db: testDb.db,
    cache: { get: async () => null, set: async () => {}, bustAll: async () => {} },
    requireAuth: false,
  });
});
afterAll(async () => {
  await testDb.teardown();
});

const rpc = (body: unknown) =>
  app.request("http://localhost/", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });

describe("MCP transport", () => {
  test("advertises search_courses in tools/list", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("search_courses");
  });

  test("rejects a malformed JSON-RPC body without a 500", async () => {
    const res = await app.request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: "not json",
    });
    expect(res.status).toBeLessThan(500);
  });
});
