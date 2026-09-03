import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import pg from "pg";
import { createRegisterApp } from "../pg/routes/register.ts";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL is required");

const API_KEY = "test-key";
const app = createRegisterApp({ databaseUrl: connectionString, apiKey: API_KEY });

let pool: pg.Pool;
beforeAll(() => { pool = new pg.Pool({ connectionString }); });
afterAll(async () => { await pool.end(); });
beforeEach(async () => {
  await pool.query(`DELETE FROM "session" WHERE "userId" IN (SELECT id FROM "user" WHERE email LIKE 'reg-%')`);
  await pool.query(`DELETE FROM account WHERE "userId" IN (SELECT id FROM "user" WHERE email LIKE 'reg-%')`);
  await pool.query(`DELETE FROM "user" WHERE email LIKE 'reg-%'`);
});

const post = (body: unknown, key = API_KEY) =>
  app.request("http://localhost/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
  });

const seed = async (email: string, verified: boolean) => {
  const id = `u-${crypto.randomUUID()}`;
  await pool.query(
    `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt")
     VALUES ($1,'Seed',$2,$3,now(),now())`, [id, email, verified]);
  return id;
};

describe("POST /api/register", () => {
  test("requires the api key", async () => {
    expect((await post({ email: "reg-a@wisc.edu", password: "pw-123456", name: "A" }, "wrong")).status).toBe(401);
  });

  test("rejects a missing field", async () => {
    expect((await post({ email: "reg-a@wisc.edu" })).status).toBe(400);
  });

  test("a brand new address is CREATED", async () => {
    const res = await post({ email: `reg-${crypto.randomUUID()}@wisc.edu`, password: "pw-123456", name: "New" });
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("CREATED");
  });

  // The case that stranded real users: re-registering got a decoy success
  // from better-auth and no email was ever sent.
  test("an existing UNVERIFIED address resends verification", async () => {
    const email = `reg-${crypto.randomUUID()}@wisc.edu`;
    await seed(email, false);
    const res = await post({ email, password: "pw-123456", name: "Again" });
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("VERIFICATION_RESENT");
  });

  test("an existing VERIFIED address is told the account exists", async () => {
    const email = `reg-${crypto.randomUUID()}@wisc.edu`;
    await seed(email, true);
    const res = await post({ email, password: "pw-123456", name: "Again" });
    expect(res.status).toBe(409);
    expect((await res.json()).outcome).toBe("ACCOUNT_EXISTS");
  });

  test("matches an existing address case-insensitively", async () => {
    const email = `reg-${crypto.randomUUID()}@wisc.edu`;
    await seed(email, true);
    const res = await post({ email: email.toUpperCase(), password: "pw-123456", name: "Again" });
    expect(res.status).toBe(409);
  });
});
