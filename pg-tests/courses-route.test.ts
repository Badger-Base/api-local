import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDb, type TestDb } from "./setup.ts";
import { fixture } from "./fixtures/default.ts";
import { createPgApp } from "../pg/routes/courses.ts";

let testDb: TestDb;
let app: ReturnType<typeof createPgApp>;

const API_KEY = "test-key";

beforeAll(async () => {
  testDb = await setupTestDb();
  await testDb.seed(fixture);

  const mockCache = {
    get: async () => null,
    set: async () => {},
    bustAll: async () => {},
  };

  app = createPgApp({ db: testDb.db, cache: mockCache, apiKey: API_KEY });
});

afterAll(async () => {
  await testDb.teardown();
});

function authHeaders() {
  return { "x-api-key": API_KEY };
}

async function query(params: Record<string, string> = {}) {
  if (!params.limit) params.limit = "50";
  const qs = new URLSearchParams(params).toString();
  const res = await app.request(`/api/query?${qs}`, { headers: authHeaders() });
  return res.json();
}

describe("courses route", () => {
  it("rejects without API key", async () => {
    const res = await app.request("/api/query");
    expect(res.status).toBe(401);
  });

  it("returns all courses with no filters", async () => {
    const body = await query();
    expect(body.data.length).toBe(7);
    expect(body.total_count).toBe(7);
    expect(body.has_more).toBe(false);
  });

  it("response shape matches contract", async () => {
    const body = await query({ limit: "1" });
    const course = body.data[0];

    // Course fields
    expect(course).toHaveProperty("course_uuid");
    expect(course).toHaveProperty("ethnic_studies");
    expect(typeof course.ethnic_studies).toBe("boolean");
    expect(course).toHaveProperty("sections");

    // Section fields
    const section = course.sections[0];
    expect(section).toHaveProperty("section_id");
    expect(section).toHaveProperty("status");
    expect(section).toHaveProperty("instructors");
    expect(section).toHaveProperty("meetings");
    expect(section).toHaveProperty("section_avg_rating");
  });

  it("pagination works", async () => {
    const page1 = await query({ limit: "2", page: "1" });
    const page2 = await query({ limit: "2", page: "2" });

    expect(page1.data.length).toBe(2);
    expect(page1.has_more).toBe(true);
    expect(page1.total_count).toBe(7);

    expect(page2.data.length).toBe(2);
    const page1Uuids = page1.data.map((c: any) => c.course_uuid);
    const page2Uuids = page2.data.map((c: any) => c.course_uuid);
    expect(page1Uuids).not.toEqual(page2Uuids);
  });

  it("cross-section bug is fixed", async () => {
    const body = await query({ status: "OPEN", min_section_avg_rating: "4.0" });
    const uuids = body.data.map((c: any) => c.course_uuid);
    expect(uuids).not.toContain("uuid-cs200");
    expect(uuids).toContain("uuid-cs400");
  });

  it("course-level + section-level filters compose", async () => {
    const body = await query({
      level: "Intermediate",
      status: "OPEN",
    });
    const uuids = body.data.map((c: any) => c.course_uuid);
    expect(uuids).toContain("uuid-cs400");
    expect(uuids).toContain("uuid-cs302");
    expect(uuids).not.toContain("uuid-cs200"); // Elementary
  });

  it("search_param also searches instructor names", async () => {
    const body = await query({ search_param: "Good Prof" });
    const uuids = body.data.map((c: any) => c.course_uuid);
    expect(uuids).toContain("uuid-cs200"); // Good Prof teaches sec 2
    expect(uuids).toContain("uuid-cs400"); // Good Prof teaches sec 3
  });

  // Finding #1: sort order preserved through hydration
  it("sort=cumulative_gpa returns results in GPA descending order, ungraded last", async () => {
    const body = await query({ sort: "cumulative_gpa" });
    const gpas = body.data.map((c: any) => c.cumulative_gpa);

    // Postgres sorts NULLs FIRST on DESC, so without an explicit NULLS LAST
    // the courses with no grade history would lead a "highest GPA" list.
    const firstNull = gpas.findIndex((g: number | null) => g === null);
    if (firstNull !== -1) {
      expect(gpas.slice(firstNull).every((g: number | null) => g === null)).toBe(true);
    }

    const graded = gpas.filter((g: number | null) => g !== null) as number[];
    for (let i = 1; i < graded.length; i++) {
      expect(graded[i - 1]).toBeGreaterThanOrEqual(graded[i]);
    }
  });

  it("min_a_percent filters using slider-scale fractions (0-1)", async () => {
    const body = await query({ min_a_percent: "0.30" });
    const uuids = body.data.map((c: any) => c.course_uuid);
    expect(uuids).toContain("uuid-cs200"); // a_percentage=0.35
    expect(uuids).toContain("uuid-cs302"); // a_percentage=0.30
    expect(uuids).not.toContain("uuid-cs400"); // a_percentage=0.20
    expect(uuids).not.toContain("uuid-math221"); // a_percentage=0.15
    expect(body.total_count).toBeLessThan(5);
  });

  it("min_a_percent hydrated a_percent matches filter scale", async () => {
    const body = await query({ min_a_percent: "0.30" });
    for (const course of body.data) {
      expect(course.a_percent).toBeGreaterThanOrEqual(0.30);
      expect(course.a_percent).toBeLessThanOrEqual(1.0);
    }
  });
});
