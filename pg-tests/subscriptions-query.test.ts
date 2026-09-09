import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDb, type TestDb } from "./setup.ts";
import { fixture } from "./fixtures/default.ts";
import { resolveUserEmail, findSubscriptions } from "../pg/subscriptions-query.ts";
import { renderSubscriptions } from "../pg/mcp/subscriptions-render.ts";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await setupTestDb();
  await testDb.seed(fixture);
});
afterAll(async () => {
  await testDb.teardown();
});

describe("resolveUserEmail", () => {
  test("maps a better-auth user id to their email", async () => {
    expect(await resolveUserEmail(testDb.db, "user-alpha")).toBe("alpha@wisc.edu");
  });

  test("returns null for an unknown user id", async () => {
    expect(await resolveUserEmail(testDb.db, "nobody")).toBeNull();
  });
});

describe("findSubscriptions", () => {
  test("returns the student's own course subscriptions", async () => {
    const subs = await findSubscriptions(testDb.db, "alpha@wisc.edu");
    expect(subs.courses.length).toBe(1);
  });

  // The test this whole task exists to make possible.
  test("never returns another student's subscriptions", async () => {
    const alpha = await findSubscriptions(testDb.db, "alpha@wisc.edu");
    const beta = await findSubscriptions(testDb.db, "beta@wisc.edu");
    expect(alpha.sections.length).toBe(0);
    expect(beta.courses.length).toBe(0);
    expect(beta.sections.length).toBe(1);
  });

  test("returns empty arrays for a student with no subscriptions", async () => {
    const subs = await findSubscriptions(testDb.db, "nobody@wisc.edu");
    expect(subs.courses).toEqual([]);
    expect(subs.sections).toEqual([]);
  });
});

describe("renderSubscriptions", () => {
  test("says plainly when there is nothing to show", () => {
    const out = renderSubscriptions({ courses: [], sections: [] });
    expect(out).toMatch(/not watching|no subscriptions/i);
    expect(out).not.toMatch(/undefined|null/);
  });

  test("shows section status and seats, which is the actual question", () => {
    const out = renderSubscriptions({
      courses: [{ designation: "COMP SCI 400", title: "Programming III" }],
      sections: [
        { designation: "COMP SCI 300", section_id: "LEC001", status: "OPEN", available_seats: 4 },
      ],
    });
    expect(out).toContain("COMP SCI 400");
    expect(out).toContain("LEC001");
    expect(out).toContain("OPEN");
    expect(out).toContain("4");
  });
});
