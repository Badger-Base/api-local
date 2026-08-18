import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Database } from "../pg/types.ts";

// The Task 1 `Database` type (pg/types.ts) does not include a `subjects`
// table interface even though `001_init.sql` defines one (courses.subject_code
// references it). Seeding/truncating `subjects` here therefore goes through
// raw `sql` rather than the Kysely query builder.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, "../schema/001_init.sql");

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
 * Ensures the schema from `schema/001_init.sql` exists on the target
 * database. No-ops if the `courses` table is already present (e.g. against
 * a shared/persistent test database), otherwise executes the full DDL file.
 */
async function ensureSchema(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ reg: string | null }>(
    "SELECT to_regclass('public.courses') AS reg"
  );
  if (rows[0]?.reg) return;

  if (!existsSync(SCHEMA_PATH)) {
    throw new Error(
      `Cannot initialize test schema: ${SCHEMA_PATH} not found. ` +
        `Ensure schema/001_init.sql is present or that DATABASE_URL points ` +
        `at an already-initialized database.`
    );
  }
  const ddl = readFileSync(SCHEMA_PATH, "utf-8");
  await pool.query(ddl);
}

export async function setupTestDb(): Promise<TestDb> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL env var is required to run pg-tests");
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
