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
    requireAuth: true,
  });
});
afterAll(async () => {
  await testDb.teardown();
});

const rpc = (headers: Record<string, string> = {}) =>
  app.request("http://localhost/", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

describe("MCP authentication", () => {
  test("rejects an unauthenticated call", async () => {
    expect((await rpc()).status).toBe(401);
  });

  // This header is how an MCP client discovers where to authorize. Without it
  // a student pasting the URL gets a dead end instead of a login prompt.
  test("points the client at the authorization server on 401", async () => {
    const res = await rpc();
    const header = res.headers.get("WWW-Authenticate");
    expect(header).toBeTruthy();
    expect(header).toMatch(/resource_metadata=/);
  });

  test("rejects a garbage bearer token", async () => {
    expect((await rpc({ Authorization: "Bearer not.a.token" })).status).toBe(401);
  });
});
