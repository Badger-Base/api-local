import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import pg from "pg";
import { ensureSchema } from "./setup.ts";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL is required");

let pool: pg.Pool;
beforeAll(async () => {
  pool = new pg.Pool({ connectionString });
  // Apply the migrations rather than assuming another test file ran first.
  // Without this the suite passed locally, where these tables already
  // existed, and failed in CI against a fresh database — which is exactly
  // how it went unnoticed.
  await ensureSchema(pool);
});
afterAll(async () => { await pool.end(); });

async function columns(table: string): Promise<string[]> {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  return r.rows.map((x) => x.column_name);
}

describe("better-auth schema", () => {
  test("core tables exist", async () => {
    const r = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public'`
    );
    const names = r.rows.map((x) => x.table_name);
    for (const t of ["user", "session", "account", "verification", "jwks"]) {
      expect(names).toContain(t);
    }
  });

  // Regression guard: the published CLI omits this column, and its absence
  // fails at runtime with Postgres 42703 rather than at migration time.
  test("account.issuer exists", async () => {
    expect(await columns("account")).toContain("issuer");
  });

  test("user.id is text with no default, so the application supplies it rather than the database", async () => {
    const r = await pool.query(
      `SELECT data_type, column_default FROM information_schema.columns
       WHERE table_schema='public' AND table_name='user' AND column_name='id'`
    );
    expect(r.rows[0].data_type).toBe("text");
    expect(r.rows[0].column_default).toBeNull();
  });
});
