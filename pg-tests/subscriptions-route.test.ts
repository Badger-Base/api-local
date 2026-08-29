import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { auth } from "../auth.ts";
import { setupTestDb, markEmailVerified, type TestDb } from "./setup.ts";
import { fixture } from "./fixtures/default.ts";
import { createPgSubscriptionApp } from "../pg/routes/subscriptions.ts";

let testDb: TestDb;
let app: ReturnType<typeof createPgSubscriptionApp>;

const API_KEY = "test-sub-key";
// Unique per run: AUTH_DATABASE_URL is a persistent local database (not
// truncated between test runs like TEST_DATABASE_URL), so a fixed literal
// email would collide with a prior run's user on the unique constraint.
const TEST_EMAIL = `student-${crypto.randomUUID()}@wisc.edu`;

let validToken: string;
let baseUrl: string;

// Serve better-auth (and therefore its JWKS) on a real port so the
// middleware can fetch the key set exactly as it will in production.
// Mirrors the pattern in pg-tests/auth-middleware.test.ts.
async function signedInToken(email: string): Promise<string> {
  await auth.api.signUpEmail({
    body: { email, password: "test-password-123", name: "T" },
    asResponse: false,
  });
  // requireEmailVerification is on, so sign-in would 403 without this.
  await markEmailVerified(email);
  const res = await auth.api.signInEmail({
    body: { email, password: "test-password-123" },
    asResponse: true,
  });
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((c: string) => c.split(";")[0])
    .join("; ");
  const t = await auth.api.getToken({ headers: new Headers({ cookie }) });
  return (t as any).token;
}

beforeAll(async () => {
  testDb = await setupTestDb();

  const authApp = new Hono();
  authApp.all("/api/auth/*", (c) => auth.handler(c.req.raw));
  const server = Bun.serve({ port: 0, fetch: authApp.fetch });
  baseUrl = `http://localhost:${server.port}`;

  validToken = await signedInToken(TEST_EMAIL);

  app = createPgSubscriptionApp({
    db: testDb.db,
    jwksUrl: `${baseUrl}/api/auth/jwks`,
    subscriptionApiKey: API_KEY,
  });
});

afterAll(async () => {
  await testDb.teardown();
});

beforeEach(async () => {
  await testDb.seed(fixture);
});

function headers(overrides: Record<string, string> = {}) {
  return {
    "x-api-key": API_KEY,
    Authorization: `Bearer ${validToken}`,
    "Content-Type": "application/json",
    ...overrides,
  };
}

// ─── Auth ─────────────────────────────────────────────────────────

describe("auth", () => {
  it("rejects without API key", async () => {
    const res = await app.request("/course-subscription", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${validToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ course_id: "CS200", email: TEST_EMAIL }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects without JWT", async () => {
    const res = await app.request("/course-subscription", {
      method: "POST",
      headers: {
        "x-api-key": API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ course_id: "CS200", email: TEST_EMAIL }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects email mismatch", async () => {
    const res = await app.request("/course-subscription", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        course_id: "CS200",
        email: "different@wisc.edu",
      }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Email mismatch");
  });
});

// ─── Course Subscriptions ─────────────────────────────────────────

describe("course subscriptions", () => {
  it("creates a course subscription", async () => {
    const res = await app.request("/course-subscription", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        course_id: "CS200",
        email: TEST_EMAIL,
        course_title: "Programming I",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.message).toBe("Subscription created successfully");
  });

  it("returns 200 for duplicate subscription", async () => {
    await app.request("/course-subscription", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ course_id: "CS200", email: TEST_EMAIL }),
    });

    const res = await app.request("/course-subscription", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ course_id: "CS200", email: TEST_EMAIL }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Subscription already exists");
  });

  it("returns 404 for unknown course_id", async () => {
    const res = await app.request("/course-subscription", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ course_id: "FAKE999", email: TEST_EMAIL }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when course_id is missing", async () => {
    const res = await app.request("/course-subscription", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ email: TEST_EMAIL }),
    });
    expect(res.status).toBe(400);
  });

  it("deletes a course subscription", async () => {
    await app.request("/course-subscription", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ course_id: "CS200", email: TEST_EMAIL }),
    });

    const res = await app.request("/course-subscription", {
      method: "DELETE",
      headers: headers(),
      body: JSON.stringify({ course_id: "CS200", email: TEST_EMAIL }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Subscription deleted successfully");
  });

  it("returns 404 deleting non-existent subscription", async () => {
    const res = await app.request("/course-subscription", {
      method: "DELETE",
      headers: headers(),
      body: JSON.stringify({ course_id: "CS200", email: TEST_EMAIL }),
    });
    expect(res.status).toBe(404);
  });
});

// ─── Section Subscriptions ────────────────────────────────────────

describe("section subscriptions", () => {
  it("creates a section subscription", async () => {
    const res = await app.request("/section-subscription", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        section_id: "LEC001",
        email: TEST_EMAIL,
        course_title: "Programming I",
        section_names: ["LEC 001"],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.message).toBe("Subscription created successfully");
  });

  it("returns 200 for duplicate section subscription", async () => {
    await app.request("/section-subscription", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ section_id: "LEC001", email: TEST_EMAIL }),
    });

    const res = await app.request("/section-subscription", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ section_id: "LEC001", email: TEST_EMAIL }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Subscription already exists");
  });

  it("returns 404 for unknown section_id", async () => {
    const res = await app.request("/section-subscription", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ section_id: "FAKE999", email: TEST_EMAIL }),
    });
    expect(res.status).toBe(404);
  });

  it("deletes a section subscription", async () => {
    await app.request("/section-subscription", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ section_id: "LEC001", email: TEST_EMAIL }),
    });

    const res = await app.request("/section-subscription", {
      method: "DELETE",
      headers: headers(),
      body: JSON.stringify({ section_id: "LEC001", email: TEST_EMAIL }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 404 deleting non-existent section subscription", async () => {
    const res = await app.request("/section-subscription", {
      method: "DELETE",
      headers: headers(),
      body: JSON.stringify({ section_id: "LEC001", email: TEST_EMAIL }),
    });
    expect(res.status).toBe(404);
  });
});

// ─── List Subscriptions ───────────────────────────────────────────

describe("list subscriptions", () => {
  it("returns empty lists when no subscriptions", async () => {
    const res = await app.request(
      `/subscriptions?email=${encodeURIComponent(TEST_EMAIL)}`,
      { headers: headers() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.course_subscriptions).toEqual([]);
    expect(body.section_subscriptions).toEqual([]);
  });

  it("returns 400 when email param is missing", async () => {
    const res = await app.request("/subscriptions", {
      headers: headers(),
    });
    expect(res.status).toBe(400);
  });

  it("returns course subscriptions with course details", async () => {
    await app.request("/course-subscription", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ course_id: "CS200", email: TEST_EMAIL }),
    });
    await app.request("/course-subscription", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ course_id: "CS400", email: TEST_EMAIL }),
    });

    const res = await app.request(
      `/subscriptions?email=${encodeURIComponent(TEST_EMAIL)}`,
      { headers: headers() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.course_subscriptions.length).toBe(2);
    const cs200 = body.course_subscriptions.find(
      (s: any) => s.course_id === "CS200",
    );
    expect(cs200).toBeDefined();
    expect(cs200.course_title).toBe("Programming I");
    expect(cs200.course_designation).toBe("COMP SCI 200");
    expect(cs200.course_uuid).toBe("uuid-cs200");
    expect(cs200.subscription_id).toBeDefined();
  });

  it("returns section subscriptions with meetings grouped", async () => {
    // Subscribe to CS200's section 1 (id=1), which has a LEC meeting
    await app.request("/section-subscription", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ section_id: "LEC001", email: TEST_EMAIL }),
    });

    const res = await app.request(
      `/subscriptions?email=${encodeURIComponent(TEST_EMAIL)}`,
      { headers: headers() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.section_subscriptions.length).toBeGreaterThanOrEqual(1);
    const sub = body.section_subscriptions[0];
    expect(sub.section_id).toBe("LEC001");
    expect(sub.section_status).toBeDefined();
    expect(sub.course_title).toBeDefined();
    expect(sub.course_designation).toBeDefined();
    expect(sub.meetings).toBeInstanceOf(Array);
  });

  it("does not return other users' subscriptions", async () => {
    await app.request("/course-subscription", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ course_id: "CS200", email: TEST_EMAIL }),
    });

    const res = await app.request(
      `/subscriptions?email=${encodeURIComponent("other@wisc.edu")}`,
      { headers: headers() },
    );
    const body = await res.json();
    expect(body.course_subscriptions).toEqual([]);
  });
});

// ─── Email sending ────────────────────────────────────────────────

describe("email integration", () => {
  it("calls sendEmail on course subscribe when configured", async () => {
    const sent: { to: string; subject: string }[] = [];
    const appWithEmail = createPgSubscriptionApp({
      db: testDb.db,
      jwksUrl: `${baseUrl}/api/auth/jwks`,
      subscriptionApiKey: API_KEY,
      sendEmail: async (to, subject) => {
        sent.push({ to, subject });
      },
      fromEmail: "noreply@badgerbase.app",
    });

    await appWithEmail.request("/course-subscription", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        course_id: "CS200",
        email: TEST_EMAIL,
        course_title: "Programming I",
      }),
    });

    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe(TEST_EMAIL);
    expect(sent[0].subject).toContain("Programming I");
  });

  it("does not fail if sendEmail throws", async () => {
    const appWithBrokenEmail = createPgSubscriptionApp({
      db: testDb.db,
      jwksUrl: `${baseUrl}/api/auth/jwks`,
      subscriptionApiKey: API_KEY,
      sendEmail: async () => {
        throw new Error("SMTP down");
      },
      fromEmail: "noreply@badgerbase.app",
    });

    const res = await appWithBrokenEmail.request("/course-subscription", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        course_id: "CS400",
        email: TEST_EMAIL,
        course_title: "Programming III",
      }),
    });
    expect(res.status).toBe(201);
  });
});
