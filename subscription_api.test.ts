import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createSubscriptionApp } from "./subscription_api";
import { sign } from "hono/jwt";

const TEST_API_KEY = "test-sub-api-key";
const JWT_SECRET = "test-jwt-secret-must-be-long-enough";

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

function createMockPool(overrides: Record<string, any> = {}) {
  return {
    execute: overrides.execute ?? (() => Promise.resolve([[], []])),
  };
}

function makeApp(poolOverrides: Record<string, any> = {}, sendEmail?: any) {
  const pool = createMockPool(poolOverrides);
  return createSubscriptionApp({
    pool,
    jwtSecret: JWT_SECRET,
    subscriptionApiKey: TEST_API_KEY,
    sendEmail,
    fromEmail: sendEmail ? "noreply@badgerbase.app" : undefined,
  });
}

function authHeaders(token: string) {
  return {
    "X-API-Key": TEST_API_KEY,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

// ─── Auth Tests ──────────────────────────────────────────────────

describe("Authentication", () => {
  test("rejects request with no API key", async () => {
    const app = makeApp();
    const token = await makeJwt();
    const res = await app.request("/course-subscription", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ course_id: "CS101", email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("rejects request with wrong API key", async () => {
    const app = makeApp();
    const token = await makeJwt();
    const res = await app.request("/course-subscription", {
      method: "POST",
      headers: {
        "X-API-Key": "wrong-key",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ course_id: "CS101", email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects request with no JWT token", async () => {
    const app = makeApp();
    const res = await app.request("/course-subscription", {
      method: "POST",
      headers: {
        "X-API-Key": TEST_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ course_id: "CS101", email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects JWT with missing sub claim", async () => {
    const app = makeApp();
    const token = await sign(
      { email: "test@wisc.edu", exp: Math.floor(Date.now() / 1000) + 3600 },
      JWT_SECRET
    );
    const res = await app.request("/course-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "CS101", email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid token: missing user ID");
  });
});

// ─── POST /course-subscription ───────────────────────────────────

describe("POST /course-subscription", () => {
  test("creates a new course subscription", async () => {
    const executeCalls: any[] = [];
    const app = makeApp({
      execute: (...args: any[]) => {
        executeCalls.push(args);
        if (executeCalls.length === 1) return Promise.resolve([[], []]);
        return Promise.resolve([{ affectedRows: 1 }, []]);
      },
    });
    const token = await makeJwt();
    const res = await app.request("/course-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "CS101", email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.message).toBe("Subscription created successfully");
    expect(executeCalls.length).toBe(2);
    expect(executeCalls[0][0]).toContain("SELECT");
    expect(executeCalls[1][0]).toContain("INSERT");
  });

  test("returns 200 if subscription already exists", async () => {
    const app = makeApp({
      execute: () =>
        Promise.resolve([[{ id: 1, email: "test@wisc.edu", course_id: "CS101" }], []]),
    });
    const token = await makeJwt();
    const res = await app.request("/course-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "CS101", email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Subscription already exists");
  });

  test("returns 400 if course_id is missing", async () => {
    const app = makeApp();
    const token = await makeJwt();
    const res = await app.request("/course-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("course_id is required");
  });

  test("returns 401 on email mismatch", async () => {
    const app = makeApp();
    const token = await makeJwt({ email: "real@wisc.edu" });
    const res = await app.request("/course-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "CS101", email: "attacker@wisc.edu" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Email mismatch");
  });

  test("sends confirmation email when sendEmail is provided", async () => {
    const emailCalls: any[] = [];
    const mockSendEmail = (...args: any[]) => {
      emailCalls.push(args);
      return Promise.resolve();
    };

    const executeCalls: any[] = [];
    const app = makeApp(
      {
        execute: (...args: any[]) => {
          executeCalls.push(args);
          if (executeCalls.length === 1) return Promise.resolve([[], []]);
          return Promise.resolve([{ affectedRows: 1 }, []]);
        },
      },
      mockSendEmail
    );

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
    expect(emailCalls.length).toBe(1);
    expect(emailCalls[0][0]).toBe("test@wisc.edu");
    expect(emailCalls[0][1]).toContain("Intro to CS");
  });

  test("still succeeds if email sending fails", async () => {
    const failingSendEmail = () => Promise.reject(new Error("SMTP down"));

    const executeCalls: any[] = [];
    const app = makeApp(
      {
        execute: (...args: any[]) => {
          executeCalls.push(args);
          if (executeCalls.length === 1) return Promise.resolve([[], []]);
          return Promise.resolve([{ affectedRows: 1 }, []]);
        },
      },
      failingSendEmail
    );

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
  });

  test("returns 500 on database error", async () => {
    const app = makeApp({
      execute: () => Promise.reject(new Error("Connection refused")),
    });
    const token = await makeJwt();
    const res = await app.request("/course-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "CS101", email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to create subscription");
  });
});

// ─── DELETE /course-subscription ─────────────────────────────────

describe("DELETE /course-subscription", () => {
  test("deletes an existing course subscription", async () => {
    const executeCalls: any[] = [];
    const app = makeApp({
      execute: (...args: any[]) => {
        executeCalls.push(args);
        if (executeCalls.length === 1)
          return Promise.resolve([[{ id: 1 }], []]);
        return Promise.resolve([{ affectedRows: 1 }, []]);
      },
    });
    const token = await makeJwt();
    const res = await app.request("/course-subscription", {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "CS101", email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Subscription deleted successfully");
    expect(executeCalls[1][0]).toContain("DELETE");
  });

  test("returns 404 if subscription does not exist", async () => {
    const app = makeApp({
      execute: () => Promise.resolve([[], []]),
    });
    const token = await makeJwt();
    const res = await app.request("/course-subscription", {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "CS101", email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Subscription not found");
  });

  test("returns 400 if course_id is missing", async () => {
    const app = makeApp();
    const token = await makeJwt();
    const res = await app.request("/course-subscription", {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("course_id is required");
  });

  test("returns 400 if email is missing", async () => {
    const app = makeApp();
    const token = await makeJwt();
    const res = await app.request("/course-subscription", {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "CS101" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("email is required");
  });

  test("returns 500 on database error", async () => {
    const app = makeApp({
      execute: () => Promise.reject(new Error("DB down")),
    });
    const token = await makeJwt();
    const res = await app.request("/course-subscription", {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ course_id: "CS101", email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(500);
  });
});

// ─── POST /section-subscription ──────────────────────────────────

describe("POST /section-subscription", () => {
  test("creates a new section subscription", async () => {
    const executeCalls: any[] = [];
    const app = makeApp({
      execute: (...args: any[]) => {
        executeCalls.push(args);
        if (executeCalls.length === 1) return Promise.resolve([[], []]);
        return Promise.resolve([{ affectedRows: 1 }, []]);
      },
    });
    const token = await makeJwt();
    const res = await app.request("/section-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "SEC-001", email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.message).toBe("Subscription created successfully");
  });

  test("returns 200 if section subscription already exists", async () => {
    const app = makeApp({
      execute: () => Promise.resolve([[{ id: 1 }], []]),
    });
    const token = await makeJwt();
    const res = await app.request("/section-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "SEC-001", email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Subscription already exists");
  });

  test("returns 400 if section_id is missing", async () => {
    const app = makeApp();
    const token = await makeJwt();
    const res = await app.request("/section-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("section_id is required");
  });

  test("returns 401 on email mismatch", async () => {
    const app = makeApp();
    const token = await makeJwt({ email: "real@wisc.edu" });
    const res = await app.request("/section-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "SEC-001", email: "attacker@wisc.edu" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Email mismatch");
  });

  test("sends section confirmation email", async () => {
    const emailCalls: any[] = [];
    const mockSendEmail = (...args: any[]) => {
      emailCalls.push(args);
      return Promise.resolve();
    };

    const executeCalls: any[] = [];
    const app = makeApp(
      {
        execute: (...args: any[]) => {
          executeCalls.push(args);
          if (executeCalls.length === 1) return Promise.resolve([[], []]);
          return Promise.resolve([{ affectedRows: 1 }, []]);
        },
      },
      mockSendEmail
    );

    const token = await makeJwt();
    const res = await app.request("/section-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        section_id: "SEC-001",
        email: "test@wisc.edu",
        course_title: "Data Structures",
        section_names: ["LEC 001", "DIS 301"],
      }),
    });
    expect(res.status).toBe(201);
    expect(emailCalls.length).toBe(1);
    expect(emailCalls[0][1]).toContain("Data Structures");
  });

  test("returns 500 on database error", async () => {
    const app = makeApp({
      execute: () => Promise.reject(new Error("timeout")),
    });
    const token = await makeJwt();
    const res = await app.request("/section-subscription", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "SEC-001", email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(500);
  });
});

// ─── DELETE /section-subscription ────────────────────────────────

describe("DELETE /section-subscription", () => {
  test("deletes an existing section subscription", async () => {
    const executeCalls: any[] = [];
    const app = makeApp({
      execute: (...args: any[]) => {
        executeCalls.push(args);
        if (executeCalls.length === 1)
          return Promise.resolve([[{ id: 1 }], []]);
        return Promise.resolve([{ affectedRows: 1 }, []]);
      },
    });
    const token = await makeJwt();
    const res = await app.request("/section-subscription", {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "SEC-001", email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Subscription deleted successfully");
  });

  test("returns 404 if section subscription does not exist", async () => {
    const app = makeApp({
      execute: () => Promise.resolve([[], []]),
    });
    const token = await makeJwt();
    const res = await app.request("/section-subscription", {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "SEC-001", email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(404);
  });

  test("returns 400 if section_id is missing", async () => {
    const app = makeApp();
    const token = await makeJwt();
    const res = await app.request("/section-subscription", {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("section_id is required");
  });

  test("returns 400 if email is missing", async () => {
    const app = makeApp();
    const token = await makeJwt();
    const res = await app.request("/section-subscription", {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "SEC-001" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("email is required");
  });

  test("returns 500 on database error", async () => {
    const app = makeApp({
      execute: () => Promise.reject(new Error("DB crash")),
    });
    const token = await makeJwt();
    const res = await app.request("/section-subscription", {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ section_id: "SEC-001", email: "test@wisc.edu" }),
    });
    expect(res.status).toBe(500);
  });
});

// ─── GET /subscriptions ──────────────────────────────────────────

describe("GET /subscriptions", () => {
  test("returns course and section subscriptions", async () => {
    const executeCalls: any[] = [];
    const app = makeApp({
      execute: (...args: any[]) => {
        executeCalls.push(args);
        if (executeCalls.length === 1) {
          return Promise.resolve([
            [
              {
                subscription_id: 1,
                email: "test@wisc.edu",
                course_id: "CS101",
                course_title: "Intro to CS",
                course_designation: "CS 101",
                full_course_designation: "COMP SCI 101",
                course_uuid: "uuid-1",
              },
            ],
            [],
          ]);
        }
        return Promise.resolve([
          [
            {
              subscription_id: 10,
              email: "test@wisc.edu",
              section_id: "SEC-001",
              unique_section_id: "usec-1",
              section_status: "OPEN",
              available_seats: 5,
              instruction_mode: "In Person",
              course_title: "Data Structures",
              course_designation: "CS 200",
              full_course_designation: "COMP SCI 200",
              course_uuid: "uuid-2",
              section_number: "001",
              meeting_type: "LEC",
            },
            {
              subscription_id: 10,
              email: "test@wisc.edu",
              section_id: "SEC-001",
              unique_section_id: "usec-1",
              section_status: "OPEN",
              available_seats: 5,
              instruction_mode: "In Person",
              course_title: "Data Structures",
              course_designation: "CS 200",
              full_course_designation: "COMP SCI 200",
              course_uuid: "uuid-2",
              section_number: "301",
              meeting_type: "DIS",
            },
          ],
          [],
        ]);
      },
    });

    const token = await makeJwt();
    const res = await app.request("/subscriptions?email=test@wisc.edu", {
      method: "GET",
      headers: {
        "X-API-Key": TEST_API_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.course_subscriptions).toHaveLength(1);
    expect(body.course_subscriptions[0].course_title).toBe("Intro to CS");

    expect(body.section_subscriptions).toHaveLength(1);
    expect(body.section_subscriptions[0].meetings).toHaveLength(2);
    expect(body.section_subscriptions[0].meetings[0].label).toBe("LEC 001");
    expect(body.section_subscriptions[0].meetings[1].label).toBe("DIS 301");
  });

  test("deduplicates meetings with the same label", async () => {
    const executeCalls: any[] = [];
    const app = makeApp({
      execute: (...args: any[]) => {
        executeCalls.push(args);
        if (executeCalls.length === 1) return Promise.resolve([[], []]);
        return Promise.resolve([
          [
            {
              subscription_id: 10,
              email: "test@wisc.edu",
              section_id: "SEC-001",
              unique_section_id: "usec-1",
              section_status: "OPEN",
              available_seats: 5,
              instruction_mode: "In Person",
              course_title: "Data Structures",
              course_designation: "CS 200",
              full_course_designation: "COMP SCI 200",
              course_uuid: "uuid-2",
              section_number: "001",
              meeting_type: "LEC",
            },
            {
              subscription_id: 10,
              email: "test@wisc.edu",
              section_id: "SEC-001",
              unique_section_id: "usec-1",
              section_status: "OPEN",
              available_seats: 5,
              instruction_mode: "In Person",
              course_title: "Data Structures",
              course_designation: "CS 200",
              full_course_designation: "COMP SCI 200",
              course_uuid: "uuid-2",
              section_number: "001",
              meeting_type: "LEC",
            },
          ],
          [],
        ]);
      },
    });

    const token = await makeJwt();
    const res = await app.request("/subscriptions?email=test@wisc.edu", {
      method: "GET",
      headers: {
        "X-API-Key": TEST_API_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.section_subscriptions[0].meetings).toHaveLength(1);
  });

  test("returns 400 if email query param is missing", async () => {
    const app = makeApp();
    const token = await makeJwt();
    const res = await app.request("/subscriptions", {
      method: "GET",
      headers: {
        "X-API-Key": TEST_API_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("email query parameter is required");
  });

  test("returns empty arrays when no subscriptions exist", async () => {
    const app = makeApp({
      execute: () => Promise.resolve([[], []]),
    });
    const token = await makeJwt();
    const res = await app.request("/subscriptions?email=nobody@wisc.edu", {
      method: "GET",
      headers: {
        "X-API-Key": TEST_API_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.course_subscriptions).toEqual([]);
    expect(body.section_subscriptions).toEqual([]);
  });

  test("returns 500 on database error", async () => {
    const app = makeApp({
      execute: () => Promise.reject(new Error("Query failed")),
    });
    const token = await makeJwt();
    const res = await app.request("/subscriptions?email=test@wisc.edu", {
      method: "GET",
      headers: {
        "X-API-Key": TEST_API_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch subscriptions");
  });
});
