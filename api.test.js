import { describe, it, expect, beforeEach } from "bun:test";
import { createApp } from "./api.js";

const TEST_API_KEY = "test-key-123";

function createMockPool(overrides = {}) {
  return {
    execute: overrides.execute ?? (() => Promise.resolve([[]])),
  };
}

function createMockRedis(overrides = {}) {
  return {
    get: overrides.get ?? (() => Promise.resolve(null)),
    set: overrides.set ?? (() => Promise.resolve("OK")),
  };
}

function makeApp(poolOverrides = {}, redisOverrides = {}) {
  const pool = createMockPool(poolOverrides);
  const redis = createMockRedis(redisOverrides);
  return createApp({ pool, redis, apiKey: TEST_API_KEY });
}

// ─── Auth ───────────────────────────────────────────────────────────

describe("authentication", () => {
  it("rejects requests without API key", async () => {
    const app = makeApp();
    const res = await app.request("/api/courses");
    expect(res.status).toBe(401);
  });

  it("rejects requests with wrong API key", async () => {
    const app = makeApp();
    const res = await app.request("/api/courses", {
      headers: { "x-api-key": "wrong-key" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts requests with correct API key", async () => {
    const app = makeApp({
      execute: () => Promise.resolve([[{ course_id: "1" }]]),
    });
    const res = await app.request("/api/courses", {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(res.status).toBe(200);
  });
});

// ─── GET /api/courses ───────────────────────────────────────────────

describe("GET /api/courses", () => {
  it("returns course data", async () => {
    const mockCourses = [
      { course_id: "1", course_title: "Intro to CS" },
      { course_id: "2", course_title: "Calculus I" },
    ];
    const app = makeApp({
      execute: () => Promise.resolve([mockCourses]),
    });

    const res = await app.request("/api/courses", {
      headers: { "x-api-key": TEST_API_KEY },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual(mockCourses);
    expect(body.data).toHaveLength(2);
  });

  it("returns 500 on database error", async () => {
    const app = makeApp({
      execute: () => Promise.reject(new Error("connection lost")),
    });

    const res = await app.request("/api/courses", {
      headers: { "x-api-key": TEST_API_KEY },
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
  });
});

// ─── GET /health ────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns healthy when database is connected", async () => {
    const app = makeApp({
      execute: () => Promise.resolve([[{ 1: 1 }]]),
    });

    const res = await app.request("/health");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.database).toBe("connected");
  });

  it("returns unhealthy when database is down", async () => {
    const app = makeApp({
      execute: () => Promise.reject(new Error("ECONNREFUSED")),
    });

    const res = await app.request("/health");
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.status).toBe("unhealthy");
    expect(body.database).toBe("disconnected");
  });
});

// ─── GET /api/query ─────────────────────────────────────────────────

describe("GET /api/query", () => {
  function queryRequest(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return `/api/query${qs ? `?${qs}` : ""}`;
  }

  it("rejects without API key", async () => {
    const app = makeApp();
    const res = await app.request(queryRequest());
    expect(res.status).toBe(401);
  });

  it("returns cached result on cache hit", async () => {
    const cachedData = {
      data: [{ course_uuid: "abc" }],
      count: 1,
      total_count: 1,
      has_more: false,
    };
    const app = makeApp(
      {},
      { get: () => Promise.resolve(JSON.stringify(cachedData)) }
    );

    const res = await app.request(queryRequest({ search_param: "CS" }), {
      headers: { "x-api-key": TEST_API_KEY },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual(cachedData.data);
  });

  it("returns empty data when no courses match", async () => {
    const app = makeApp({
      execute: (sql) => {
        if (sql.includes("COUNT")) return Promise.resolve([[{ total: 0 }]]);
        return Promise.resolve([[]]);
      },
    });

    const res = await app.request(queryRequest({ search_param: "ZZZZZ" }), {
      headers: { "x-api-key": TEST_API_KEY },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.count).toBe(0);
  });

  it("returns courses with sections on cache miss", async () => {
    let callIndex = 0;
    const app = makeApp({
      execute: (sql) => {
        callIndex++;
        if (callIndex === 1) {
          // Count query
          return Promise.resolve([[{ total: 1 }]]);
        }
        if (callIndex === 2) {
          // Distinct courses query
          return Promise.resolve([[{ course_uuid: "uuid-1" }]]);
        }
        if (callIndex === 3) {
          // Course details query
          return Promise.resolve([
            [
              {
                course_uuid: "uuid-1",
                course_id: "CS101",
                course_title: "Intro to CS",
                course_designation: "COMP SCI 101",
                cumulative_gpa: 3.5,
              },
            ],
          ]);
        }
        if (callIndex === 4) {
          // Sections with RMP and meetings
          return Promise.resolve([
            [
              {
                course_uuid: "uuid-1",
                section_id: "sec-1",
                unique_section_id: "usec-1",
                status: "OPEN",
                available_seats: 30,
                capacity: 50,
                enrolled: 20,
                instruction_mode: "In Person",
                section_avg_rating: 4.2,
                instructor_name: "John Doe",
                instructor_avg_rating: 4.5,
                meeting_number: 1,
                meeting_days: "MWF",
                start_time: "9:00",
                end_time: "9:50",
                meeting_type: "LEC",
                building_name: "CS Building",
              },
            ],
          ]);
        }
        return Promise.resolve([[]]);
      },
    });

    const res = await app.request(queryRequest(), {
      headers: { "x-api-key": TEST_API_KEY },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].course_uuid).toBe("uuid-1");
    expect(body.data[0].sections).toHaveLength(1);
    expect(body.data[0].sections[0].instructors).toHaveLength(1);
    expect(body.data[0].sections[0].meetings).toHaveLength(1);
  });

  it("applies status filter", async () => {
    let capturedSql = "";
    let capturedParams = [];
    const app = makeApp({
      execute: (sql, params) => {
        capturedSql += sql;
        if (params) capturedParams.push(...params);
        if (sql.includes("COUNT")) return Promise.resolve([[{ total: 0 }]]);
        return Promise.resolve([[]]);
      },
    });

    await app.request(queryRequest({ status: "OPEN" }), {
      headers: { "x-api-key": TEST_API_KEY },
    });

    expect(capturedSql).toContain("sections.status = ?");
    expect(capturedParams).toContain("OPEN");
  });

  it("status=CLOSED uses NOT EXISTS to find fully-closed courses", async () => {
    let capturedSql = "";
    const app = makeApp({
      execute: (sql) => {
        capturedSql += sql;
        if (sql.includes("COUNT")) return Promise.resolve([[{ total: 0 }]]);
        return Promise.resolve([[]]);
      },
    });

    await app.request(queryRequest({ status: "CLOSED" }), {
      headers: { "x-api-key": TEST_API_KEY },
    });

    expect(capturedSql).toContain("NOT EXISTS");
    expect(capturedSql).toContain("s_closed.status != 'CLOSED'");
    expect(capturedSql).not.toContain("sections.status = ?");
  });

  it("status=OPEN,CLOSED combines exists and NOT EXISTS with OR", async () => {
    let capturedSql = "";
    let capturedParams = [];
    const app = makeApp({
      execute: (sql, params) => {
        capturedSql += sql;
        if (params) capturedParams.push(...params);
        if (sql.includes("COUNT")) return Promise.resolve([[{ total: 0 }]]);
        return Promise.resolve([[]]);
      },
    });

    await app.request(queryRequest({ status: "OPEN,CLOSED" }), {
      headers: { "x-api-key": TEST_API_KEY },
    });

    expect(capturedSql).toContain("sections.status = ?");
    expect(capturedSql).toContain("NOT EXISTS");
    expect(capturedParams).toContain("OPEN");
  });

  it("applies multiple status filters with IN clause", async () => {
    let capturedSql = "";
    const app = makeApp({
      execute: (sql) => {
        capturedSql += sql;
        if (sql.includes("COUNT")) return Promise.resolve([[{ total: 0 }]]);
        return Promise.resolve([[]]);
      },
    });

    await app.request(queryRequest({ status: "OPEN,WAITLISTED" }), {
      headers: { "x-api-key": TEST_API_KEY },
    });

    expect(capturedSql).toContain("sections.status IN");
  });

  it("applies credit range filters", async () => {
    let capturedSql = "";
    let capturedParams = [];
    const app = makeApp({
      execute: (sql, params) => {
        capturedSql += sql;
        if (params) capturedParams.push(...params);
        if (sql.includes("COUNT")) return Promise.resolve([[{ total: 0 }]]);
        return Promise.resolve([[]]);
      },
    });

    await app.request(queryRequest({ min_credits: "3", max_credits: "4" }), {
      headers: { "x-api-key": TEST_API_KEY },
    });

    expect(capturedSql).toContain("courses.minimum_credits >= ?");
    expect(capturedSql).toContain("courses.maximum_credits <= ?");
  });

  it("applies GPA filters", async () => {
    let capturedSql = "";
    const app = makeApp({
      execute: (sql) => {
        capturedSql += sql;
        if (sql.includes("COUNT")) return Promise.resolve([[{ total: 0 }]]);
        return Promise.resolve([[]]);
      },
    });

    await app.request(
      queryRequest({ min_cumulative_gpa: "3.0", min_most_recent_gpa: "3.5" }),
      { headers: { "x-api-key": TEST_API_KEY } }
    );

    expect(capturedSql).toContain("madgrades_course_grades.cumulative_gpa >= ?");
    expect(capturedSql).toContain("madgrades_course_grades.most_recent_gpa >= ?");
  });

  it("applies search filter across multiple fields", async () => {
    let capturedSql = "";
    let capturedParams = [];
    const app = makeApp({
      execute: (sql, params) => {
        capturedSql += sql;
        if (params) capturedParams.push(...params);
        if (sql.includes("COUNT")) return Promise.resolve([[{ total: 0 }]]);
        return Promise.resolve([[]]);
      },
    });

    await app.request(queryRequest({ search_param: "calculus" }), {
      headers: { "x-api-key": TEST_API_KEY },
    });

    expect(capturedSql).toContain("courses.course_designation LIKE ?");
    expect(capturedSql).toContain("courses.course_title LIKE ?");
    expect(capturedParams).toContain("%calculus%");
  });

  it("applies breadth requirement filters", async () => {
    let capturedSql = "";
    let capturedParams = [];
    const app = makeApp({
      execute: (sql, params) => {
        capturedSql += sql;
        if (params) capturedParams.push(...params);
        if (sql.includes("COUNT")) return Promise.resolve([[{ total: 0 }]]);
        return Promise.resolve([[]]);
      },
    });

    await app.request(
      queryRequest({ ethnic_studies: "true", social_science: "true" }),
      { headers: { "x-api-key": TEST_API_KEY } }
    );

    expect(capturedSql).toContain("courses.ethnic_studies = ?");
    expect(capturedSql).toContain("courses.social_science = ?");
    expect(capturedParams).toContain("ETHNIC ST");
    expect(capturedParams).toContain("S");
  });

  it("applies RMP section-level filters", async () => {
    let capturedSql = "";
    const app = makeApp({
      execute: (sql) => {
        capturedSql += sql;
        if (sql.includes("COUNT")) return Promise.resolve([[{ total: 0 }]]);
        return Promise.resolve([[]]);
      },
    });

    await app.request(
      queryRequest({ min_section_avg_rating: "4.0" }),
      { headers: { "x-api-key": TEST_API_KEY } }
    );

    expect(capturedSql).toContain("section_rmp_avg.section_avg_rating >= ?");
    expect(capturedSql).toContain("JOIN section_rmp_avg ON");
  });

  it("applies sort by cumulative GPA", async () => {
    let capturedSql = "";
    const app = makeApp({
      execute: (sql) => {
        capturedSql += sql;
        if (sql.includes("COUNT")) return Promise.resolve([[{ total: 0 }]]);
        return Promise.resolve([[]]);
      },
    });

    await app.request(queryRequest({ sort: "cumulative_gpa" }), {
      headers: { "x-api-key": TEST_API_KEY },
    });

    expect(capturedSql).toContain(
      "ORDER BY madgrades_course_grades.cumulative_gpa DESC"
    );
  });

  it("paginates correctly", async () => {
    let callIndex = 0;
    const app = makeApp({
      execute: (sql) => {
        callIndex++;
        if (sql.includes("COUNT"))
          return Promise.resolve([[{ total: 25 }]]);
        if (callIndex === 2) {
          return Promise.resolve([
            [{ course_uuid: "uuid-page2" }],
          ]);
        }
        if (callIndex === 3) {
          return Promise.resolve([
            [
              {
                course_uuid: "uuid-page2",
                course_id: "CS200",
                course_title: "Data Structures",
              },
            ],
          ]);
        }
        return Promise.resolve([[]]);
      },
    });

    const res = await app.request(
      queryRequest({ page: "2", limit: "10" }),
      { headers: { "x-api-key": TEST_API_KEY } }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.has_more).toBe(true);
    expect(body.total_count).toBe(25);
  });

  it("returns 500 on database error", async () => {
    const app = makeApp({
      execute: () => Promise.reject(new Error("query failed")),
    });

    const res = await app.request(queryRequest(), {
      headers: { "x-api-key": TEST_API_KEY },
    });

    expect(res.status).toBe(500);
  });

  it("handles redis set failure gracefully", async () => {
    let callIndex = 0;
    const app = makeApp(
      {
        execute: (sql) => {
          callIndex++;
          if (sql.includes("COUNT")) return Promise.resolve([[{ total: 0 }]]);
          return Promise.resolve([[]]);
        },
      },
      {
        get: () => Promise.resolve(null),
        set: () => Promise.reject(new Error("redis down")),
      }
    );

    const res = await app.request(queryRequest({ search_param: "test" }), {
      headers: { "x-api-key": TEST_API_KEY },
    });

    expect(res.status).toBe(200);
  });

  it("applies prerequisite filters", async () => {
    let capturedSql = "";
    let capturedParams = [];
    const app = makeApp({
      execute: (sql, params) => {
        capturedSql += sql;
        if (params) capturedParams.push(...params);
        if (sql.includes("COUNT")) return Promise.resolve([[{ total: 0 }]]);
        return Promise.resolve([[]]);
      },
    });

    await app.request(queryRequest({ no_prereqs: "true" }), {
      headers: { "x-api-key": TEST_API_KEY },
    });

    expect(capturedSql).toContain("courses.enrollment_prerequisites = ?");
    expect(capturedParams).toContain("None");
  });

  it("applies meeting day time filters", async () => {
    let capturedSql = "";
    const app = makeApp({
      execute: (sql) => {
        capturedSql += sql;
        if (sql.includes("COUNT")) return Promise.resolve([[{ total: 0 }]]);
        return Promise.resolve([[]]);
      },
    });

    await app.request(
      queryRequest({
        mondayStartTime: "32400000",
        mondayEndTime: "36000000",
      }),
      { headers: { "x-api-key": TEST_API_KEY } }
    );

    expect(capturedSql).toContain("monday_meeting_start");
    expect(capturedSql).toContain("NOT EXISTS");
  });
});
