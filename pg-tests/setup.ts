import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Database } from "../pg/types.ts";

// The Task 1 `Database` type (pg/types.ts) does not include a `subjects`
// table interface even though `001_init.sql` defines one (courses.subject_code
// references it). Seeding/truncating `subjects` here therefore goes through
// raw `sql` rather than the Kysely query builder.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.resolve(__dirname, "../schema");

export interface TestDb {
  db: Kysely<Database>;
  seed(fixture: TestFixture): Promise<void>;
  teardown(): Promise<void>;
}

export interface TestFixture {
  subjects: Array<{ subject_code: string; footnotes?: string | null }>;
  courses: Array<Record<string, unknown>>;
  sections: Array<Record<string, unknown>>;
  section_instructors: Array<{ section_ref: number; instructor_name: string }>;
  section_meetings: Array<Record<string, unknown>>;
  rmp_cleaned: Array<Record<string, unknown>>;
  madgrades_course_grades: Array<Record<string, unknown>>;
}

/**
 * Applies every `schema/NNN_*.sql` migration in filename order.
 *
 * `001_init.sql` is not idempotent, so it is skipped when `courses` already
 * exists. Every later migration must be written with IF NOT EXISTS guards
 * and is applied unconditionally — otherwise a persistent test database
 * would never receive migrations added after it was first created.
 */
async function ensureSchema(pool: pg.Pool): Promise<void> {
  if (!existsSync(SCHEMA_DIR)) {
    throw new Error(`Cannot initialize test schema: ${SCHEMA_DIR} not found.`);
  }

  const files = readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    throw new Error(`No .sql migrations found in ${SCHEMA_DIR}.`);
  }

  const { rows } = await pool.query<{ reg: string | null }>(
    "SELECT to_regclass('public.courses') AS reg"
  );
  const baseSchemaExists = Boolean(rows[0]?.reg);

  for (const file of files) {
    if (file.startsWith("001_") && baseSchemaExists) continue;
    await pool.query(readFileSync(path.join(SCHEMA_DIR, file), "utf-8"));
  }
}

export async function setupTestDb(): Promise<TestDb> {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error("TEST_DATABASE_URL env var is required to run pg-tests");
  }

  const pool = new pg.Pool({ connectionString });
  await ensureSchema(pool);

  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });

  async function seed(fixture: TestFixture) {
    await sql`SET client_min_messages TO warning`.execute(db);

    // Truncate all in dependency order (CASCADE makes exact order moot,
    // but kept in FK-dependent-first order for clarity).
    for (const table of [
      "section_subscriptions",
      "course_subscriptions",
      "section_meetings",
      "section_instructors",
      "sections",
      "madgrades_course_grades",
      "courses",
      "subjects",
      "rmp_cleaned",
    ] as const) {
      await sql`TRUNCATE TABLE ${sql.table(table)} CASCADE`.execute(db);
    }

    // Seed in dependency order
    if (fixture.subjects.length > 0) {
      for (const s of fixture.subjects) {
        await sql`
          INSERT INTO subjects (subject_code, footnotes)
          VALUES (${s.subject_code}, ${s.footnotes ?? null})
        `.execute(db);
      }
    }
    if (fixture.courses.length > 0) {
      await db.insertInto("courses").values(fixture.courses as any).execute();
    }
    if (fixture.sections.length > 0) {
      await db.insertInto("sections").values(fixture.sections as any).execute();
    }
    if (fixture.section_instructors.length > 0) {
      await db
        .insertInto("section_instructors")
        .values(
          fixture.section_instructors.map((si) => ({
            section_id: si.section_ref,
            instructor_name: si.instructor_name,
          }))
        )
        .execute();
    }
    if (fixture.section_meetings.length > 0) {
      await db.insertInto("section_meetings").values(fixture.section_meetings as any).execute();
    }
    if (fixture.rmp_cleaned.length > 0) {
      await db.insertInto("rmp_cleaned").values(fixture.rmp_cleaned as any).execute();
    }
    if (fixture.madgrades_course_grades.length > 0) {
      await db
        .insertInto("madgrades_course_grades")
        .values(fixture.madgrades_course_grades as any)
        .execute();
    }
  }

  async function teardown() {
    await db.destroy();
  }

  return { db, seed, teardown };
}

/**
 * Marks a better-auth user's email as verified.
 *
 * `auth.ts` sets `emailAndPassword.requireEmailVerification`, so a freshly
 * signed-up user is rejected at sign-in with 403 EMAIL_NOT_VERIFIED until
 * they click the emailed link. Tests that need a real session flip the
 * column directly rather than round-tripping a verification token through
 * an email sender that is deliberately unconfigured in this environment.
 *
 * This writes to AUTH_DATABASE_URL, not TEST_DATABASE_URL — better-auth's
 * tables live in the auth database, which is a separate pool from the one
 * `setupTestDb` returns.
 */
export async function markEmailVerified(email: string): Promise<void> {
  const connectionString = process.env.AUTH_DATABASE_URL;
  if (!connectionString) {
    throw new Error("AUTH_DATABASE_URL env var is required to run pg-tests");
  }

  const pool = new pg.Pool({ connectionString });
  try {
    const { rowCount } = await pool.query(
      'UPDATE "user" SET "emailVerified" = true WHERE "email" = $1',
      [email]
    );
    if (rowCount === 0) {
      throw new Error(`markEmailVerified: no user with email ${email}`);
    }
  } finally {
    await pool.end();
  }
}
