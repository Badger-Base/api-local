import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { setupTestDb, type TestDb } from "./setup.ts";
import { auth } from "../auth.ts";
import { createMcpApp } from "../pg/mcp/server.ts";

// pg-tests/mcp-discovery.test.ts and the Task 1 spike both call
// `auth.handler` directly, which proves better-auth *serves* these paths but
// not that this app *routes* to them — server.ts only mounted
// `/api/auth/*`, so the bare `/.well-known/*` paths 404'd from Hono before
// ever reaching auth.handler. server.ts's own `app` isn't exported, so this
// composes a Hono app the same way it does (same two `app.all` mounts) to
// prove the discovery paths resolve through real Hono routing this time.
let testDb: TestDb;
let app: Hono;

beforeAll(async () => {
  testDb = await setupTestDb();
  app = new Hono();
  app.all("/api/auth/*", (c) => auth.handler(c.req.raw));
  app.all("/.well-known/*", (c) => auth.handler(c.req.raw));
});

afterAll(async () => {
  await testDb.teardown();
});

describe("OAuth discovery paths, routed through Hono (not auth.handler directly)", () => {
  test("resolves the exact resource_metadata path /mcp's 401 advertises", async () => {
    // Get the real WWW-Authenticate header from a live unauthenticated /mcp
    // call, the same way a real MCP client would, rather than assuming its
    // shape — this fails if the header and the routing ever disagree again.
    const mcpApp = createMcpApp({
      db: testDb.db,
      cache: { get: async () => null, set: async () => {}, bustAll: async () => {} },
      requireAuth: true,
    });
    const res401 = await mcpApp.request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const header = res401.headers.get("WWW-Authenticate");
    expect(header).toBeTruthy();
    const match = header!.match(/resource_metadata="([^"]+)"/);
    expect(match).toBeTruthy();
    const advertisedPath = new URL(match![1]).pathname;
    expect(advertisedPath).toBe("/.well-known/oauth-protected-resource/mcp");

    const res = await app.request(advertisedPath);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBeTruthy();
  });

  test("resolves the bare protected-resource metadata path", async () => {
    const res = await app.request("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBeTruthy();
  });

  test("resolves the RFC 8414 path-inserted authorization-server metadata", async () => {
    const res = await app.request("/.well-known/oauth-authorization-server/api/auth");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authorization_endpoint).toBeTruthy();
    expect(body.token_endpoint).toBeTruthy();
  });
});
