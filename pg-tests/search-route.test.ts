import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDb, type TestDb } from "./setup.ts";
import { fixture } from "./fixtures/default.ts";
import { createPgSearchApp } from "../pg/routes/search.ts";
import type { SuggestResponse } from "../pg/types.ts";

let testDb: TestDb;
let app: ReturnType<typeof createPgSearchApp>;

const API_KEY = "test-key";

beforeAll(async () => {
  testDb = await setupTestDb();
  await testDb.seed(fixture);

  const mockCache = {
    get: async () => null,
    set: async () => {},
    bustAll: async () => {},
  };

  app = createPgSearchApp({ db: testDb.db, cache: mockCache, apiKey: API_KEY });
});

afterAll(async () => {
  await testDb.teardown();
});

async function suggest(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const res = await app.request(`/api/search/suggest?${qs}`, {
    headers: { "x-api-key": API_KEY },
  });
  return { status: res.status, body: (await res.json()) as SuggestResponse };
}

describe("GET /api/search/suggest", () => {
  it("rejects a request with no api key", async () => {
    const res = await app.request("/api/search/suggest?q=comp");
    expect(res.status).toBe(401);
  });

  it("returns an empty list for a query under 2 characters", async () => {
    const { status, body } = await suggest({ q: "c" });
    expect(status).toBe(200);
    expect(body.suggestions).toEqual([]);
  });

  it("returns an empty list for a missing q", async () => {
    const { status, body } = await suggest({});
    expect(status).toBe(200);
    expect(body.suggestions).toEqual([]);
  });

  it("returns an empty list for whitespace-only q", async () => {
    const { status, body } = await suggest({ q: "   " });
    expect(status).toBe(200);
    expect(body.suggestions).toEqual([]);
  });

  it("finds a course by exact designation", async () => {
    const { body } = await suggest({ q: "COMP SCI 200" });
    expect(body.suggestions[0]).toMatchObject({
      type: "course",
      value: "COMP SCI 200",
      sublabel: "Programming I",
    });
  });

  it("tolerates a typo in a course designation", async () => {
    const { body } = await suggest({ q: "COMP SIC 200" });
    expect(body.suggestions.map((s) => s.value)).toContain("COMP SCI 200");
  });

  it("tolerates a typo in an instructor name", async () => {
    const { body } = await suggest({ q: "Willliams" });
    expect(body.suggestions.map((s) => s.value)).toContain("Jim Williams");
  });

  it("defaults to 8 suggestions", async () => {
    const { body } = await suggest({ q: "COMP SCI" });
    expect(body.suggestions.length).toBeLessThanOrEqual(8);
  });

  it("clamps an oversized limit to 10", async () => {
    const { body } = await suggest({ q: "COMP SCI", limit: "999" });
    expect(body.suggestions.length).toBeLessThanOrEqual(10);
  });

  it("falls back to the default for a non-numeric limit", async () => {
    const { body } = await suggest({ q: "COMP SCI", limit: "abc" });
    expect(body.suggestions.length).toBeLessThanOrEqual(8);
  });

  it("clamps a zero or negative limit to 1", async () => {
    const { body } = await suggest({ q: "COMP SCI", limit: "0" });
    expect(body.suggestions.length).toBe(1);
  });

  it("trims surrounding whitespace before searching", async () => {
    const { body } = await suggest({ q: "  COMP SCI 200  " });
    expect(body.suggestions[0].value).toBe("COMP SCI 200");
  });

  it("includes an instructor when one matches strongly", async () => {
    const { body } = await suggest({ q: "Jim Williams" });
    expect(body.suggestions.some((s) => s.type === "instructor")).toBe(true);
  });

  it("returns an empty list rather than erroring on no match", async () => {
    const { status, body } = await suggest({ q: "zzzzzzzzzz" });
    expect(status).toBe(200);
    expect(body.suggestions).toEqual([]);
  });

  it("serves a cached response when the cache hits", async () => {
    const cached: SuggestResponse = {
      suggestions: [
        { type: "course", value: "CACHED", label: "CACHED", sublabel: null, course_uuid: null },
      ],
    };
    const hitApp = createPgSearchApp({
      db: testDb.db,
      cache: { get: async () => cached, set: async () => {}, bustAll: async () => {} },
      apiKey: API_KEY,
    });
    const res = await hitApp.request("/api/search/suggest?q=COMP SCI 200", {
      headers: { "x-api-key": API_KEY },
    });
    const body = (await res.json()) as SuggestResponse;
    expect(body.suggestions[0].value).toBe("CACHED");
  });

  it("returns 500 with a JSON body when the database fails", async () => {
    const brokenApp = createPgSearchApp({
      db: { } as any,
      cache: { get: async () => null, set: async () => {}, bustAll: async () => {} },
      apiKey: API_KEY,
    });
    const res = await brokenApp.request("/api/search/suggest?q=comp", {
      headers: { "x-api-key": API_KEY },
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toHaveProperty("error");
  });
});
