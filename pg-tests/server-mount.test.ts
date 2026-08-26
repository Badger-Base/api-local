import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { setupTestDb, type TestDb } from "./setup.ts";
import { fixture } from "./fixtures/default.ts";
import { createPgApp } from "../pg/routes/courses.ts";
import { createPgSearchApp } from "../pg/routes/search.ts";

// This test composes the app the same way `server.ts` does — mounting both
// `createPgApp` and `createPgSearchApp` at the shared `/v2` prefix — to prove
// the suggest route actually resolves through that mount and, more
// importantly, that mounting a second app at the same prefix does not shadow
// the existing `/v2/api/query` route.

let testDb: TestDb;
let app: Hono;

const API_KEY = "test-key";

beforeAll(async () => {
  testDb = await setupTestDb();
  await testDb.seed(fixture);

  const mockCache = {
    get: async () => null,
    set: async () => {},
    bustAll: async () => {},
  };

  app = new Hono();
  app.route(
    "/v2",
    createPgApp({ db: testDb.db, cache: mockCache, apiKey: API_KEY })
  );
  app.route(
    "/v2",
    createPgSearchApp({ db: testDb.db, cache: mockCache, apiKey: API_KEY })
  );
});

afterAll(async () => {
  await testDb.teardown();
});

describe("server mount at /v2", () => {
  it("resolves /v2/api/search/suggest and tolerates a typo end to end", async () => {
    const res = await app.request(
      "/v2/api/search/suggest?q=COMP%20SIC%20200",
      { headers: { "x-api-key": API_KEY } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestions.map((s: any) => s.value)).toContain("COMP SCI 200");
  });

  it("does not shadow the existing /v2/api/query route", async () => {
    const res = await app.request("/v2/api/query?limit=1", {
      headers: { "x-api-key": API_KEY },
    });
    expect(res.status).toBe(200);
  });

  it("rejects /v2/api/search/suggest without an api key", async () => {
    const res = await app.request("/v2/api/search/suggest?q=comp");
    expect(res.status).toBe(401);
  });
});
