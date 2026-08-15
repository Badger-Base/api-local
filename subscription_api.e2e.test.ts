import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { createSubscriptionApp } from "./subscription_api";
import { sign } from "hono/jwt";
import { setupDb } from "./test/db.js";
import { fixture } from "./test/fixtures/subscription-default.js";

const TEST_API_KEY = "test-sub-api-key";
const JWT_SECRET = "test-jwt-secret-must-be-long-enough";

// ─── Helpers ───────────────────────────────────────────────────────

async function makeJwt(payload: Record<string, any> = {}) {
  return await sign(
    {
      sub: "user-123",
      email: "test@wisc.edu",
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...payload,
    },
    JWT_SECRET
  );
}

function authHeaders(token: string) {
  return {
    "X-API-Key": TEST_API_KEY,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function createMockPool() {
  return {
    execute: () => Promise.resolve([[], []]),
  };
}

function makeAuthApp() {
  return createSubscriptionApp({
    pool: createMockPool(),
    jwtSecret: JWT_SECRET,
    subscriptionApiKey: TEST_API_KEY,
  });
}

// ─── Database setup ────────────────────────────────────────────────

const testDb = setupDb();
const { db, pool: sqlitePool } = testDb;

function makeApp(sendEmail?: any) {
  return createSubscriptionApp({
    pool: sqlitePool,
    jwtSecret: JWT_SECRET,
    subscriptionApiKey: TEST_API_KEY,
    sendEmail,
    fromEmail: sendEmail ? "noreply@badgerbase.app" : undefined,
  });
}

beforeAll(() => {
  testDb.seed(fixture);
});

beforeEach(() => {
  db.exec("DELETE FROM course_subscriptions");
  db.exec("DELETE FROM section_subscriptions");
});

// ─── Auth: All Endpoints ───────────────────────────────────────────

describe("Auth - all endpoints reject unauthorized requests", () => {
  const endpoints = [
    { path: "/course-subscription", method: "POST", body: { course_id: "CS101", email: "test@wisc.edu" } },
    { path: "/course-subscription", method: "DELETE", body: { course_id: "CS101", email: "test@wisc.edu" } },
    { path: "/section-subscription", method: "POST", body: { section_id: "sec-1", email: "test@wisc.edu" } },
    { path: "/section-subscription", method: "DELETE", body: { section_id: "sec-1", email: "test@wisc.edu" } },
    { path: "/subscriptions?email=test@wisc.edu", method: "GET", body: undefined },
  ];

  for (const endpoint of endpoints) {
    test(`${endpoint.method} ${endpoint.path} - no API key → 401`, async () => {
      const app = makeAuthApp();
      const token = await makeJwt();
      const opts: any = {
        method: endpoint.method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      };
      if (endpoint.body) opts.body = JSON.stringify(endpoint.body);
      const res = await app.request(endpoint.path, opts);
      expect(res.status).toBe(401);
    });

    test(`${endpoint.method} ${endpoint.path} - wrong API key → 401`, async () => {
      const app = makeAuthApp();
      const token = await makeJwt();
      const opts: any = {
        method: endpoint.method,
        headers: { "X-API-Key": "wrong", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      };
      if (endpoint.body) opts.body = JSON.stringify(endpoint.body);
      const res = await app.request(endpoint.path, opts);
      expect(res.status).toBe(401);
    });

    test(`${endpoint.method} ${endpoint.path} - no JWT → 401`, async () => {
      const app = makeAuthApp();
      const opts: any = {
        method: endpoint.method,
        headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      };
      if (endpoint.body) opts.body = JSON.stringify(endpoint.body);
      const res = await app.request(endpoint.path, opts);
      expect(res.status).toBe(401);
    });

    test(`${endpoint.method} ${endpoint.path} - expired JWT → 401`, async () => {
      const app = makeAuthApp();
      const token = await sign(
        { sub: "user-123", email: "test@wisc.edu", exp: Math.floor(Date.now() / 1000) - 3600 },
        JWT_SECRET
      );
      const opts: any = { method: endpoint.method, headers: authHeaders(token) };
      if (endpoint.body) opts.body = JSON.stringify(endpoint.body);
      const res = await app.request(endpoint.path, opts);
      expect(res.status).toBe(401);
    });

    test(`${endpoint.method} ${endpoint.path} - JWT missing sub → 401`, async () => {
      const app = makeAuthApp();
      const token = await sign(
        { email: "test@wisc.edu", exp: Math.floor(Date.now() / 1000) + 3600 },
        JWT_SECRET
      );
      const opts: any = { method: endpoint.method, headers: authHeaders(token) };
      if (endpoint.body) opts.body = JSON.stringify(endpoint.body);
      const res = await app.request(endpoint.path, opts);
      expect(res.status).toBe(401);
    });

    test(`${endpoint.method} ${endpoint.path} - wrong JWT secret → 401`, async () => {
      const app = makeAuthApp();
      const token = await sign(
        { sub: "user-123", email: "test@wisc.edu", exp: Math.floor(Date.now() / 1000) + 3600 },
        "completely-wrong-secret-key-here"
      );
      const opts: any = { method: endpoint.method, headers: authHeaders(token) };
      if (endpoint.body) opts.body = JSON.stringify(endpoint.body);
      const res = await app.request(endpoint.path, opts);
      expect(res.status).toBe(401);
    });
  }
});

// ─── Course Subscription Lifecycle (real SQLite) ────────────────────

describe("Course subscription lifecycle", () => {
  test("create subscription → row exists in DB", async () => {
    const app = makeApp();
    const token = await makeJwt();
    const res = await app.request("/course-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "CS101", email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).message).toBe("Subscription created successfully");

    const rows = db.prepare("SELECT * FROM course_subscriptions WHERE email = ? AND course_id = ?").all("test@wisc.edu", "CS101");
    expect(rows).toHaveLength(1);
  });

  test("duplicate subscription → 200, still only 1 row", async () => {
    const app = makeApp();
    const token = await makeJwt();

    await app.request("/course-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "CS101", email: "test@wisc.edu" }),
    });

    const res2 = await app.request("/course-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "CS101", email: "test@wisc.edu" }),
    });
    expect(res2.status).toBe(200);
    expect((await res2.json()).message).toBe("Subscription already exists");

    const rows = db.prepare("SELECT * FROM course_subscriptions WHERE email = ? AND course_id = ?").all("test@wisc.edu", "CS101");
    expect(rows).toHaveLength(1);
  });

  test("delete subscription → row removed from DB", async () => {
    const app = makeApp();
    const token = await makeJwt();

    await app.request("/course-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "CS101", email: "test@wisc.edu" }),
    });

    const delRes = await app.request("/course-subscription", {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "CS101", email: "test@wisc.edu" }),
    });
    expect(delRes.status).toBe(200);
    expect((await delRes.json()).message).toBe("Subscription deleted successfully");

    const rows = db.prepare("SELECT * FROM course_subscriptions WHERE email = ? AND course_id = ?").all("test@wisc.edu", "CS101");
    expect(rows).toHaveLength(0);
  });

  test("delete nonexistent → 404", async () => {
    const app = makeApp();
    const token = await makeJwt();
    const res = await app.request("/course-subscription", {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "NONEXIST", email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Subscription not found");
  });

  test("missing course_id → 400", async () => {
    const app = makeApp();
    const token = await makeJwt();
    const res = await app.request("/course-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("course_id is required");
  });

  test("missing email on delete → 400", async () => {
    const app = makeApp();
    const token = await makeJwt();
    const res = await app.request("/course-subscription", {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "CS101" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("email is required");
  });

  test("email mismatch → 401", async () => {
    const app = makeApp();
    const token = await makeJwt({ email: "alice@wisc.edu" });
    const res = await app.request("/course-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "CS101", email: "bob@wisc.edu" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Email mismatch");
  });

  test("subscribe to multiple courses → all rows in DB", async () => {
    const app = makeApp();
    const token = await makeJwt();

    for (const cid of ["CS101", "MATH221", "PSYCH202"]) {
      const res = await app.request("/course-subscription", {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ course_id: cid, email: "test@wisc.edu" }),
      });
      expect(res.status).toBe(201);
    }

    const rows = db.prepare("SELECT * FROM course_subscriptions WHERE email = ?").all("test@wisc.edu");
    expect(rows).toHaveLength(3);
  });
});

// ─── Section Subscription Lifecycle (real SQLite) ───────────────────

describe("Section subscription lifecycle", () => {
  test("create section subscription → row exists in DB", async () => {
    const app = makeApp();
    const token = await makeJwt();
    const res = await app.request("/section-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "sec-1", email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(201);

    const rows = db.prepare("SELECT * FROM section_subscriptions WHERE email = ? AND section_id = ?").all("test@wisc.edu", "sec-1");
    expect(rows).toHaveLength(1);
  });

  test("duplicate section subscription → 200, 1 row", async () => {
    const app = makeApp();
    const token = await makeJwt();

    await app.request("/section-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "sec-1", email: "test@wisc.edu" }),
    });

    const res2 = await app.request("/section-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "sec-1", email: "test@wisc.edu" }),
    });
    expect(res2.status).toBe(200);
    expect((await res2.json()).message).toBe("Subscription already exists");

    const rows = db.prepare("SELECT * FROM section_subscriptions WHERE email = ? AND section_id = ?").all("test@wisc.edu", "sec-1");
    expect(rows).toHaveLength(1);
  });

  test("delete section subscription → row removed", async () => {
    const app = makeApp();
    const token = await makeJwt();

    await app.request("/section-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "sec-1", email: "test@wisc.edu" }),
    });

    const delRes = await app.request("/section-subscription", {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "sec-1", email: "test@wisc.edu" }),
    });
    expect(delRes.status).toBe(200);

    const rows = db.prepare("SELECT * FROM section_subscriptions WHERE email = ? AND section_id = ?").all("test@wisc.edu", "sec-1");
    expect(rows).toHaveLength(0);
  });

  test("delete nonexistent section sub → 404", async () => {
    const app = makeApp();
    const token = await makeJwt();
    const res = await app.request("/section-subscription", {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "sec-999", email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(404);
  });

  test("missing section_id → 400", async () => {
    const app = makeApp();
    const token = await makeJwt();
    const res = await app.request("/section-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("section_id is required");
  });

  test("missing email on section delete → 400", async () => {
    const app = makeApp();
    const token = await makeJwt();
    const res = await app.request("/section-subscription", {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "sec-1" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("email is required");
  });

  test("email mismatch on section sub → 401", async () => {
    const app = makeApp();
    const token = await makeJwt({ email: "alice@wisc.edu" });
    const res = await app.request("/section-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "sec-1", email: "bob@wisc.edu" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Email mismatch");
  });
});

// ─── GET /subscriptions - Real JOINed Data ──────────────────────────

describe("GET /subscriptions - real JOINed data", () => {
  test("subscribe to course, then list → response has real course data from JOIN", async () => {
    const app = makeApp();
    const token = await makeJwt();

    await app.request("/course-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "CS101", email: "test@wisc.edu" }),
    });

    const res = await app.request("/subscriptions?email=test@wisc.edu", {
      method: "GET",
      headers: { "X-API-Key": TEST_API_KEY, Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.course_subscriptions).toHaveLength(1);
    const sub = body.course_subscriptions[0];
    expect(sub.course_id).toBe("CS101");
    expect(sub.course_title).toBe("Intro to CS");
    expect(sub.course_designation).toBe("COMP SCI 101");
    expect(sub.full_course_designation).toBe("COMP SCI 101");
    expect(sub.course_uuid).toBe("uuid-1");
    expect(sub.email).toBe("test@wisc.edu");
  });

  test("subscribe to section with meetings → meetings array from JOIN", async () => {
    const app = makeApp();
    const token = await makeJwt();

    await app.request("/section-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "sec-1", email: "test@wisc.edu" }),
    });

    const res = await app.request("/subscriptions?email=test@wisc.edu", {
      method: "GET",
      headers: { "X-API-Key": TEST_API_KEY, Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.section_subscriptions).toHaveLength(1);
    const sub = body.section_subscriptions[0];
    expect(sub.section_id).toBe("sec-1");
    expect(sub.course_title).toBe("Intro to CS");
    expect(sub.course_uuid).toBe("uuid-1");
    expect(sub.section_status).toBe("OPEN");
    expect(sub.available_seats).toBe(30);
    expect(sub.instruction_mode).toBe("In Person");

    expect(sub.meetings).toHaveLength(2);
    const labels = sub.meetings.map((m: any) => m.label).sort();
    expect(labels).toEqual(["DIS 301", "LEC 001"]);
  });

  test("subscribe to section without meetings → empty meetings array", async () => {
    const app = makeApp();
    const token = await makeJwt();

    // sec-4 has no meetings (online/async)
    await app.request("/section-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "sec-4", email: "test@wisc.edu" }),
    });

    const res = await app.request("/subscriptions?email=test@wisc.edu", {
      method: "GET",
      headers: { "X-API-Key": TEST_API_KEY, Authorization: `Bearer ${token}` },
    });
    const body = await res.json();

    expect(body.section_subscriptions).toHaveLength(1);
    expect(body.section_subscriptions[0].meetings).toHaveLength(0);
    expect(body.section_subscriptions[0].course_title).toBe("Intro Psychology");
  });

  test("multiple course and section subscriptions → correct counts and data", async () => {
    const app = makeApp();
    const token = await makeJwt();

    // Subscribe to 2 courses
    await app.request("/course-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "CS101", email: "test@wisc.edu" }),
    });
    await app.request("/course-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "MATH221", email: "test@wisc.edu" }),
    });

    // Subscribe to 1 section
    await app.request("/section-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "sec-1", email: "test@wisc.edu" }),
    });

    const res = await app.request("/subscriptions?email=test@wisc.edu", {
      method: "GET",
      headers: { "X-API-Key": TEST_API_KEY, Authorization: `Bearer ${token}` },
    });
    const body = await res.json();

    expect(body.course_subscriptions).toHaveLength(2);
    const courseTitles = body.course_subscriptions.map((c: any) => c.course_title).sort();
    expect(courseTitles).toEqual(["Calculus I", "Intro to CS"]);

    expect(body.section_subscriptions).toHaveLength(1);
    expect(body.section_subscriptions[0].section_id).toBe("sec-1");
  });

  test("no subscriptions → empty arrays", async () => {
    const app = makeApp();
    const token = await makeJwt();

    const res = await app.request("/subscriptions?email=nobody@wisc.edu", {
      method: "GET",
      headers: { "X-API-Key": TEST_API_KEY, Authorization: `Bearer ${token}` },
    });
    const body = await res.json();

    expect(body.course_subscriptions).toEqual([]);
    expect(body.section_subscriptions).toEqual([]);
  });

  test("missing email param → 400", async () => {
    const app = makeApp();
    const token = await makeJwt();

    const res = await app.request("/subscriptions", {
      method: "GET",
      headers: { "X-API-Key": TEST_API_KEY, Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("email query parameter is required");
  });

  test("different users see only their own subscriptions", async () => {
    const app = makeApp();
    const tokenAlice = await makeJwt({ email: "alice@wisc.edu" });
    const tokenBob = await makeJwt({ email: "bob@wisc.edu" });

    await app.request("/course-subscription", {
      method: "POST",
      headers: authHeaders(tokenAlice),
      body: JSON.stringify({ course_id: "CS101", email: "alice@wisc.edu" }),
    });
    await app.request("/course-subscription", {
      method: "POST",
      headers: authHeaders(tokenBob),
      body: JSON.stringify({ course_id: "MATH221", email: "bob@wisc.edu" }),
    });

    const resAlice = await app.request("/subscriptions?email=alice@wisc.edu", {
      method: "GET",
      headers: { "X-API-Key": TEST_API_KEY, Authorization: `Bearer ${tokenAlice}` },
    });
    const bodyAlice = await resAlice.json();
    expect(bodyAlice.course_subscriptions).toHaveLength(1);
    expect(bodyAlice.course_subscriptions[0].course_title).toBe("Intro to CS");

    const resBob = await app.request("/subscriptions?email=bob@wisc.edu", {
      method: "GET",
      headers: { "X-API-Key": TEST_API_KEY, Authorization: `Bearer ${tokenBob}` },
    });
    const bodyBob = await resBob.json();
    expect(bodyBob.course_subscriptions).toHaveLength(1);
    expect(bodyBob.course_subscriptions[0].course_title).toBe("Calculus I");
  });

  test("subscribe to multiple sections of same course → grouped correctly", async () => {
    const app = makeApp();
    const token = await makeJwt();

    // sec-1 and sec-2 both belong to uuid-1 (Intro to CS)
    await app.request("/section-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "sec-1", email: "test@wisc.edu" }),
    });
    await app.request("/section-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "sec-2", email: "test@wisc.edu" }),
    });

    const res = await app.request("/subscriptions?email=test@wisc.edu", {
      method: "GET",
      headers: { "X-API-Key": TEST_API_KEY, Authorization: `Bearer ${token}` },
    });
    const body = await res.json();

    // Should be 2 separate section subscriptions (different section_ids)
    expect(body.section_subscriptions).toHaveLength(2);
    const secIds = body.section_subscriptions.map((s: any) => s.section_id).sort();
    expect(secIds).toEqual(["sec-1", "sec-2"]);

    // sec-1 has 2 meetings (LEC 001, DIS 301), sec-2 has 1 meeting (LEC 002)
    const sec1 = body.section_subscriptions.find((s: any) => s.section_id === "sec-1");
    const sec2 = body.section_subscriptions.find((s: any) => s.section_id === "sec-2");
    expect(sec1.meetings).toHaveLength(2);
    expect(sec2.meetings).toHaveLength(1);
    expect(sec2.meetings[0].label).toBe("LEC 002");
  });
});

// ─── Full Lifecycle (create → list → delete → list) ────────────────

describe("Full subscription lifecycle", () => {
  test("course: create → verify in list → delete → verify gone from list", async () => {
    const app = makeApp();
    const token = await makeJwt();

    // Create
    const createRes = await app.request("/course-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "CS101", email: "test@wisc.edu" }),
    });
    expect(createRes.status).toBe(201);

    // List — should be there
    const listRes1 = await app.request("/subscriptions?email=test@wisc.edu", {
      method: "GET",
      headers: { "X-API-Key": TEST_API_KEY, Authorization: `Bearer ${token}` },
    });
    const body1 = await listRes1.json();
    expect(body1.course_subscriptions).toHaveLength(1);
    expect(body1.course_subscriptions[0].course_title).toBe("Intro to CS");

    // Delete
    const delRes = await app.request("/course-subscription", {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "CS101", email: "test@wisc.edu" }),
    });
    expect(delRes.status).toBe(200);

    // List — should be empty
    const listRes2 = await app.request("/subscriptions?email=test@wisc.edu", {
      method: "GET",
      headers: { "X-API-Key": TEST_API_KEY, Authorization: `Bearer ${token}` },
    });
    const body2 = await listRes2.json();
    expect(body2.course_subscriptions).toHaveLength(0);
  });

  test("section: create → verify in list → delete → verify gone from list", async () => {
    const app = makeApp();
    const token = await makeJwt();

    // Create
    await app.request("/section-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "sec-1", email: "test@wisc.edu" }),
    });

    // List — should have section with meetings
    const listRes1 = await app.request("/subscriptions?email=test@wisc.edu", {
      method: "GET",
      headers: { "X-API-Key": TEST_API_KEY, Authorization: `Bearer ${token}` },
    });
    const body1 = await listRes1.json();
    expect(body1.section_subscriptions).toHaveLength(1);
    expect(body1.section_subscriptions[0].meetings.length).toBeGreaterThan(0);

    // Delete
    await app.request("/section-subscription", {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "sec-1", email: "test@wisc.edu" }),
    });

    // List — should be empty
    const listRes2 = await app.request("/subscriptions?email=test@wisc.edu", {
      method: "GET",
      headers: { "X-API-Key": TEST_API_KEY, Authorization: `Bearer ${token}` },
    });
    const body2 = await listRes2.json();
    expect(body2.section_subscriptions).toHaveLength(0);
  });
});

// ─── Email Sending (mock, not SQLite) ───────────────────────────────

describe("Email sending", () => {
  test("course subscription sends confirmation email with course_title", async () => {
    const emailCalls: any[] = [];
    const app = makeApp((...args: any[]) => {
      emailCalls.push(args);
      return Promise.resolve();
    });
    const token = await makeJwt();

    await app.request("/course-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        course_id: "CS101",
        email: "test@wisc.edu",
        course_title: "Intro to CS",
      }),
    });

    expect(emailCalls).toHaveLength(1);
    expect(emailCalls[0][0]).toBe("test@wisc.edu");
    expect(emailCalls[0][1]).toContain("Intro to CS");
    expect(emailCalls[0][2]).toContain("Subscription Confirmed");
  });

  test("no email sent without course_title", async () => {
    const emailCalls: any[] = [];
    const app = makeApp((...args: any[]) => {
      emailCalls.push(args);
      return Promise.resolve();
    });
    const token = await makeJwt();

    await app.request("/course-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "CS101", email: "test@wisc.edu" }),
    });

    expect(emailCalls).toHaveLength(0);
  });

  test("section subscription email includes section_names", async () => {
    const emailCalls: any[] = [];
    const app = makeApp((...args: any[]) => {
      emailCalls.push(args);
      return Promise.resolve();
    });
    const token = await makeJwt();

    await app.request("/section-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        section_id: "sec-1",
        email: "test@wisc.edu",
        course_title: "Intro to CS",
        section_names: ["LEC 001", "DIS 301"],
      }),
    });

    expect(emailCalls).toHaveLength(1);
    expect(emailCalls[0][2]).toContain("LEC 001, DIS 301");
    expect(emailCalls[0][2]).toContain("Sections:");
  });

  test("section email without section_names falls back to section_id", async () => {
    const emailCalls: any[] = [];
    const app = makeApp((...args: any[]) => {
      emailCalls.push(args);
      return Promise.resolve();
    });
    const token = await makeJwt();

    await app.request("/section-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        section_id: "sec-1",
        email: "test@wisc.edu",
        course_title: "Intro to CS",
      }),
    });

    expect(emailCalls[0][2]).toContain("Section ID: sec-1");
  });

  test("email failure doesn't break subscription creation", async () => {
    const app = makeApp(() => Promise.reject(new Error("SMTP down")));
    const token = await makeJwt();

    const res = await app.request("/course-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        course_id: "CS101",
        email: "test@wisc.edu",
        course_title: "Intro to CS",
      }),
    });
    expect(res.status).toBe(201);

    // Row still exists despite email failure
    const rows = db.prepare("SELECT * FROM course_subscriptions WHERE email = ?").all("test@wisc.edu");
    expect(rows).toHaveLength(1);
  });
});
