import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "./api.js";
import { setupDb, createMockRedis } from "./test/db.js";
import { fixture, T } from "./test/fixtures/api-default.js";

const API_KEY = "test-key-e2e";

let db, pool, redis, app;

beforeAll(() => {
  const testDb = setupDb();
  db = testDb.db;
  pool = testDb.pool;
  testDb.seed(fixture);

  redis = createMockRedis();
  app = createApp({ pool, redis, apiKey: API_KEY });
});

afterAll(() => {
  db?.close();
});

// ─── Helpers ───────────────────────────────────────────────────────

function authHeaders() {
  return { "x-api-key": API_KEY };
}

async function query(params = {}) {
  if (!params.limit) params.limit = "50";
  const qs = new URLSearchParams(params).toString();
  const res = await app.request(`/api/query?${qs}`, { headers: authHeaders() });
  return res.json();
}

function uuids(body) {
  return body.data.map((c) => c.course_uuid).sort();
}

const ALL = fixture.courses.map((c) => c.uuid).sort();
const OPEN = ["uuid-c1", "uuid-c2", "uuid-c5", "uuid-c6", "uuid-c7", "uuid-c8", "uuid-c9", "uuid-c10", "uuid-c11", "uuid-c12"].sort();

// ─── Auth ──────────────────────────────────────────────────────────

describe("auth", () => {
  it("rejects requests without API key", async () => {
    const res = await app.request("/api/query");
    expect(res.status).toBe(401);
  });

  it("rejects requests with wrong API key", async () => {
    const res = await app.request("/api/query", { headers: { "x-api-key": "wrong" } });
    expect(res.status).toBe(401);
  });

  it("accepts correct API key", async () => {
    const res = await app.request("/api/query?limit=1", { headers: authHeaders() });
    expect(res.status).toBe(200);
  });
});

// ─── Status filter ─────────────────────────────────────────────────

describe("status filter", () => {
  it("status=OPEN returns only courses with at least one OPEN section", async () => {
    const body = await query({ status: "OPEN" });
    const ids = uuids(body);
    expect(ids).toEqual(OPEN);
    expect(ids).not.toContain("uuid-c3");
    expect(ids).not.toContain("uuid-c4");
  });

  it("status=CLOSED returns only c3", async () => {
    const body = await query({ status: "CLOSED" });
    expect(uuids(body)).toEqual(["uuid-c3"]);
  });

  it("status=WAITLISTED returns only c4", async () => {
    const body = await query({ status: "WAITLISTED" });
    expect(uuids(body)).toEqual(["uuid-c4"]);
  });

  it("status=OPEN returns all sections of matching courses (course-level filter)", async () => {
    const body = await query({ status: "OPEN", search_param: "Data Structures" });
    expect(body.data).toHaveLength(1);
    const course = body.data[0];
    expect(course.course_uuid).toBe("uuid-c1");
    expect(course.sections).toHaveLength(2);
  });

  it("status=CLOSED excludes courses that have any non-CLOSED section", async () => {
    const body = await query({ status: "CLOSED" });
    expect(uuids(body)).toEqual(["uuid-c3"]);
    const course = body.data[0];
    course.sections.forEach((s) => {
      expect(s.status).toBe("CLOSED");
    });
  });

  it("status=OPEN,WAITLISTED returns all except c3", async () => {
    const body = await query({ status: "OPEN,WAITLISTED" });
    const ids = uuids(body);
    expect(ids).not.toContain("uuid-c3");
    expect(ids.length).toBe(ALL.length - 1);
  });

  it("status=OPEN,WAITLISTED,CLOSED returns all courses", async () => {
    const body = await query({ status: "OPEN,WAITLISTED,CLOSED" });
    expect(uuids(body)).toEqual(ALL);
  });
});

// ─── Credit filters ────────────────────────────────────────────────

describe("credit filters", () => {
  it("min_credits=4 returns only 5-credit courses (c2, c6)", async () => {
    const body = await query({ min_credits: "4" });
    expect(uuids(body)).toEqual(["uuid-c2", "uuid-c6"]);
  });

  it("max_credits=3 excludes 5-credit courses", async () => {
    const body = await query({ max_credits: "3" });
    const ids = uuids(body);
    expect(ids).not.toContain("uuid-c2");
    expect(ids).not.toContain("uuid-c6");
    expect(ids.length).toBe(ALL.length - 2);
  });

  it("min_credits=3 max_credits=3 returns only 3-credit courses", async () => {
    const body = await query({ min_credits: "3", max_credits: "3" });
    const ids = uuids(body);
    expect(ids).not.toContain("uuid-c2"); // 5cr
    expect(ids).not.toContain("uuid-c6"); // 5cr
    expect(ids).not.toContain("uuid-c10"); // 2cr
  });
});

// ─── Level filter ──────────────────────────────────────────────────

describe("level filter", () => {
  it("level=Elementary returns correct courses", async () => {
    const body = await query({ level: "Elementary" });
    expect(uuids(body)).toEqual(
      ["uuid-c2", "uuid-c3", "uuid-c4", "uuid-c5", "uuid-c7", "uuid-c10", "uuid-c12"].sort()
    );
  });

  it("level=Intermediate returns c1, c6, c11", async () => {
    const body = await query({ level: "Intermediate" });
    expect(uuids(body)).toEqual(["uuid-c1", "uuid-c6", "uuid-c11"].sort());
  });

  it("level=Advanced returns c8, c9", async () => {
    const body = await query({ level: "Advanced" });
    expect(uuids(body)).toEqual(["uuid-c8", "uuid-c9"].sort());
  });

  it("level=Advanced,Intermediate returns union of both", async () => {
    const body = await query({ level: "Advanced,Intermediate" });
    expect(uuids(body)).toEqual(["uuid-c1", "uuid-c6", "uuid-c8", "uuid-c9", "uuid-c11"].sort());
  });
});

// ─── Prerequisite filters ──────────────────────────────────────────

describe("prerequisite filters", () => {
  it("no_prereqs returns courses with enrollment_prerequisites='None'", async () => {
    const body = await query({ no_prereqs: "true" });
    expect(uuids(body)).toEqual(
      ["uuid-c2", "uuid-c3", "uuid-c4", "uuid-c5", "uuid-c7", "uuid-c10", "uuid-c12"].sort()
    );
  });

  it("sophomore_standing returns c1, c6", async () => {
    const body = await query({ sophomore_standing: "true" });
    expect(uuids(body)).toEqual(["uuid-c1", "uuid-c6"].sort());
  });

  it("junior_standing returns c8", async () => {
    const body = await query({ junior_standing: "true" });
    expect(uuids(body)).toEqual(["uuid-c8"]);
  });

  it("senior_standing returns c9", async () => {
    const body = await query({ senior_standing: "true" });
    expect(uuids(body)).toEqual(["uuid-c9"]);
  });

  it("no_prereqs + sophomore_standing uses OR (includes both sets)", async () => {
    const body = await query({ no_prereqs: "true", sophomore_standing: "true" });
    const ids = uuids(body);
    expect(ids).toContain("uuid-c1"); // sophomore
    expect(ids).toContain("uuid-c6"); // sophomore
    expect(ids).toContain("uuid-c2"); // none
    expect(ids).toContain("uuid-c7"); // none
    expect(ids).not.toContain("uuid-c8"); // junior
    expect(ids).not.toContain("uuid-c9"); // senior
    expect(ids).not.toContain("uuid-c11"); // CS 200 prereq
  });

  it("all standing filters combined returns all except c11", async () => {
    const body = await query({
      no_prereqs: "true",
      sophomore_standing: "true",
      junior_standing: "true",
      senior_standing: "true",
    });
    const ids = uuids(body);
    expect(ids).not.toContain("uuid-c11"); // prereq is "CS 200", not a standing
    expect(ids.length).toBe(ALL.length - 1);
  });
});

// ─── Breadth requirement filters ───────────────────────────────────

describe("breadth requirement filters", () => {
  it("ethnic_studies returns only c7", async () => {
    const body = await query({ ethnic_studies: "true" });
    expect(uuids(body)).toEqual(["uuid-c7"]);
  });

  it("social_science returns only c3", async () => {
    const body = await query({ social_science: "true" });
    expect(uuids(body)).toEqual(["uuid-c3"]);
  });

  it("humanities returns c4 and c10", async () => {
    const body = await query({ humanities: "true" });
    expect(uuids(body)).toEqual(["uuid-c10", "uuid-c4"].sort());
  });

  it("biological_science returns only c5", async () => {
    const body = await query({ biological_science: "true" });
    expect(uuids(body)).toEqual(["uuid-c5"]);
  });

  it("physical_science returns only c6", async () => {
    const body = await query({ physical_science: "true" });
    expect(uuids(body)).toEqual(["uuid-c6"]);
  });

  it("natural_science returns only c2", async () => {
    const body = await query({ natural_science: "true" });
    expect(uuids(body)).toEqual(["uuid-c2"]);
  });

  it("literature returns only c4", async () => {
    const body = await query({ literature: "true" });
    expect(uuids(body)).toEqual(["uuid-c4"]);
  });

  it("l_and_s returns only c6", async () => {
    const body = await query({ l_and_s: "true" });
    expect(uuids(body)).toEqual(["uuid-c6"]);
  });

  it("gen_ed=COM B returns only c12", async () => {
    const body = await query({ gen_ed: "COM B" });
    expect(uuids(body)).toEqual(["uuid-c12"]);
  });
});

// ─── GPA / grade filters ──────────────────────────────────────────

describe("GPA and grade filters", () => {
  it("min_cumulative_gpa=3.5 returns courses with GPA >= 3.5", async () => {
    const body = await query({ min_cumulative_gpa: "3.5" });
    const ids = uuids(body);
    expect(ids).toEqual(
      ["uuid-c3", "uuid-c4", "uuid-c7", "uuid-c10", "uuid-c12"].sort()
    );
  });

  it("min_most_recent_gpa=3.5 returns courses with recent GPA >= 3.5", async () => {
    const body = await query({ min_most_recent_gpa: "3.5" });
    const ids = uuids(body);
    // c3=3.55, c4=3.65, c7=3.75, c10=3.85
    expect(ids).toContain("uuid-c3");
    expect(ids).toContain("uuid-c4");
    expect(ids).toContain("uuid-c7");
    expect(ids).toContain("uuid-c10");
    expect(ids).not.toContain("uuid-c1"); // 3.35
  });

  it("min_a_percent=40 returns courses with A% >= 40", async () => {
    const body = await query({ min_a_percent: "40" });
    expect(uuids(body)).toEqual(
      ["uuid-c3", "uuid-c4", "uuid-c7", "uuid-c10"].sort()
    );
  });

  it("median_grade=A returns only c10", async () => {
    const body = await query({ median_grade: "A" });
    expect(uuids(body)).toEqual(["uuid-c10"]);
  });

  it("median_grade=AB returns c3, c4, c7, c12", async () => {
    const body = await query({ median_grade: "AB" });
    expect(uuids(body)).toEqual(["uuid-c12", "uuid-c3", "uuid-c4", "uuid-c7"].sort());
  });
});

// ─── Search ────────────────────────────────────────────────────────

describe("search filter", () => {
  it("search_param=Calculus matches course title", async () => {
    const body = await query({ search_param: "Calculus" });
    expect(uuids(body)).toEqual(["uuid-c2"]);
  });

  it("search_param=COMP SCI matches course_designation", async () => {
    const body = await query({ search_param: "COMP SCI" });
    expect(uuids(body)).toEqual(["uuid-c1", "uuid-c11", "uuid-c8", "uuid-c9"].sort());
  });

  it("search_param=Alice matches instructor name", async () => {
    const body = await query({ search_param: "Alice" });
    expect(uuids(body)).toEqual(["uuid-c1"]);
  });

  it("search_param=ZZZZZZ returns empty", async () => {
    const body = await query({ search_param: "ZZZZZZ" });
    expect(body.data).toEqual([]);
    expect(body.count).toBe(0);
  });
});

// ─── RMP section-level filters ─────────────────────────────────────

describe("RMP section-level filters", () => {
  it("min_section_avg_rating=4.0 returns courses with high-rated sections", async () => {
    const body = await query({ min_section_avg_rating: "4.0" });
    const ids = uuids(body);
    // Alice=4.2 (c1), Diana=4.5 (c3), Ed=4.0 (c4), Holly=4.3 (c7), Ken=4.1 (c10)
    expect(ids).toContain("uuid-c1");
    expect(ids).toContain("uuid-c3");
    expect(ids).toContain("uuid-c4");
    expect(ids).toContain("uuid-c7");
    expect(ids).toContain("uuid-c10");
    expect(ids).not.toContain("uuid-c2"); // Carol=3.0
  });

  it("min_section_avg_difficulty=3.0 returns sections with difficulty >= 3.0", async () => {
    const body = await query({ min_section_avg_difficulty: "3.0" });
    const ids = uuids(body);
    // Bob=3.0 (c1), Carol=3.5 (c2), Gary=3.2 (c6), Lily=3.1 (c11), Mike=3.3 (c12)
    expect(ids).toContain("uuid-c2");
    expect(ids).toContain("uuid-c6");
  });

  it("min_section_total_ratings=20 returns well-reviewed sections", async () => {
    const body = await query({ min_section_total_ratings: "20" });
    const ids = uuids(body);
    // Alice=20 (c1), Diana=30 (c3), Holly=25 (c7), Ken=22 (c10)
    expect(ids).toContain("uuid-c1");
    expect(ids).toContain("uuid-c3");
    expect(ids).toContain("uuid-c7");
    expect(ids).toContain("uuid-c10");
  });
});

// ─── Instruction mode ──────────────────────────────────────────────

describe("instruction mode filter", () => {
  it("instruction_mode=Online returns c11", async () => {
    const body = await query({ instruction_mode: "Online" });
    expect(uuids(body)).toEqual(["uuid-c11"]);
  });

  it("instruction_mode=In Person excludes online-only courses", async () => {
    const body = await query({ instruction_mode: "In Person" });
    const ids = uuids(body);
    expect(ids).toContain("uuid-c1");
    expect(ids).toContain("uuid-c11"); // c11 has in-person DIS 301
  });
});

// ─── Available seats ───────────────────────────────────────────────

describe("available seats filter", () => {
  it("min_available_seats=20 returns courses with sections having >= 20 seats", async () => {
    const body = await query({ min_available_seats: "20" });
    const ids = uuids(body);
    // c1(30), c5(20), c7(25), c10(40), c12(30)
    expect(ids).toContain("uuid-c1");
    expect(ids).toContain("uuid-c5");
    expect(ids).toContain("uuid-c7");
    expect(ids).toContain("uuid-c10");
    expect(ids).toContain("uuid-c12");
    expect(ids).not.toContain("uuid-c2"); // 5 seats
    expect(ids).not.toContain("uuid-c3"); // 0 seats
  });
});

// ─── Sorting ───────────────────────────────────────────────────────

describe("sorting", () => {
  it("default sort is by catalog_number ascending", async () => {
    const body = await query();
    const catalogs = body.data.map((c) => c.course_uuid);
    // catalog_number order: 100(c12), 101(c7), 113(c10), 150(c4), 151(c5), 200(c1), 201(c6), 202(c3), 221(c2), 300(c11), 577(c8), 640(c9)
    expect(catalogs[0]).toBe("uuid-c12"); // 100
    expect(catalogs[1]).toBe("uuid-c7"); // 101
    expect(catalogs[2]).toBe("uuid-c10"); // 113
  });

  it("sort=cumulative_gpa orders by GPA descending", async () => {
    const body = await query({ sort: "cumulative_gpa" });
    const gpas = body.data.map((c) => c.cumulative_gpa);
    for (let i = 0; i < gpas.length - 1; i++) {
      expect(gpas[i]).toBeGreaterThanOrEqual(gpas[i + 1]);
    }
    expect(body.data[0].course_uuid).toBe("uuid-c10"); // GPA 3.9
  });

  it("sort=recent_gpa orders by most recent GPA descending", async () => {
    const body = await query({ sort: "recent_gpa" });
    const gpas = body.data.map((c) => c.most_recent_gpa);
    for (let i = 0; i < gpas.length - 1; i++) {
      expect(gpas[i]).toBeGreaterThanOrEqual(gpas[i + 1]);
    }
  });
});

// ─── Pagination ────────────────────────────────────────────────────

describe("pagination", () => {
  it("limit=3 page=1 returns 3 courses with has_more=true", async () => {
    const body = await query({ limit: "3", page: "1" });
    expect(body.data).toHaveLength(3);
    expect(body.has_more).toBe(true);
    expect(body.total_count).toBe(12);
  });

  it("limit=3 page=4 returns last 3 courses with has_more=false", async () => {
    const body = await query({ limit: "3", page: "4" });
    expect(body.data).toHaveLength(3);
    expect(body.has_more).toBe(false);
  });

  it("limit=100 returns all 12 courses", async () => {
    const body = await query({ limit: "100" });
    expect(body.data).toHaveLength(12);
    expect(body.has_more).toBe(false);
    expect(body.total_count).toBe(12);
  });

  it("page beyond data returns empty", async () => {
    const body = await query({ limit: "10", page: "100" });
    expect(body.data).toEqual([]);
    expect(body.count).toBe(0);
  });
});

// ─── Combined filters ──────────────────────────────────────────────

describe("combined filter behavior", () => {
  it("OPEN + Elementary + no prereqs = beginner courses available now", async () => {
    const body = await query({ status: "OPEN", level: "Elementary", no_prereqs: "true" });
    expect(uuids(body)).toEqual(
      ["uuid-c2", "uuid-c5", "uuid-c7", "uuid-c10", "uuid-c12"].sort()
    );
  });

  it("OPEN + 3cr exact + GPA >= 3.5 = high-GPA 3-credit open courses", async () => {
    const body = await query({
      status: "OPEN",
      min_credits: "3",
      max_credits: "3",
      min_cumulative_gpa: "3.5",
    });
    // c7(3.8 open 3cr), c12(3.5 open 3cr). c3(3.6) is CLOSED, c4(3.7) is WAITLISTED
    expect(uuids(body)).toEqual(["uuid-c12", "uuid-c7"].sort());
  });

  it("social_science + OPEN = empty (c3 is social sci but CLOSED)", async () => {
    const body = await query({ social_science: "true", status: "OPEN" });
    expect(body.data).toEqual([]);
    expect(body.count).toBe(0);
  });

  it("ethnic_studies + humanities = empty (no course has both)", async () => {
    const body = await query({ ethnic_studies: "true", humanities: "true" });
    expect(body.data).toEqual([]);
  });

  it("min_section_avg_rating=4.0 + OPEN excludes c3 (CLOSED)", async () => {
    const body = await query({ min_section_avg_rating: "4.0", status: "OPEN" });
    const ids = uuids(body);
    expect(ids).not.toContain("uuid-c3"); // Diana 4.5 but CLOSED
    expect(ids).toContain("uuid-c1"); // Alice 4.2 OPEN
    expect(ids).toContain("uuid-c7"); // Holly 4.3 OPEN
    expect(ids).toContain("uuid-c10"); // Ken 4.1 OPEN
  });

  it("search_param=COMP SCI + OPEN + min_credits=3", async () => {
    const body = await query({
      search_param: "COMP SCI",
      status: "OPEN",
      min_credits: "3",
    });
    expect(uuids(body)).toEqual(
      ["uuid-c1", "uuid-c11", "uuid-c8", "uuid-c9"].sort()
    );
  });

  it("search + sort + pagination work together", async () => {
    const body = await query({
      level: "Elementary",
      sort: "cumulative_gpa",
      limit: "3",
      page: "1",
    });
    expect(body.data).toHaveLength(3);
    // Elementary sorted by GPA desc: c10(3.9), c7(3.8), c4(3.7), c3(3.6), c12(3.5), c5(3.1), c2(2.8)
    expect(body.data[0].course_uuid).toBe("uuid-c10");
    expect(body.data[1].course_uuid).toBe("uuid-c7");
    expect(body.data[2].course_uuid).toBe("uuid-c4");
    expect(body.has_more).toBe(true);
  });

  it("GPA + grade filters combined", async () => {
    const body = await query({
      min_cumulative_gpa: "3.5",
      min_a_percent: "40",
    });
    // GPA>=3.5: c3(3.6),c4(3.7),c7(3.8),c10(3.9),c12(3.5)
    // A%>=40: c3(40),c4(42),c7(50),c10(55)
    // Intersection: c3, c4, c7, c10
    expect(uuids(body)).toEqual(["uuid-c10", "uuid-c3", "uuid-c4", "uuid-c7"].sort());
  });
});

// ─── Response shape verification ───────────────────────────────────

describe("response shape", () => {
  it("c1 has two sections with correct instructors and meetings", async () => {
    const body = await query({ search_param: "Data Structures" });
    expect(body.data).toHaveLength(1);
    const course = body.data[0];
    expect(course.course_uuid).toBe("uuid-c1");
    expect(course.course_title).toBe("Data Structures");
    expect(course.sections.length).toBe(2);

    const openSection = course.sections.find((s) => s.status === "OPEN");
    expect(openSection).toBeDefined();
    expect(openSection.available_seats).toBe(30);
    expect(openSection.instructors).toHaveLength(1);
    expect(openSection.instructors[0].name).toBe("Alice Chen");
    expect(openSection.instructors[0].avg_rating).toBe(4.2);
    expect(openSection.meetings).toHaveLength(1);
    expect(openSection.meetings[0].meeting_days).toBe("MWF");
    expect(openSection.meetings[0].monday_meeting_start).toBe(T(9, 0));
    expect(openSection.meetings[0].monday_meeting_end).toBe(T(9, 50));

    const wlSection = course.sections.find((s) => s.status === "WAITLISTED");
    expect(wlSection).toBeDefined();
    expect(wlSection.instructors[0].name).toBe("Bob Park");
    expect(wlSection.meetings[0].meeting_days).toBe("TR");
  });

  it("c11 has online section with no meetings and in-person DIS", async () => {
    const body = await query({ search_param: "Programming II" });
    const course = body.data[0];
    expect(course.sections.length).toBe(2);

    const onlineSec = course.sections.find((s) => s.instruction_mode === "Online");
    expect(onlineSec).toBeDefined();
    expect(onlineSec.is_asynchronous).toBe(1);
    expect(onlineSec.instructors).toHaveLength(1);
    expect(onlineSec.instructors[0].name).toBe("Lily Ma");

    const disSec = course.sections.find((s) => s.instruction_mode === "In Person");
    expect(disSec).toBeDefined();
    expect(disSec.instructors).toHaveLength(0); // no instructor for DIS 301
    expect(disSec.meetings).toHaveLength(1);
    expect(disSec.meetings[0].meeting_type).toBe("DIS");
    expect(disSec.meetings[0].friday_meeting_start).toBe(T(14, 0));
  });

  it("section-level RMP averages are calculated from instructor data", async () => {
    const body = await query({ search_param: "Data Structures" });
    const sec = body.data[0].sections.find((s) => s.status === "OPEN");
    // Alice has rating=4.2, only instructor → section avg = 4.2
    expect(sec.section_avg_rating).toBe(4.2);
    expect(sec.section_avg_difficulty).toBe(2.5);
    expect(sec.section_total_ratings).toBe(20);
  });

  it("response includes total_count, has_more, and filters_applied", async () => {
    const body = await query({ status: "OPEN", sort: "cumulative_gpa" });
    expect(body).toHaveProperty("total_count");
    expect(body).toHaveProperty("has_more");
    expect(body).toHaveProperty("filters_applied");
    expect(body.filters_applied.status).toBe("OPEN");
    expect(body.filters_applied.sort).toBe("cumulative_gpa");
  });
});

// ─── Caching ───────────────────────────────────────────────────────

describe("caching", () => {
  it("first request populates redis cache", async () => {
    const initialSets = redis._sets.length;
    await query({ limit: 1 });
    expect(redis._sets.length).toBeGreaterThan(initialSets);
  });

  it("cached response is returned on cache hit", async () => {
    const cachedData = { data: [{ cached: true }], count: 1, total_count: 1, has_more: false };
    const cachedRedis = {
      get: () => Promise.resolve(JSON.stringify(cachedData)),
      set: () => Promise.resolve("OK"),
    };
    const cachedApp = createApp({ pool, redis: cachedRedis, apiKey: API_KEY });
    const res = await cachedApp.request("/api/query?search_param=cached_test", { headers: authHeaders() });
    const body = await res.json();
    expect(body.data[0].cached).toBe(true);
  });
});

// ─── Health check ──────────────────────────────────────────────────

describe("health check", () => {
  it("returns healthy with real database", async () => {
    const res = await app.request("/health");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe("healthy");
  });
});

// ─── GET /api/courses ──────────────────────────────────────────────

describe("GET /api/courses", () => {
  it("returns up to 10 courses from real data", async () => {
    const res = await app.request("/api/courses", { headers: authHeaders() });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.length).toBeLessThanOrEqual(10);
    expect(body.data.length).toBeGreaterThan(0);
  });
});
