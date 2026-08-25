# Fuzzy Search + Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add typo-tolerant course/instructor search suggestions via a new Postgres-backed endpoint, surfaced in a debounced autocomplete dropdown in the frontend search box.

**Architecture:** A `pg_trgm` migration adds trigram GIN indexes. A pure query builder (`pg/builders/suggest.ts`) produces tier-scored course and instructor suggestions; a thin Hono route (`pg/routes/search.ts`) handles validation, merging, and caching, mounted at `/v2`. The frontend adds a proxy route, two hooks (debounce, then fetch-with-abort), and an ARIA combobox that wraps the existing search input.

**Tech Stack:** Bun + Hono + Kysely + Postgres (`pg_trgm`) + Redis on the API; Next.js 15 + React 19 + Tailwind v4 + Radix Popover + Vitest on the frontend.

**Spec:** `api-local/docs/superpowers/specs/2026-08-25-fuzzy-search-autocomplete-design.md`

## Global Constraints

- **Two separate git repos.** Tasks 1–6 are in `api-local` (branch `feat/pg-api`). Tasks 7–14 are in `BadgerBaseFrontend`. Commit in the repo the task's files live in. Never assume a shared root.
- **Package managers:** `api-local` uses **bun** (`bun test`). `BadgerBaseFrontend` uses **npm** (`package-lock.json` is the live lockfile; `pnpm-lock.yaml` is stale — do not use pnpm).
- **Backend tests require a real Postgres.** `pg-tests/setup.ts` throws without `TEST_DATABASE_URL`. Export it before running any `pg-tests` command.
- **`.ts` import extensions are required** in `api-local` — every relative import ends in `.ts` (e.g. `import { x } from "./types.ts"`). Match that exactly.
- **Never modify `api.js`**, the legacy MySQL API. It is being decommissioned.
- **Never change `/api/query` behavior.** All existing tests must keep passing untouched.
- **Similarity floor is `0.3`**, declared once as an exported constant, never inlined.
- **Score tiers are exactly:** prefix `2.0 + similarity`, substring `1.0 + similarity`, fuzzy `similarity`.
- **Default `limit` is `8`, clamped to `[1, 10]`. Minimum `q` length is `2`.**
- **Frontend styling uses design tokens only.** `__tests__/no-hardcoded-colors.test.ts` fails the build on raw hex or `bg-gray-*`/`text-red-*` classes. Use `bg-popover`, `border-border`, `text-text-secondary`, `bg-accent`, etc.
- **Debounce is 200ms.** Not a throttle.

### Deviation from the spec (intentional)

The spec's architecture sketch put all suggest logic in `pg/routes/search.ts`. This plan splits the SQL into `pg/builders/suggest.ts`, matching the existing `pg/builders/` convention (`course-filter.ts`, `grade-filter.ts`, `sort.ts`, `section-exists.ts`) and letting the ranking be tested without HTTP. The route keeps validation, merge, and cache.

---

## File Structure

**`api-local` (Tasks 1–6)**

| File | Responsibility |
|---|---|
| `schema/002_search_trgm.sql` | CREATE (T1) — extension + 4 GIN indexes |
| `pg-tests/setup.ts` | MODIFY (T1) — apply all `schema/*.sql` in sorted order |
| `pg-tests/schema-migrations.test.ts` | CREATE (T1) — asserts extension + indexes exist |
| `pg/cache.ts` | MODIFY (T2) — parameterize prefix + TTL |
| `pg-tests/cache.test.ts` | CREATE (T2) — prefix isolation |
| `pg/types.ts` | MODIFY (T3) — `Suggestion`, `SuggestResponse` types |
| `pg/builders/suggest.ts` | CREATE (T3) — scored course + instructor queries |
| `pg-tests/fixtures/default.ts` | MODIFY (T3) — rows that exercise ranking |
| `pg-tests/suggest-builder.test.ts` | CREATE (T3) — ranking + typo tolerance |
| `pg/routes/search.ts` | CREATE (T4) — HTTP, validation, merge, cache |
| `pg-tests/search-route.test.ts` | CREATE (T4) — endpoint contract |
| `server.ts` | MODIFY (T5) — mount at `/v2` |
| `docs/query-api-reference.md` | MODIFY (T6) — document endpoint |

**`BadgerBaseFrontend` (Tasks 7–14)**

| File | Responsibility |
|---|---|
| `vitest.config.ts`, `package.json`, `__tests__/setup.ts` | MODIFY/CREATE (T7) — component test infra |
| `lib/allowed-origins.ts` | CREATE (T8) — shared CORS allowlist |
| `app/api/proxy/route.ts` | MODIFY (T8) — import shared allowlist |
| `app/api/search-suggest/route.ts` | CREATE (T9) — proxy to `/v2/api/search/suggest` |
| `hooks/use-debounced-value.ts` | CREATE (T10) — generic debouncer |
| `hooks/use-search-suggestions.ts` | CREATE (T11) — fetch + abort + state |
| `components/ui/popover.tsx` | CREATE (T13) — Radix popover wrapper |
| `components/search-autocomplete.tsx` | CREATE (T13) — the combobox |
| `components/search-filters.tsx` | MODIFY (T14) — swap the Input |

---

## Task 1: Trigram migration and a migration-aware test harness

**Files:**
- Create: `api-local/schema/002_search_trgm.sql`
- Modify: `api-local/pg-tests/setup.ts` (`ensureSchema`, lines 32–52)
- Test: `api-local/pg-tests/schema-migrations.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the `pg_trgm` extension and four GIN indexes on any database `setupTestDb()` touches. `setupTestDb(): Promise<TestDb>` keeps its existing signature.

**Why `ensureSchema` must change:** it currently returns early whenever `to_regclass('public.courses')` is non-null, so any already-initialized database — including a developer's persistent test DB — would silently never receive `002`. Every future migration would hit the same trap.

- [ ] **Step 1: Write the failing test**

Create `api-local/pg-tests/schema-migrations.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "kysely";
import { setupTestDb, type TestDb } from "./setup.ts";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await setupTestDb();
});

afterAll(async () => {
  await testDb.teardown();
});

describe("schema migrations", () => {
  it("installs the pg_trgm extension", async () => {
    const result = await sql<{ extname: string }>`
      SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'
    `.execute(testDb.db);
    expect(result.rows.length).toBe(1);
  });

  it("creates trigram GIN indexes on all searchable columns", async () => {
    const result = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname LIKE '%_trgm'
    `.execute(testDb.db);
    const names = result.rows.map((r) => r.indexname).sort();
    expect(names).toEqual([
      "idx_courses_designation_trgm",
      "idx_courses_full_designation_trgm",
      "idx_courses_title_trgm",
      "idx_section_instructors_name_trgm",
    ]);
  });

  it("similarity() is callable and scores a near-miss above the 0.3 floor", async () => {
    const result = await sql<{ score: number }>`
      SELECT similarity('COMP SCI 200', 'COMP SIC 200') AS score
    `.execute(testDb.db);
    expect(result.rows[0].score).toBeGreaterThan(0.3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api-local
export TEST_DATABASE_URL='postgres://localhost:5432/badgerbase_test'
bun test pg-tests/schema-migrations.test.ts
```

Expected: FAIL — `pg_extension` query returns 0 rows.

- [ ] **Step 3: Write the migration**

Create `api-local/schema/002_search_trgm.sql`:

```sql
-- Trigram fuzzy search support for /v2/api/search/suggest.
-- Every statement is idempotent so this file is safe to re-apply.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_courses_designation_trgm
  ON courses USING gin (course_designation gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_courses_title_trgm
  ON courses USING gin (course_title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_courses_full_designation_trgm
  ON courses USING gin (full_course_designation gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_section_instructors_name_trgm
  ON section_instructors USING gin (instructor_name gin_trgm_ops);
```

- [ ] **Step 4: Make `ensureSchema` apply every migration**

In `api-local/pg-tests/setup.ts`, replace the `SCHEMA_PATH` constant and the whole `ensureSchema` function with:

```ts
const SCHEMA_DIR = path.resolve(__dirname, "../schema");

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
```

Update the `node:fs` import on line 3 to add `readdirSync`:

```ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test pg-tests/schema-migrations.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Verify no existing test regressed**

```bash
bun test pg-tests/
```

Expected: PASS — all pre-existing pg-tests still green.

- [ ] **Step 7: Commit**

```bash
git add schema/002_search_trgm.sql pg-tests/setup.ts pg-tests/schema-migrations.test.ts
git commit -m "feat(search): add pg_trgm extension and trigram GIN indexes"
```

---

## Task 2: Parameterize the Redis cache

**Files:**
- Modify: `api-local/pg/cache.ts` (whole file)
- Test: `api-local/pg-tests/cache.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `createCache(redis: Redis, options?: { prefix?: string; ttl?: number }): QueryCache`. Defaults `prefix: "pg:query:"`, `ttl: 3600`. The `QueryCache` interface is unchanged, so `pg/routes/courses.ts` and `server.ts` need no edits.

Suggestions need their own namespace and a much shorter TTL. `bustAll` must stay scoped to its own prefix so busting the query cache cannot wipe suggestions.

- [ ] **Step 1: Write the failing test**

Create `api-local/pg-tests/cache.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { createCache } from "../pg/cache.ts";

/** Minimal in-memory stand-in for the ioredis surface createCache uses. */
function fakeRedis() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    store,
    ttls,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string, _ex: string, seconds: number) {
      store.set(key, value);
      ttls.set(key, seconds);
      return "OK";
    },
    async keys(pattern: string) {
      const prefix = pattern.replace(/\*$/, "");
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
    async del(...keys: string[]) {
      for (const k of keys) store.delete(k);
      return keys.length;
    },
  };
}

describe("createCache", () => {
  it("defaults to the pg:query: prefix and a 1 hour TTL", async () => {
    const redis = fakeRedis();
    const cache = createCache(redis as any);
    await cache.set({ a: "1" }, { ok: true });

    const key = [...redis.store.keys()][0];
    expect(key).toBe("pg:query:a=1");
    expect(redis.ttls.get(key)).toBe(3600);
  });

  it("honors a custom prefix and TTL", async () => {
    const redis = fakeRedis();
    const cache = createCache(redis as any, { prefix: "pg:suggest:", ttl: 300 });
    await cache.set({ q: "comp" }, { suggestions: [] });

    const key = [...redis.store.keys()][0];
    expect(key).toBe("pg:suggest:q=comp");
    expect(redis.ttls.get(key)).toBe(300);
  });

  it("bustAll only clears its own prefix", async () => {
    const redis = fakeRedis();
    const queryCache = createCache(redis as any);
    const suggestCache = createCache(redis as any, { prefix: "pg:suggest:", ttl: 300 });

    await queryCache.set({ a: "1" }, { ok: true });
    await suggestCache.set({ q: "comp" }, { suggestions: [] });

    await queryCache.bustAll();

    expect(redis.store.has("pg:query:a=1")).toBe(false);
    expect(redis.store.has("pg:suggest:q=comp")).toBe(true);
  });

  it("builds identical keys regardless of param order", async () => {
    const redis = fakeRedis();
    const cache = createCache(redis as any);
    await cache.set({ b: "2", a: "1" }, { ok: true });
    const hit = await cache.get({ a: "1", b: "2" });
    expect(hit).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test pg-tests/cache.test.ts
```

Expected: FAIL — the custom-prefix test writes to `pg:query:q=comp`, because `createCache` ignores its second argument.

- [ ] **Step 3: Implement**

In `api-local/pg/cache.ts`, replace the two module constants and the `createCache` signature. Delete lines 3–4 (`CACHE_PREFIX` / `CACHE_TTL`) and replace with:

```ts
const DEFAULT_PREFIX = "pg:query:";
const DEFAULT_TTL = 3600; // 1 hour

export interface CacheOptions {
  /** Redis key namespace. Must end in ':'. */
  prefix?: string;
  /** Expiry in seconds. */
  ttl?: number;
}
```

Change the factory signature and the two constant references inside it:

```ts
export function createCache(redis: Redis, options: CacheOptions = {}): QueryCache {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const ttl = options.ttl ?? DEFAULT_TTL;

  function hashKey(params: Record<string, string>): string {
    const sorted = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");
    return `${prefix}${sorted}`;
  }
  // ...body unchanged, except: use `ttl` in set() and `${prefix}*` in bustAll()
```

Inside `set`, `"EX", CACHE_TTL` becomes `"EX", ttl`. Inside `bustAll`, `` `${CACHE_PREFIX}*` `` becomes `` `${prefix}*` ``.

Update the doc comment above `createCache` to say the namespace and TTL are configurable.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test pg-tests/cache.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Verify existing callers still work**

```bash
bun test pg-tests/
```

Expected: PASS — `createCache(redis)` call sites are unaffected by the added optional parameter.

- [ ] **Step 6: Commit**

```bash
git add pg/cache.ts pg-tests/cache.test.ts
git commit -m "refactor(cache): parameterize Redis prefix and TTL"
```

---

## Task 3: The suggestion query builder

**Files:**
- Create: `api-local/pg/builders/suggest.ts`
- Modify: `api-local/pg/types.ts` (append to the API Response types section)
- Modify: `api-local/pg-tests/fixtures/default.ts`
- Test: `api-local/pg-tests/suggest-builder.test.ts`

**Interfaces:**
- Consumes: `Database` from `../types.ts`; `setupTestDb` from `pg-tests/setup.ts`.
- Produces:
  - `SIMILARITY_FLOOR: number` (`0.3`)
  - `escapeLikePattern(input: string): string`
  - `type SuggestionType = "course" | "instructor"`
  - `interface Suggestion { type: SuggestionType; value: string; label: string; sublabel: string | null; course_uuid: string | null }`
  - `interface SuggestResponse { suggestions: Suggestion[] }`
  - `interface ScoredSuggestion extends Suggestion { score: number }`
  - `searchCourses(db: Kysely<Database>, q: string, limit: number): Promise<ScoredSuggestion[]>`
  - `searchInstructors(db: Kysely<Database>, q: string, limit: number): Promise<ScoredSuggestion[]>`
  - `mergeSuggestions(courses: ScoredSuggestion[], instructors: ScoredSuggestion[], limit: number): Suggestion[]`

**Escaping matters:** `q` is interpolated into `ILIKE` patterns. Without escaping, a user typing `%` matches everything and `_` matches any character. `escapeLikePattern` prefixes `\`, `%`, and `_` with a backslash; the SQL uses the default backslash escape character.

- [ ] **Step 1: Extend the fixture**

In `api-local/pg-tests/fixtures/default.ts`, add two courses to the `courses` array (after the `id: 5` entry, before the closing `]`):

```ts
    {
      id: 6, course_id: "CS540", course_uuid: "uuid-cs540",
      subject_code: "COMP SCI", course_designation: "COMP SCI 540",
      full_course_designation: "COMP SCI 540 — Intro to Artificial Intelligence",
      course_title: "Introduction to Artificial Intelligence", catalog_number: 540,
      course_description: "AI fundamentals",
      enrollment_prerequisites: "COMP SCI 300",
      minimum_credits: 3, maximum_credits: 3,
      letters_and_science_credits: true,
      ethnic_studies: false, social_science: false, humanities: false,
      biological_science: false, physical_science: false,
      natural_science: false, literature: false,
      general_education: null, level: "Advanced",
      typically_offered: "Fall, Spring",
      workplace_experience_description: null,
      grading_basis_description: "A-F",
      open_to_first_year: false, repeatable_for_credit: false,
    },
    {
      id: 7, course_id: "STAT240", course_uuid: "uuid-stat240",
      subject_code: "STAT", course_designation: "STAT 240",
      full_course_designation: "STAT 240 — Data Science Modeling I",
      course_title: "Introduction to Data Modeling I", catalog_number: 240,
      course_description: "Statistical modeling",
      enrollment_prerequisites: "None",
      minimum_credits: 4, maximum_credits: 4,
      letters_and_science_credits: true,
      ethnic_studies: false, social_science: false, humanities: false,
      biological_science: false, physical_science: false,
      natural_science: true, literature: false,
      general_education: null, level: "Elementary",
      typically_offered: "Fall, Spring",
      workplace_experience_description: null,
      grading_basis_description: "A-F",
      open_to_first_year: true, repeatable_for_credit: false,
    },
```

Add the `STAT` subject to the `subjects` array (courses.subject_code has an FK to it):

```ts
    { subject_code: "STAT", footnotes: null },
```

Add sections for the two new courses to the `sections` array:

```ts
    { id: 9, section_id: "LEC001", section_uuid: "suuid-9", course_ref: 6, status: "OPEN", available_seats: 10, waitlist_total: 0, capacity: 120, enrolled: 110, instruction_mode: "In Person", is_asynchronous: false, section_requisites: null },
    { id: 10, section_id: "LEC002", section_uuid: "suuid-10", course_ref: 6, status: "OPEN", available_seats: 5, waitlist_total: 0, capacity: 120, enrolled: 115, instruction_mode: "In Person", is_asynchronous: false, section_requisites: null },
    { id: 11, section_id: "LEC001", section_uuid: "suuid-11", course_ref: 7, status: "OPEN", available_seats: 40, waitlist_total: 0, capacity: 200, enrolled: 160, instruction_mode: "In Person", is_asynchronous: false, section_requisites: null },
```

Add instructors — `Jim Williams` teaches three sections, which exercises deduplication and the section count:

```ts
    { section_ref: 9, instructor_name: "Jim Williams" },
    { section_ref: 10, instructor_name: "Jim Williams" },
    { section_ref: 11, instructor_name: "Jim Williams" },
```

Existing tests assert on specific result sets. Run the suite now and fix any count-based assertion the new rows broke:

```bash
bun test pg-tests/
```

If a pre-existing test fails purely because there are now 7 courses instead of 5, update that test's expected list — do not remove the new fixture rows.

- [ ] **Step 2: Write the failing test**

Create `api-local/pg-tests/suggest-builder.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDb, type TestDb } from "./setup.ts";
import { fixture } from "./fixtures/default.ts";
import {
  searchCourses,
  searchInstructors,
  mergeSuggestions,
  escapeLikePattern,
  type ScoredSuggestion,
} from "../pg/builders/suggest.ts";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await setupTestDb();
  await testDb.seed(fixture);
});

afterAll(async () => {
  await testDb.teardown();
});

const values = (rows: ScoredSuggestion[]) => rows.map((r) => r.value);

describe("escapeLikePattern", () => {
  it("escapes LIKE wildcards so they match literally", () => {
    expect(escapeLikePattern("100%_x")).toBe("100\\%\\_x");
  });

  it("escapes backslashes before wildcards", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });
});

describe("searchCourses", () => {
  it("returns an exact designation match first", async () => {
    const rows = await searchCourses(testDb.db, "COMP SCI 200", 8);
    expect(rows[0].value).toBe("COMP SCI 200");
    expect(rows[0].type).toBe("course");
  });

  it("ranks prefix matches above fuzzy-only matches", async () => {
    const rows = await searchCourses(testDb.db, "COMP SCI 5", 8);
    const top = rows.slice(0, 2).map((r) => r.value);
    expect(top).toContain("COMP SCI 540");
    expect(top).toContain("COMP SCI 577");
    // A fuzzy-only match must not outrank a literal prefix match.
    expect(rows[0].score).toBeGreaterThanOrEqual(2.0);
  });

  it("tolerates a typo in the designation", async () => {
    const rows = await searchCourses(testDb.db, "COMP SIC 200", 8);
    expect(values(rows)).toContain("COMP SCI 200");
  });

  it("matches on course title words", async () => {
    const rows = await searchCourses(testDb.db, "Algorithms", 8);
    expect(values(rows)).toContain("COMP SCI 577");
  });

  it("carries the title as sublabel and the uuid", async () => {
    const rows = await searchCourses(testDb.db, "COMP SCI 200", 8);
    expect(rows[0].sublabel).toBe("Programming I");
    expect(rows[0].course_uuid).toBe("uuid-cs200");
  });

  it("respects the limit", async () => {
    const rows = await searchCourses(testDb.db, "COMP SCI", 2);
    expect(rows.length).toBe(2);
  });

  it("treats % as a literal character, not a wildcard", async () => {
    const rows = await searchCourses(testDb.db, "%", 8);
    expect(rows.length).toBe(0);
  });

  it("is deterministic across repeated runs", async () => {
    const a = await searchCourses(testDb.db, "COMP SCI", 8);
    const b = await searchCourses(testDb.db, "COMP SCI", 8);
    expect(values(a)).toEqual(values(b));
  });
});

describe("searchInstructors", () => {
  it("tolerates a typo in the instructor name", async () => {
    const rows = await searchInstructors(testDb.db, "Willliams", 8);
    expect(values(rows)).toContain("Jim Williams");
  });

  it("returns an instructor once regardless of section count", async () => {
    const rows = await searchInstructors(testDb.db, "Jim Williams", 8);
    const hits = rows.filter((r) => r.value === "Jim Williams");
    expect(hits.length).toBe(1);
  });

  it("reports the section count in the sublabel", async () => {
    const rows = await searchInstructors(testDb.db, "Jim Williams", 8);
    expect(rows[0].sublabel).toBe("Instructor · 3 sections");
  });

  it("singularizes a one-section instructor", async () => {
    const rows = await searchInstructors(testDb.db, "Math Teacher", 8);
    expect(rows[0].sublabel).toBe("Instructor · 1 section");
  });

  it("has a null course_uuid", async () => {
    const rows = await searchInstructors(testDb.db, "Jim Williams", 8);
    expect(rows[0].course_uuid).toBeNull();
  });
});

describe("mergeSuggestions", () => {
  const course = (value: string, score: number): ScoredSuggestion => ({
    type: "course", value, label: value, sublabel: null, course_uuid: "u", score,
  });
  const instructor = (value: string, score: number): ScoredSuggestion => ({
    type: "instructor", value, label: value, sublabel: null, course_uuid: null, score,
  });

  it("sorts by score descending", () => {
    const merged = mergeSuggestions([course("a", 1.0)], [instructor("b", 2.0)], 8);
    expect(merged.map((m) => m.value)).toEqual(["b", "a"]);
  });

  it("truncates to the limit", () => {
    const merged = mergeSuggestions(
      [course("a", 3), course("b", 2), course("c", 1)], [], 2
    );
    expect(merged.length).toBe(2);
  });

  it("guarantees an instructor slot when courses would fill every slot", () => {
    const merged = mergeSuggestions(
      [course("a", 3.0), course("b", 2.9)], [instructor("prof", 0.4)], 2
    );
    expect(merged.map((m) => m.value)).toEqual(["a", "prof"]);
  });

  it("does not force an instructor slot when there are no instructors", () => {
    const merged = mergeSuggestions([course("a", 3.0), course("b", 2.9)], [], 2);
    expect(merged.map((m) => m.value)).toEqual(["a", "b"]);
  });

  it("strips the score from its output", () => {
    const merged = mergeSuggestions([course("a", 3.0)], [], 8);
    expect("score" in merged[0]).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test pg-tests/suggest-builder.test.ts
```

Expected: FAIL — `Cannot find module '../pg/builders/suggest.ts'`.

- [ ] **Step 4: Add the shared types**

Append to `api-local/pg/types.ts`, after the `ApiQueryResponse` interface:

```ts
// ── Search suggestion types ──

export type SuggestionType = "course" | "instructor";

export interface Suggestion {
  type: SuggestionType;
  /** Written into `search_param` when the suggestion is selected. */
  value: string;
  label: string;
  sublabel: string | null;
  /** Present for courses, null for instructors. */
  course_uuid: string | null;
}

export interface SuggestResponse {
  suggestions: Suggestion[];
}
```

- [ ] **Step 5: Implement the builder**

Create `api-local/pg/builders/suggest.ts`:

```ts
import { sql, type Kysely } from "kysely";
import type { Database, Suggestion } from "../types.ts";

/**
 * Minimum trigram similarity for a fuzzy (non-substring) match to qualify.
 * Matches Postgres' own `pg_trgm.similarity_threshold` default, which the
 * `%` operator in the index-using prefilter relies on.
 */
export const SIMILARITY_FLOOR = 0.3;

export interface ScoredSuggestion extends Suggestion {
  score: number;
}

/**
 * Escapes LIKE/ILIKE metacharacters so user input matches literally.
 * Backslash must be escaped first, or it would double-escape the
 * backslashes this function itself inserts.
 */
export function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Scoring tiers are inlined in the SQL below rather than factored into a
 * helper: Kysely's `sql` tag binds parameters positionally, so a composed
 * fragment cannot reuse a named binding across call sites. The repetition is
 * deliberate — the tier constants are spaced by 1.0, which exceeds the
 * maximum possible similarity, so tiers can never interleave.
 */

interface CourseRow {
  course_uuid: string;
  course_designation: string;
  course_title: string | null;
  score: number;
}

/**
 * Returns scored course suggestions, best first.
 *
 * The inner query's WHERE clause exists to hit the GIN trigram indexes:
 * `ILIKE '%x%'` and the `%` similarity operator are both index-supported by
 * `gin_trgm_ops`. The outer query then applies the explicit floor, which
 * cannot live in the inner WHERE because it references the computed alias.
 */
export async function searchCourses(
  db: Kysely<Database>,
  q: string,
  limit: number
): Promise<ScoredSuggestion[]> {
  const escaped = escapeLikePattern(q);
  const prefixPattern = `${escaped}%`;
  const containsPattern = `%${escaped}%`;

  const result = await sql<CourseRow>`
    SELECT * FROM (
      SELECT
        c.course_uuid,
        c.course_designation,
        c.course_title,
        c.catalog_number,
        GREATEST(
          CASE
            WHEN c.course_designation ILIKE ${prefixPattern} THEN 2.0 + similarity(c.course_designation, ${q})
            WHEN c.course_designation ILIKE ${containsPattern} THEN 1.0 + similarity(c.course_designation, ${q})
            ELSE similarity(c.course_designation, ${q})
          END,
          CASE
            WHEN COALESCE(c.course_title, '') ILIKE ${prefixPattern} THEN 2.0 + similarity(COALESCE(c.course_title, ''), ${q})
            WHEN COALESCE(c.course_title, '') ILIKE ${containsPattern} THEN 1.0 + similarity(COALESCE(c.course_title, ''), ${q})
            ELSE similarity(COALESCE(c.course_title, ''), ${q})
          END,
          CASE
            WHEN COALESCE(c.full_course_designation, '') ILIKE ${prefixPattern} THEN 2.0 + similarity(COALESCE(c.full_course_designation, ''), ${q})
            WHEN COALESCE(c.full_course_designation, '') ILIKE ${containsPattern} THEN 1.0 + similarity(COALESCE(c.full_course_designation, ''), ${q})
            ELSE similarity(COALESCE(c.full_course_designation, ''), ${q})
          END
        ) AS score
      FROM courses c
      WHERE c.course_designation ILIKE ${containsPattern}
         OR COALESCE(c.course_title, '') ILIKE ${containsPattern}
         OR COALESCE(c.full_course_designation, '') ILIKE ${containsPattern}
         OR c.course_designation % ${q}
         OR COALESCE(c.course_title, '') % ${q}
         OR COALESCE(c.full_course_designation, '') % ${q}
    ) scored
    WHERE scored.score >= ${SIMILARITY_FLOOR}
    ORDER BY scored.score DESC, scored.catalog_number ASC NULLS LAST
    LIMIT ${limit}
  `.execute(db);

  return result.rows.map((row) => ({
    type: "course" as const,
    value: row.course_designation,
    label: row.course_designation,
    sublabel: row.course_title,
    course_uuid: row.course_uuid,
    score: Number(row.score),
  }));
}

interface InstructorRow {
  name: string;
  section_count: number;
  score: number;
}

/**
 * Returns scored instructor suggestions, best first, one row per distinct
 * instructor name. The score expression is computed on the GROUP BY key, so
 * it needs no aggregate wrapper.
 */
export async function searchInstructors(
  db: Kysely<Database>,
  q: string,
  limit: number
): Promise<ScoredSuggestion[]> {
  const escaped = escapeLikePattern(q);
  const prefixPattern = `${escaped}%`;
  const containsPattern = `%${escaped}%`;

  const result = await sql<InstructorRow>`
    SELECT * FROM (
      SELECT
        si.instructor_name AS name,
        COUNT(DISTINCT si.section_id)::int AS section_count,
        CASE
          WHEN si.instructor_name ILIKE ${prefixPattern} THEN 2.0 + similarity(si.instructor_name, ${q})
          WHEN si.instructor_name ILIKE ${containsPattern} THEN 1.0 + similarity(si.instructor_name, ${q})
          ELSE similarity(si.instructor_name, ${q})
        END AS score
      FROM section_instructors si
      WHERE si.instructor_name ILIKE ${containsPattern}
         OR si.instructor_name % ${q}
      GROUP BY si.instructor_name
    ) scored
    WHERE scored.score >= ${SIMILARITY_FLOOR}
    ORDER BY scored.score DESC, scored.section_count DESC, scored.name ASC
    LIMIT ${limit}
  `.execute(db);

  return result.rows.map((row) => ({
    type: "instructor" as const,
    value: row.name,
    label: row.name,
    sublabel: `Instructor · ${row.section_count} ${
      row.section_count === 1 ? "section" : "sections"
    }`,
    course_uuid: null,
    score: Number(row.score),
  }));
}

/**
 * Merges the two result sets by score, then guarantees an instructor slot:
 * a student searching a professor's name should never get a dropdown of
 * only course codes. Drops the internal score from the returned objects.
 */
export function mergeSuggestions(
  courses: ScoredSuggestion[],
  instructors: ScoredSuggestion[],
  limit: number
): Suggestion[] {
  const ranked = [...courses, ...instructors].sort((a, b) => b.score - a.score);
  const top = ranked.slice(0, limit);

  const hasInstructor = top.some((s) => s.type === "instructor");
  if (!hasInstructor && instructors.length > 0 && top.length === limit) {
    top[top.length - 1] = instructors[0];
  }

  return top.map(({ score, ...suggestion }) => suggestion);
}
```

Delete the unused `tieredScore` helper sketched above — the SQL inlines the tiers directly, because Kysely's `sql` tag cannot reference a bound parameter by name across a composed fragment. Do not leave dead code in the file.

- [ ] **Step 6: Run tests to verify they pass**

```bash
bun test pg-tests/suggest-builder.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 7: Commit**

```bash
git add pg/builders/suggest.ts pg/types.ts pg-tests/suggest-builder.test.ts pg-tests/fixtures/default.ts
git commit -m "feat(search): add tier-scored trigram suggestion query builder"
```

---

## Task 4: The suggest endpoint

**Files:**
- Create: `api-local/pg/routes/search.ts`
- Test: `api-local/pg-tests/search-route.test.ts`

**Interfaces:**
- Consumes: `searchCourses`, `searchInstructors`, `mergeSuggestions` from `../builders/suggest.ts`; `apiKeyAuth` from `../../middleware.ts`; `QueryCache` from `../cache.ts`.
- Produces: `createPgSearchApp(deps: { db: Kysely<Database>; cache: QueryCache; apiKey: string }): Hono`, serving `GET /api/search/suggest`.

Constants: `MIN_QUERY_LENGTH = 2`, `DEFAULT_LIMIT = 8`, `MAX_LIMIT = 10`.

- [ ] **Step 1: Write the failing test**

Create `api-local/pg-tests/search-route.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDb, type TestDb } from "./setup.ts";
import { fixture } from "./fixtures/default.ts";
import { createPgSearchApp } from "../pg/routes/search.ts";
import type { SuggestResponse } from "../pg/types.ts";

let testDb: TestDb;
let app: ReturnType<typeof createPgSearchApp>;

const API_KEY = "test-key";

beforeAll(async () => {
  testDb = await setupTestDb();
  await testDb.seed(fixture);

  const mockCache = {
    get: async () => null,
    set: async () => {},
    bustAll: async () => {},
  };

  app = createPgSearchApp({ db: testDb.db, cache: mockCache, apiKey: API_KEY });
});

afterAll(async () => {
  await testDb.teardown();
});

async function suggest(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const res = await app.request(`/api/search/suggest?${qs}`, {
    headers: { "x-api-key": API_KEY },
  });
  return { status: res.status, body: (await res.json()) as SuggestResponse };
}

describe("GET /api/search/suggest", () => {
  it("rejects a request with no api key", async () => {
    const res = await app.request("/api/search/suggest?q=comp");
    expect(res.status).toBe(401);
  });

  it("returns an empty list for a query under 2 characters", async () => {
    const { status, body } = await suggest({ q: "c" });
    expect(status).toBe(200);
    expect(body.suggestions).toEqual([]);
  });

  it("returns an empty list for a missing q", async () => {
    const { status, body } = await suggest({});
    expect(status).toBe(200);
    expect(body.suggestions).toEqual([]);
  });

  it("returns an empty list for whitespace-only q", async () => {
    const { status, body } = await suggest({ q: "   " });
    expect(status).toBe(200);
    expect(body.suggestions).toEqual([]);
  });

  it("finds a course by exact designation", async () => {
    const { body } = await suggest({ q: "COMP SCI 200" });
    expect(body.suggestions[0]).toMatchObject({
      type: "course",
      value: "COMP SCI 200",
      sublabel: "Programming I",
    });
  });

  it("tolerates a typo in a course designation", async () => {
    const { body } = await suggest({ q: "COMP SIC 200" });
    expect(body.suggestions.map((s) => s.value)).toContain("COMP SCI 200");
  });

  it("tolerates a typo in an instructor name", async () => {
    const { body } = await suggest({ q: "Willliams" });
    expect(body.suggestions.map((s) => s.value)).toContain("Jim Williams");
  });

  it("defaults to 8 suggestions", async () => {
    const { body } = await suggest({ q: "COMP SCI" });
    expect(body.suggestions.length).toBeLessThanOrEqual(8);
  });

  it("clamps an oversized limit to 10", async () => {
    const { body } = await suggest({ q: "COMP SCI", limit: "999" });
    expect(body.suggestions.length).toBeLessThanOrEqual(10);
  });

  it("falls back to the default for a non-numeric limit", async () => {
    const { body } = await suggest({ q: "COMP SCI", limit: "abc" });
    expect(body.suggestions.length).toBeLessThanOrEqual(8);
  });

  it("clamps a zero or negative limit to 1", async () => {
    const { body } = await suggest({ q: "COMP SCI", limit: "0" });
    expect(body.suggestions.length).toBe(1);
  });

  it("trims surrounding whitespace before searching", async () => {
    const { body } = await suggest({ q: "  COMP SCI 200  " });
    expect(body.suggestions[0].value).toBe("COMP SCI 200");
  });

  it("includes an instructor when one matches strongly", async () => {
    const { body } = await suggest({ q: "Jim Williams" });
    expect(body.suggestions.some((s) => s.type === "instructor")).toBe(true);
  });

  it("returns an empty list rather than erroring on no match", async () => {
    const { status, body } = await suggest({ q: "zzzzzzzzzz" });
    expect(status).toBe(200);
    expect(body.suggestions).toEqual([]);
  });

  it("serves a cached response when the cache hits", async () => {
    const cached: SuggestResponse = {
      suggestions: [
        { type: "course", value: "CACHED", label: "CACHED", sublabel: null, course_uuid: null },
      ],
    };
    const hitApp = createPgSearchApp({
      db: testDb.db,
      cache: { get: async () => cached, set: async () => {}, bustAll: async () => {} },
      apiKey: API_KEY,
    });
    const res = await hitApp.request("/api/search/suggest?q=COMP SCI 200", {
      headers: { "x-api-key": API_KEY },
    });
    const body = (await res.json()) as SuggestResponse;
    expect(body.suggestions[0].value).toBe("CACHED");
  });

  it("returns 500 with a JSON body when the database fails", async () => {
    const brokenApp = createPgSearchApp({
      db: { } as any,
      cache: { get: async () => null, set: async () => {}, bustAll: async () => {} },
      apiKey: API_KEY,
    });
    const res = await brokenApp.request("/api/search/suggest?q=comp", {
      headers: { "x-api-key": API_KEY },
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toHaveProperty("error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test pg-tests/search-route.test.ts
```

Expected: FAIL — `Cannot find module '../pg/routes/search.ts'`.

- [ ] **Step 3: Implement the route**

Create `api-local/pg/routes/search.ts`:

```ts
import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { Database, SuggestResponse } from "../types.ts";
import type { QueryCache } from "../cache.ts";
import { apiKeyAuth } from "../../middleware.ts";
import {
  searchCourses,
  searchInstructors,
  mergeSuggestions,
} from "../builders/suggest.ts";

interface PgSearchAppDeps {
  db: Kysely<Database>;
  cache: QueryCache;
  apiKey: string;
}

/** Below this length a query matches too much to be useful. */
const MIN_QUERY_LENGTH = 2;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 10;

const EMPTY: SuggestResponse = { suggestions: [] };

function parseLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_LIMIT);
}

/**
 * Autocomplete suggestions for the search box. Separate from `createPgApp`
 * (the /api/query pipeline) because it has its own cache namespace, its own
 * response shape, and no filter/pagination concerns.
 *
 * Over-short and unmatched queries both return 200 with an empty list — the
 * dropdown treats "nothing to suggest" as a normal state, not an error.
 */
export function createPgSearchApp({ db, cache, apiKey }: PgSearchAppDeps) {
  const app = new Hono();

  app.use("/api/*", apiKeyAuth(apiKey));

  app.get("/api/search/suggest", async (c) => {
    try {
      const q = (c.req.query("q") ?? "").trim();
      const limit = parseLimit(c.req.query("limit"));

      if (q.length < MIN_QUERY_LENGTH) return c.json(EMPTY);

      const cacheParams = { q, limit: String(limit) };
      const cached = await cache.get<SuggestResponse>(cacheParams);
      if (cached) return c.json(cached);

      // Each side is asked for a full page; merge decides the final mix.
      const [courses, instructors] = await Promise.all([
        searchCourses(db, q, limit),
        searchInstructors(db, q, limit),
      ]);

      const response: SuggestResponse = {
        suggestions: mergeSuggestions(courses, instructors, limit),
      };

      await cache.set(cacheParams, response);
      return c.json(response);
    } catch (error) {
      console.error("Error in pg /api/search/suggest:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  return app;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test pg-tests/search-route.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 5: Run the whole backend suite**

```bash
bun test
```

Expected: PASS — including the legacy `api.test.js` / `api.e2e.test.js` suites, which must be untouched.

- [ ] **Step 6: Commit**

```bash
git add pg/routes/search.ts pg-tests/search-route.test.ts
git commit -m "feat(search): add GET /api/search/suggest endpoint"
```

---

## Task 5: Mount the search app on the server

**Files:**
- Modify: `api-local/server.ts` (imports at lines 8–11; mounting at lines 58–63)

**Interfaces:**
- Consumes: `createPgSearchApp` from Task 4; `createCache` options from Task 2.
- Produces: `GET /v2/api/search/suggest` on the running server.

This task has no unit test — it is composition wiring, verified by a live smoke check against a real server, which is the only thing that would actually catch a bad mount path.

- [ ] **Step 1: Add the import**

In `api-local/server.ts`, after line 9 (`import { createPgSubscriptionApp } ...`):

```ts
import { createPgSearchApp } from "./pg/routes/search.ts";
```

- [ ] **Step 2: Create the suggest cache and mount the app**

Replace lines 58–63 with:

```ts
const pgDb = createDb(Bun.env.DATABASE_URL!);
const queryCache = createCache(redis);
// Suggestions get their own namespace and a much shorter TTL: the text
// tracks the catalog, and 5 minutes bounds staleness after an ETL run.
const suggestCache = createCache(redis, { prefix: "pg:suggest:", ttl: 300 });

app.route(
  "/v2",
  createPgApp({ db: pgDb, cache: queryCache, apiKey: Bun.env.GET_API_KEY! })
);

app.route(
  "/v2",
  createPgSearchApp({ db: pgDb, cache: suggestCache, apiKey: Bun.env.GET_API_KEY! })
);
```

- [ ] **Step 3: Smoke test against a running server**

In one terminal, with the API's normal env vars set:

```bash
cd api-local && bun run start
```

In another:

```bash
curl -s -H "x-api-key: $GET_API_KEY" \
  'http://localhost:3000/v2/api/search/suggest?q=COMP%20SIC%20200' | jq
```

Expected: JSON with a `suggestions` array containing `COMP SCI 200`. Then confirm the existing endpoint is unaffected:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "x-api-key: $GET_API_KEY" \
  'http://localhost:3000/v2/api/query?limit=1'
```

Expected: `200`.

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "feat(search): mount suggest endpoint at /v2 with its own cache namespace"
```

---

## Task 6: Document the endpoint

**Files:**
- Modify: `api-local/docs/query-api-reference.md`

- [ ] **Step 1: Append the endpoint section**

Add to the end of `api-local/docs/query-api-reference.md`:

````markdown
---

# GET /api/search/suggest — Autocomplete

Returns ranked search suggestions for the search box. Served from the v2
(Postgres) API at `/v2/api/search/suggest`. Requires the same `x-api-key`
header as `/api/query`.

## Parameters

| Param | Required | Default | Notes |
|---|---|---|---|
| `q` | yes | — | Trimmed. Under 2 characters returns an empty list with HTTP 200. |
| `limit` | no | `8` | Clamped to `[1, 10]`. Non-numeric falls back to `8`. |

## Response

```json
{
  "suggestions": [
    {
      "type": "course",
      "value": "COMP SCI 200",
      "label": "COMP SCI 200",
      "sublabel": "Programming I",
      "course_uuid": "uuid-cs200"
    },
    {
      "type": "instructor",
      "value": "Jim Williams",
      "label": "Jim Williams",
      "sublabel": "Instructor · 3 sections",
      "course_uuid": null
    }
  ]
}
```

`value` is what the client writes into `search_param`. `course_uuid` is null
for instructor suggestions.

## Matching and ranking

Matches on `course_designation`, `course_title`, `full_course_designation`,
and `section_instructors.instructor_name` using `pg_trgm` trigram similarity
with GIN indexes.

Each field scores in one of three tiers, and a row takes its best field score:

| Tier | Condition | Score |
|---|---|---|
| Prefix | field starts with `q` | `2.0 + similarity` |
| Substring | field contains `q` | `1.0 + similarity` |
| Fuzzy | `similarity >= 0.3` | `similarity` |

Rows below `0.3` similarity with no substring match are excluded. The 1.0
tier spacing exceeds the maximum possible similarity, so a prefix match can
never be outranked by a fuzzy one.

Courses and instructors are queried separately and merged by score. If the
merged top-`limit` contains no instructor but one qualified, the
lowest-scoring course is swapped for the best instructor.

Instructors are deduplicated by name; `sublabel` reports how many sections
they teach.

## Caching

Redis, namespace `pg:suggest:`, 300s TTL. Cache failures degrade to a miss.

## Notes

- **Empty results are not errors.** Over-short, unmatched, and whitespace-only
  queries all return `200` with `{"suggestions": []}`.
- **`search_param` on `/api/query` is unchanged** — it remains substring-only
  `ILIKE`. This endpoint does not affect it.
````

Also update the existing `search_param` section (currently near line 139) to cross-reference the new endpoint. Replace its body with:

```markdown
Free-text search across `course_designation`, `course_title`,
`full_course_designation`, and `instructor_name`. Uses `ILIKE %value%`
matching — substring only, no fuzzy matching.

For typo-tolerant matching, see `GET /api/search/suggest` below. That
endpoint powers the autocomplete dropdown; `search_param` still performs the
literal filtered query.
```

- [ ] **Step 2: Commit**

```bash
git add docs/query-api-reference.md
git commit -m "docs: document the search suggest endpoint"
```

---

## Task 7: Frontend component-test infrastructure

**Files:**
- Modify: `BadgerBaseFrontend/package.json`
- Modify: `BadgerBaseFrontend/vitest.config.ts`
- Create: `BadgerBaseFrontend/__tests__/setup.ts`
- Test: `BadgerBaseFrontend/__tests__/infra-smoke.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: the ability to render React components in tests. Later tasks rely on `@testing-library/react`'s `render`, `screen`, `waitFor`, and `@testing-library/user-event`.

`vitest.config.ts` currently only includes `__tests__/**/*.test.ts` and runs in the default node environment; the three existing tests are file-reading checks. Component tests need `.tsx` matching and a DOM.

**Environment strategy:** keep the global environment as node and opt individual component test files into jsdom with a `// @vitest-environment jsdom` docblock. Flipping the global default risks changing behavior for the existing build and token tests for no benefit.

- [ ] **Step 1: Install the test dependencies**

```bash
cd BadgerBaseFrontend
npm install --save-dev jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom
```

- [ ] **Step 2: Write the failing test**

Create `BadgerBaseFrontend/__tests__/infra-smoke.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"

function Hello({ name }: { name: string }) {
  return <p>Hello {name}</p>
}

describe("component test infrastructure", () => {
  it("renders a React component into a DOM", () => {
    render(<Hello name="Badger" />)
    expect(screen.getByText("Hello Badger")).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npm test -- infra-smoke
```

Expected: FAIL — no test files matched, because `vitest.config.ts` only includes `*.test.ts`.

- [ ] **Step 4: Create the setup file**

Create `BadgerBaseFrontend/__tests__/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest"
```

- [ ] **Step 5: Update the vitest config**

Replace `BadgerBaseFrontend/vitest.config.ts` with:

```ts
import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import path from "path"

export default defineConfig({
  plugins: [react()],
  test: {
    // Component tests opt into jsdom per-file with a
    // `// @vitest-environment jsdom` docblock. The default stays node so the
    // existing file-reading tests (build, tokens, colors) are unaffected.
    include: ["__tests__/**/*.test.{ts,tsx}"],
    setupFiles: ["./__tests__/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
})
```

Install the React plugin that config now requires:

```bash
npm install --save-dev @vitejs/plugin-react
```

- [ ] **Step 6: Run test to verify it passes**

```bash
npm test -- infra-smoke
```

Expected: PASS, 1 test.

- [ ] **Step 7: Verify the existing tests still pass**

```bash
npm test
```

Expected: PASS — `build.test.ts`, `tokens.test.ts`, `no-hardcoded-colors.test.ts` all still green.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json vitest.config.ts __tests__/setup.ts __tests__/infra-smoke.test.tsx
git commit -m "test: add React component testing infrastructure"
```

---

## Task 8: Extract the shared CORS allowlist

**Files:**
- Create: `BadgerBaseFrontend/lib/allowed-origins.ts`
- Modify: `BadgerBaseFrontend/app/api/proxy/route.ts` (lines 3–10, 15–21)
- Test: `BadgerBaseFrontend/__tests__/allowed-origins.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ALLOWED_ORIGINS: readonly string[]` and `isAllowedOrigin(origin: string | null): boolean`.

The allowlist is currently a literal inside the proxy route. Task 9 adds a second route needing the same list; duplicating it means a new domain must be remembered in two files.

- [ ] **Step 1: Write the failing test**

Create `BadgerBaseFrontend/__tests__/allowed-origins.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { ALLOWED_ORIGINS, isAllowedOrigin } from "@/lib/allowed-origins"

describe("isAllowedOrigin", () => {
  it("accepts the production domains", () => {
    expect(isAllowedOrigin("https://badgerbase.app")).toBe(true)
    expect(isAllowedOrigin("https://www.sconniegrades.com")).toBe(true)
  })

  it("accepts a referer URL with a path", () => {
    expect(isAllowedOrigin("https://badgerbase.app/search?q=comp")).toBe(true)
  })

  it("accepts localhost dev origins", () => {
    expect(isAllowedOrigin("http://localhost:3000")).toBe(true)
  })

  it("rejects an unknown origin", () => {
    expect(isAllowedOrigin("https://evil.example.com")).toBe(false)
  })

  it("rejects a null origin", () => {
    expect(isAllowedOrigin(null)).toBe(false)
  })

  it("exposes the full list", () => {
    expect(ALLOWED_ORIGINS).toContain("https://badgerbase.app")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- allowed-origins
```

Expected: FAIL — cannot resolve `@/lib/allowed-origins`.

- [ ] **Step 3: Implement**

Create `BadgerBaseFrontend/lib/allowed-origins.ts`:

```ts
/**
 * Origins permitted to call the server-side API proxy routes. Shared by
 * every route under `app/api/` so a new domain is added in exactly one
 * place.
 */
export const ALLOWED_ORIGINS = [
  "https://sconniegrades.com",
  "https://www.sconniegrades.com",
  "https://badgerbase.app",
  "https://www.badgerbase.app",
  "http://localhost:3000",
  "http://localhost:3001",
] as const

/**
 * Matches on prefix because the value may be a `referer` (a full URL with a
 * path) rather than a bare `origin`.
 */
export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false
  return ALLOWED_ORIGINS.some((allowed) => origin.startsWith(allowed))
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- allowed-origins
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Use it in the existing proxy**

In `BadgerBaseFrontend/app/api/proxy/route.ts`, delete the `ALLOWED_ORIGINS` array (lines 3–10) and add to the imports:

```ts
import { isAllowedOrigin } from '@/lib/allowed-origins'
```

Replace the check (lines 17–21) with:

```ts
  if (!isAllowedOrigin(origin)) {
    return new Response("Forbidden: Invalid origin", { status: 403 })
  }
```

Delete the now-unused `isAllowed` local variable.

- [ ] **Step 6: Verify the app still builds**

```bash
npm test
npm run build
```

Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/allowed-origins.ts app/api/proxy/route.ts __tests__/allowed-origins.test.ts
git commit -m "refactor: extract shared CORS allowlist for API proxy routes"
```

---

## Task 9: The suggest proxy route

**Files:**
- Create: `BadgerBaseFrontend/app/api/search-suggest/route.ts`
- Test: `BadgerBaseFrontend/__tests__/search-suggest-route.test.ts`

**Interfaces:**
- Consumes: `isAllowedOrigin` (Task 8); `fetchWithRetry` from `@/lib/fetch-with-retry`.
- Produces: `GET(request: Request): Promise<Response>` at `/api/search-suggest`, forwarding `q` and `limit`.

Mirrors `app/api/proxy/route.ts` — the API key stays server-side and is never exposed to the browser.

- [ ] **Step 1: Write the failing test**

Create `BadgerBaseFrontend/__tests__/search-suggest-route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const fetchWithRetry = vi.fn()
vi.mock("@/lib/fetch-with-retry", () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetry(...args),
}))

const { GET } = await import("@/app/api/search-suggest/route")

function req(url: string, origin: string | null = "https://badgerbase.app") {
  return new Request(url, {
    headers: origin ? { origin } : {},
  })
}

beforeEach(() => {
  fetchWithRetry.mockReset()
  process.env.API_BASE_URL = "https://api.example.com"
  process.env.API_KEY = "secret-key"
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("GET /api/search-suggest", () => {
  it("rejects a disallowed origin", async () => {
    const res = await GET(req("http://x/api/search-suggest?q=comp", "https://evil.com"))
    expect(res.status).toBe(403)
    expect(fetchWithRetry).not.toHaveBeenCalled()
  })

  it("forwards q and limit to the v2 suggest endpoint", async () => {
    fetchWithRetry.mockResolvedValue(
      new Response(JSON.stringify({ suggestions: [] }), { status: 200 })
    )
    await GET(req("http://x/api/search-suggest?q=comp%20sci&limit=5"))

    const [url, init] = fetchWithRetry.mock.calls[0]
    expect(url).toContain("https://api.example.com/v2/api/search/suggest?")
    expect(url).toContain("q=comp+sci")
    expect(url).toContain("limit=5")
    expect((init as RequestInit).headers).toMatchObject({ "x-api-key": "secret-key" })
  })

  it("never forwards unexpected params", async () => {
    fetchWithRetry.mockResolvedValue(
      new Response(JSON.stringify({ suggestions: [] }), { status: 200 })
    )
    await GET(req("http://x/api/search-suggest?q=comp&evil=1"))
    expect(fetchWithRetry.mock.calls[0][0]).not.toContain("evil")
  })

  it("returns the upstream suggestions on success", async () => {
    fetchWithRetry.mockResolvedValue(
      new Response(
        JSON.stringify({
          suggestions: [
            { type: "course", value: "COMP SCI 200", label: "COMP SCI 200", sublabel: "Programming I", course_uuid: "u" },
          ],
        }),
        { status: 200 }
      )
    )
    const res = await GET(req("http://x/api/search-suggest?q=comp"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      suggestions: [{ value: "COMP SCI 200" }],
    })
  })

  it("propagates an upstream error status", async () => {
    fetchWithRetry.mockResolvedValue(new Response("nope", { status: 503 }))
    const res = await GET(req("http://x/api/search-suggest?q=comp"))
    expect(res.status).toBe(503)
  })

  it("returns 502 when the upstream fetch throws", async () => {
    fetchWithRetry.mockRejectedValue(new Error("ECONNREFUSED"))
    const res = await GET(req("http://x/api/search-suggest?q=comp"))
    expect(res.status).toBe(502)
    expect(await res.json()).toHaveProperty("error")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- search-suggest-route
```

Expected: FAIL — cannot resolve `@/app/api/search-suggest/route`.

- [ ] **Step 3: Implement**

Create `BadgerBaseFrontend/app/api/search-suggest/route.ts`:

```ts
import { fetchWithRetry } from '@/lib/fetch-with-retry'
import { isAllowedOrigin } from '@/lib/allowed-origins'

/**
 * Server-side proxy for the v2 autocomplete endpoint. Exists so the API key
 * never reaches the browser. Only `q` and `limit` are forwarded — the
 * upstream is not a general-purpose passthrough.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)

  const origin = request.headers.get("origin") || request.headers.get("referer")
  if (!isAllowedOrigin(origin)) {
    return new Response("Forbidden: Invalid origin", { status: 403 })
  }

  const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3002"
  const API_KEY = process.env.API_KEY || ""

  const forwarded = new URLSearchParams()
  forwarded.set("q", searchParams.get("q") ?? "")
  const limit = searchParams.get("limit")
  if (limit) forwarded.set("limit", limit)

  try {
    const response = await fetchWithRetry(
      `${API_BASE_URL}/v2/api/search/suggest?${forwarded.toString()}`,
      {
        headers: {
          "x-api-key": API_KEY,
          "Content-Type": "application/json",
        },
      }
    )

    if (!response.ok) {
      return Response.json(
        { error: `API responded with status: ${response.status}` },
        { status: response.status }
      )
    }

    return Response.json(await response.json())
  } catch (error: any) {
    console.error("Suggest proxy error:", error.message || error)
    return Response.json(
      { error: error.message || "Failed to fetch suggestions" },
      { status: 502 }
    )
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- search-suggest-route
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add app/api/search-suggest/route.ts __tests__/search-suggest-route.test.ts
git commit -m "feat(search): add server-side proxy for suggest endpoint"
```

---

## Task 10: The debounce hook

**Files:**
- Create: `BadgerBaseFrontend/hooks/use-debounced-value.ts`
- Test: `BadgerBaseFrontend/__tests__/use-debounced-value.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `useDebouncedValue<T>(value: T, delayMs: number): T`.

Deliberately generic and fetch-unaware, so the timing policy is testable without a network.

- [ ] **Step 1: Write the failing test**

Create `BadgerBaseFrontend/__tests__/use-debounced-value.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useDebouncedValue } from "@/hooks/use-debounced-value"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("useDebouncedValue", () => {
  it("returns the initial value immediately", () => {
    const { result } = renderHook(() => useDebouncedValue("a", 200))
    expect(result.current).toBe("a")
  })

  it("does not update before the delay elapses", () => {
    const { result, rerender } = renderHook(
      ({ v }) => useDebouncedValue(v, 200),
      { initialProps: { v: "a" } }
    )
    rerender({ v: "b" })
    act(() => { vi.advanceTimersByTime(199) })
    expect(result.current).toBe("a")
  })

  it("updates once the delay elapses", () => {
    const { result, rerender } = renderHook(
      ({ v }) => useDebouncedValue(v, 200),
      { initialProps: { v: "a" } }
    )
    rerender({ v: "b" })
    act(() => { vi.advanceTimersByTime(200) })
    expect(result.current).toBe("b")
  })

  it("only emits the final value during rapid changes", () => {
    const { result, rerender } = renderHook(
      ({ v }) => useDebouncedValue(v, 200),
      { initialProps: { v: "c" } }
    )
    for (const v of ["co", "com", "comp"]) {
      rerender({ v })
      act(() => { vi.advanceTimersByTime(50) })
    }
    expect(result.current).toBe("c")
    act(() => { vi.advanceTimersByTime(200) })
    expect(result.current).toBe("comp")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- use-debounced-value
```

Expected: FAIL — cannot resolve `@/hooks/use-debounced-value`.

- [ ] **Step 3: Implement**

Create `BadgerBaseFrontend/hooks/use-debounced-value.ts`:

```ts
"use client"

import { useEffect, useState } from "react"

/**
 * Returns `value` delayed until it has stopped changing for `delayMs`.
 *
 * Debounce, not throttle: a throttle emits on a fixed cadence while the user
 * is still typing, firing requests for prefixes they have already typed past.
 * Waiting for a pause is what "the user has typed enough to mean something"
 * actually looks like.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- use-debounced-value
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add hooks/use-debounced-value.ts __tests__/use-debounced-value.test.tsx
git commit -m "feat(search): add useDebouncedValue hook"
```

---

## Task 11: The suggestions fetch hook

**Files:**
- Create: `BadgerBaseFrontend/hooks/use-search-suggestions.ts`
- Test: `BadgerBaseFrontend/__tests__/use-search-suggestions.test.tsx`

**Interfaces:**
- Consumes: `useDebouncedValue` (Task 10).
- Produces:
  - `type SuggestionType = "course" | "instructor"`
  - `interface Suggestion { type: SuggestionType; value: string; label: string; sublabel: string | null; course_uuid: string | null }`
  - `useSearchSuggestions(query: string): { suggestions: Suggestion[]; loading: boolean; error: boolean }`
  - Exported constants `MIN_QUERY_LENGTH = 2`, `DEBOUNCE_MS = 200`.

Owns the abort behavior. Without `AbortController`, a slow response for `"comp"` can land after a fast one for `"comp sci"` and repaint stale suggestions under a newer query.

- [ ] **Step 1: Write the failing test**

Create `BadgerBaseFrontend/__tests__/use-search-suggestions.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useSearchSuggestions } from "@/hooks/use-search-suggestions"

const COURSE = {
  type: "course" as const,
  value: "COMP SCI 200",
  label: "COMP SCI 200",
  sublabel: "Programming I",
  course_uuid: "u",
}

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("useSearchSuggestions", () => {
  it("issues no request for a query under 2 characters", async () => {
    renderHook(() => useSearchSuggestions("c"))
    await new Promise((r) => setTimeout(r, 300))
    expect(fetch).not.toHaveBeenCalled()
  })

  it("issues no request for a whitespace-only query", async () => {
    renderHook(() => useSearchSuggestions("   "))
    await new Promise((r) => setTimeout(r, 300))
    expect(fetch).not.toHaveBeenCalled()
  })

  it("fetches and exposes suggestions", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ suggestions: [COURSE] }))
    const { result } = renderHook(() => useSearchSuggestions("comp"))

    await waitFor(() => expect(result.current.suggestions).toHaveLength(1))
    expect(result.current.suggestions[0].value).toBe("COMP SCI 200")
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBe(false)
  })

  it("URL-encodes the query", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ suggestions: [] }))
    renderHook(() => useSearchSuggestions("comp sci & math"))

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    const url = vi.mocked(fetch).mock.calls[0][0] as string
    expect(url).toContain("/api/search-suggest?")
    expect(url).not.toContain(" ")
    expect(url).toContain("%26")
  })

  it("aborts the in-flight request when the query changes", async () => {
    const signals: AbortSignal[] = []
    vi.mocked(fetch).mockImplementation((_url, init) => {
      signals.push((init as RequestInit).signal as AbortSignal)
      return new Promise(() => {}) // never settles
    })

    const { rerender } = renderHook(({ q }) => useSearchSuggestions(q), {
      initialProps: { q: "comp" },
    })
    await waitFor(() => expect(signals.length).toBe(1))

    rerender({ q: "comp sci" })
    await waitFor(() => expect(signals.length).toBe(2))

    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
  })

  it("sets error and empties suggestions when the request fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"))
    const { result } = renderHook(() => useSearchSuggestions("comp"))

    await waitFor(() => expect(result.current.error).toBe(true))
    expect(result.current.suggestions).toEqual([])
    expect(result.current.loading).toBe(false)
  })

  it("sets error on a non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 502 } as Response)
    const { result } = renderHook(() => useSearchSuggestions("comp"))
    await waitFor(() => expect(result.current.error).toBe(true))
  })

  it("clears suggestions when the query drops below the minimum", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ suggestions: [COURSE] }))
    const { result, rerender } = renderHook(({ q }) => useSearchSuggestions(q), {
      initialProps: { q: "comp" },
    })
    await waitFor(() => expect(result.current.suggestions).toHaveLength(1))

    rerender({ q: "c" })
    await waitFor(() => expect(result.current.suggestions).toEqual([]))
  })

  it("does not report an abort as an error", async () => {
    vi.mocked(fetch).mockImplementation((_url, init) => {
      const signal = (init as RequestInit).signal as AbortSignal
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const err = new Error("aborted")
          err.name = "AbortError"
          reject(err)
        })
      })
    })

    const { result, rerender } = renderHook(({ q }) => useSearchSuggestions(q), {
      initialProps: { q: "comp" },
    })
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    rerender({ q: "comp sci" })
    await new Promise((r) => setTimeout(r, 300))

    expect(result.current.error).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- use-search-suggestions
```

Expected: FAIL — cannot resolve `@/hooks/use-search-suggestions`.

- [ ] **Step 3: Implement**

Create `BadgerBaseFrontend/hooks/use-search-suggestions.ts`:

```ts
"use client"

import { useEffect, useRef, useState } from "react"
import { useDebouncedValue } from "./use-debounced-value"

export type SuggestionType = "course" | "instructor"

export interface Suggestion {
  type: SuggestionType
  /** Written into `search_param` when selected. */
  value: string
  label: string
  sublabel: string | null
  course_uuid: string | null
}

/** Mirrors MIN_QUERY_LENGTH on the API — below this, nothing is requested. */
export const MIN_QUERY_LENGTH = 2
export const DEBOUNCE_MS = 200

interface SuggestionsState {
  suggestions: Suggestion[]
  loading: boolean
  error: boolean
}

/**
 * Debounced, race-safe course/instructor suggestions.
 *
 * Each request carries an AbortSignal that is fired when the query changes or
 * the component unmounts. Without it, a slow response for an earlier prefix
 * can resolve after a newer one and repaint stale suggestions.
 *
 * Errors are surfaced as a flag rather than thrown: the dropdown is a
 * progressive enhancement and must never break the plain search input.
 */
export function useSearchSuggestions(query: string): SuggestionsState {
  const debouncedQuery = useDebouncedValue(query, DEBOUNCE_MS)
  const [state, setState] = useState<SuggestionsState>({
    suggestions: [],
    loading: false,
    error: false,
  })
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const trimmed = debouncedQuery.trim()

    controllerRef.current?.abort()

    if (trimmed.length < MIN_QUERY_LENGTH) {
      controllerRef.current = null
      setState({ suggestions: [], loading: false, error: false })
      return
    }

    const controller = new AbortController()
    controllerRef.current = controller

    setState((prev) => ({ ...prev, loading: true, error: false }))

    fetch(`/api/search-suggest?q=${encodeURIComponent(trimmed)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`status ${response.status}`)
        const body = (await response.json()) as { suggestions?: Suggestion[] }
        if (controller.signal.aborted) return
        setState({
          suggestions: body.suggestions ?? [],
          loading: false,
          error: false,
        })
      })
      .catch((err: unknown) => {
        // An abort is an expected supersession, not a failure.
        if (err instanceof Error && err.name === "AbortError") return
        if (controller.signal.aborted) return
        setState({ suggestions: [], loading: false, error: true })
      })

    return () => controller.abort()
  }, [debouncedQuery])

  return state
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- use-search-suggestions
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add hooks/use-search-suggestions.ts __tests__/use-search-suggestions.test.tsx
git commit -m "feat(search): add debounced, race-safe suggestions hook"
```

---

## Task 12: Design artifact for the dropdown

**Files:** none in the repo — this produces a Claude Artifact for review.

This is a design-approval gate. The visual gets signed off before it is implemented, not after. Do not start Task 13 until the user has approved the mockup.

- [ ] **Step 1: Read the token definitions**

Read `BadgerBaseFrontend/app/globals.css` and `BadgerBaseFrontend/docs/superpowers/specs/2026-08-13-design-tokens-design.md` so the mockup uses real token values, and `components/search-filters.tsx:81` for the `fieldLabel` treatment (mono, 11px, uppercase, `0.12em` tracking).

- [ ] **Step 2: Build and publish the artifact**

Load the `artifact-design` skill, then build a single page showing the dropdown in every state, at the real width it occupies in the sidebar:

1. **Idle** — input with placeholder, no dropdown
2. **Loading** — input with text, dropdown showing a loading state
3. **Results** — mixed course and instructor rows, with matched substrings highlighted
4. **Fuzzy results** — query `COMP SIC 200` showing the typo-tolerant match, to make the feature's value legible
5. **Empty** — `No matches` with the full-search affordance still available
6. **Keyboard-active** — a row in the active/highlighted state

Render each state in both light and dark themes. Use the real Cardinal Red and neutral scales, `--radius-lg`, `--shadow-lg`.

- [ ] **Step 3: Get approval**

Share the artifact URL and ask for sign-off, listing what is open to change (row density, whether instructor rows get an icon, highlight treatment). Wait for a response before continuing.

---

## Task 13: The autocomplete combobox

**Files:**
- Create: `BadgerBaseFrontend/components/ui/popover.tsx`
- Create: `BadgerBaseFrontend/components/search-autocomplete.tsx`
- Test: `BadgerBaseFrontend/__tests__/search-autocomplete.test.tsx`

**Interfaces:**
- Consumes: `useSearchSuggestions`, `Suggestion` (Task 11); `Input` from `@/components/ui/input`; `cn` from `@/lib/utils`.
- Produces: `SearchAutocomplete(props: { value: string; onValueChange: (value: string) => void; onSearch: () => void; id?: string; placeholder?: string }): JSX.Element`.

`@radix-ui/react-popover` is **already a dependency** — only the shadcn wrapper file is missing. Do not run `npx shadcn add`.

The listbox is hand-rolled rather than using `cmdk`: `cmdk` filters client-side over a static list, while these suggestions are server-ranked and must render in the order the API returns them.

- [ ] **Step 1: Write the failing test**

Create `BadgerBaseFrontend/__tests__/search-autocomplete.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { SearchAutocomplete } from "@/components/search-autocomplete"

const SUGGESTIONS = [
  { type: "course" as const, value: "COMP SCI 200", label: "COMP SCI 200", sublabel: "Programming I", course_uuid: "u1" },
  { type: "course" as const, value: "COMP SCI 400", label: "COMP SCI 400", sublabel: "Programming III", course_uuid: "u2" },
  { type: "instructor" as const, value: "Jim Williams", label: "Jim Williams", sublabel: "Instructor · 3 sections", course_uuid: null },
]

function mockSuggest(suggestions = SUGGESTIONS) {
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => ({ suggestions }),
  } as unknown as Response)
}

/** Wrapper that owns state, the way search-filters.tsx does. */
function Harness({ onSearch = () => {} }: { onSearch?: () => void }) {
  const [value, setValue] = useState("")
  return (
    <SearchAutocomplete
      value={value}
      onValueChange={setValue}
      onSearch={onSearch}
      placeholder="COMP SCI 400, John Doe, etc."
    />
  )
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("SearchAutocomplete", () => {
  it("renders a combobox input", () => {
    render(<Harness />)
    expect(screen.getByRole("combobox")).toBeInTheDocument()
  })

  it("shows no dropdown before typing", () => {
    render(<Harness />)
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
  })

  it("shows suggestions after typing", async () => {
    mockSuggest()
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(screen.getByRole("combobox"), "comp")
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument())
    expect(screen.getByText("COMP SCI 200")).toBeInTheDocument()
    expect(screen.getByText("Jim Williams")).toBeInTheDocument()
  })

  it("selecting a suggestion sets the value and runs the search", async () => {
    mockSuggest()
    const onSearch = vi.fn()
    const user = userEvent.setup()
    render(<Harness onSearch={onSearch} />)

    const input = screen.getByRole("combobox")
    await user.type(input, "comp")
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument())
    await user.click(screen.getByText("COMP SCI 400"))

    expect((input as HTMLInputElement).value).toBe("COMP SCI 400")
    expect(onSearch).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument())
  })

  it("arrow down then Enter selects the first suggestion", async () => {
    mockSuggest()
    const onSearch = vi.fn()
    const user = userEvent.setup()
    render(<Harness onSearch={onSearch} />)

    const input = screen.getByRole("combobox")
    await user.type(input, "comp")
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument())

    await user.keyboard("{ArrowDown}{Enter}")
    expect((input as HTMLInputElement).value).toBe("COMP SCI 200")
    expect(onSearch).toHaveBeenCalledTimes(1)
  })

  it("arrow down twice selects the second suggestion", async () => {
    mockSuggest()
    const user = userEvent.setup()
    render(<Harness />)

    const input = screen.getByRole("combobox")
    await user.type(input, "comp")
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument())

    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}")
    expect((input as HTMLInputElement).value).toBe("COMP SCI 400")
  })

  it("arrow up from nothing wraps to the last suggestion", async () => {
    mockSuggest()
    const user = userEvent.setup()
    render(<Harness />)

    const input = screen.getByRole("combobox")
    await user.type(input, "comp")
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument())

    await user.keyboard("{ArrowUp}{Enter}")
    expect((input as HTMLInputElement).value).toBe("Jim Williams")
  })

  it("Enter with no active option runs the search with the typed text", async () => {
    mockSuggest()
    const onSearch = vi.fn()
    const user = userEvent.setup()
    render(<Harness onSearch={onSearch} />)

    const input = screen.getByRole("combobox")
    await user.type(input, "comp")
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument())

    await user.keyboard("{Enter}")
    expect((input as HTMLInputElement).value).toBe("comp")
    expect(onSearch).toHaveBeenCalledTimes(1)
  })

  it("Escape closes the dropdown but keeps the typed text", async () => {
    mockSuggest()
    const user = userEvent.setup()
    render(<Harness />)

    const input = screen.getByRole("combobox")
    await user.type(input, "comp")
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument())

    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument())
    expect((input as HTMLInputElement).value).toBe("comp")
  })

  it("sets aria-expanded to reflect dropdown state", async () => {
    mockSuggest()
    const user = userEvent.setup()
    render(<Harness />)

    const input = screen.getByRole("combobox")
    expect(input).toHaveAttribute("aria-expanded", "false")

    await user.type(input, "comp")
    await waitFor(() => expect(input).toHaveAttribute("aria-expanded", "true"))
  })

  it("points aria-activedescendant at the active option", async () => {
    mockSuggest()
    const user = userEvent.setup()
    render(<Harness />)

    const input = screen.getByRole("combobox")
    await user.type(input, "comp")
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument())

    await user.keyboard("{ArrowDown}")
    const activeId = input.getAttribute("aria-activedescendant")
    expect(activeId).toBeTruthy()
    expect(document.getElementById(activeId!)).toHaveTextContent("COMP SCI 200")
  })

  it("shows an empty state when nothing matches", async () => {
    mockSuggest([])
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(screen.getByRole("combobox"), "zzzz")
    await waitFor(() => expect(screen.getByText(/no matches/i)).toBeInTheDocument())
  })

  it("stays usable as a plain input when the fetch fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"))
    const onSearch = vi.fn()
    const user = userEvent.setup()
    render(<Harness onSearch={onSearch} />)

    const input = screen.getByRole("combobox")
    await user.type(input, "comp sci")
    await new Promise((r) => setTimeout(r, 300))

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
    await user.keyboard("{Enter}")
    expect(onSearch).toHaveBeenCalledTimes(1)
    expect((input as HTMLInputElement).value).toBe("comp sci")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- search-autocomplete
```

Expected: FAIL — cannot resolve `@/components/search-autocomplete`.

- [ ] **Step 3: Create the popover wrapper**

Create `BadgerBaseFrontend/components/ui/popover.tsx`:

```tsx
"use client"

import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"

import { cn } from "@/lib/utils"

const Popover = PopoverPrimitive.Root
const PopoverTrigger = PopoverPrimitive.Trigger
const PopoverAnchor = PopoverPrimitive.Anchor

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "start", sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-lg outline-none",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
))
PopoverContent.displayName = PopoverPrimitive.Content.displayName

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
```

- [ ] **Step 4: Implement the combobox**

Create `BadgerBaseFrontend/components/search-autocomplete.tsx`:

```tsx
"use client"

import { useId, useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { useSearchSuggestions, type Suggestion } from "@/hooks/use-search-suggestions"
import { cn } from "@/lib/utils"

export interface SearchAutocompleteProps {
  value: string
  onValueChange: (value: string) => void
  /** Runs the full filtered query. Called on selection and on bare Enter. */
  onSearch: () => void
  id?: string
  placeholder?: string
}

/**
 * Highlights the matched substring so it is visible why a fuzzy result
 * matched. Falls back to plain text when the query is not a literal
 * substring, which is exactly the typo case.
 */
function highlightMatch(text: string, query: string) {
  const index = text.toLowerCase().indexOf(query.toLowerCase().trim())
  if (index === -1 || !query.trim()) return text
  return (
    <>
      {text.slice(0, index)}
      <mark className="bg-transparent font-semibold text-primary">
        {text.slice(index, index + query.trim().length)}
      </mark>
      {text.slice(index + query.trim().length)}
    </>
  )
}

/**
 * Search input with a server-ranked suggestion dropdown.
 *
 * Hand-rolled listbox rather than cmdk: cmdk filters client-side over a
 * static list, while these suggestions arrive already ranked and must render
 * in API order.
 *
 * Progressive enhancement — if the suggest request fails the dropdown simply
 * never opens and this behaves as the plain input it replaced.
 */
export function SearchAutocomplete({
  value,
  onValueChange,
  onSearch,
  id,
  placeholder,
}: SearchAutocompleteProps) {
  const listboxId = useId()
  const optionIdPrefix = useId()
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { suggestions, loading, error } = useSearchSuggestions(value)

  const hasContent = suggestions.length > 0 || loading || (!error && value.trim().length >= 2)
  const isOpen = open && !error && hasContent

  const optionId = (index: number) => `${optionIdPrefix}-option-${index}`

  function close() {
    setOpen(false)
    setActiveIndex(-1)
  }

  function select(suggestion: Suggestion) {
    onValueChange(suggestion.value)
    close()
    onSearch()
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" && isOpen && suggestions.length > 0) {
      event.preventDefault()
      setActiveIndex((prev) => (prev + 1) % suggestions.length)
      return
    }
    if (event.key === "ArrowUp" && isOpen && suggestions.length > 0) {
      event.preventDefault()
      setActiveIndex((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1))
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      if (isOpen && activeIndex >= 0 && suggestions[activeIndex]) {
        select(suggestions[activeIndex])
      } else {
        close()
        onSearch()
      }
      return
    }
    if (event.key === "Escape") {
      close()
      return
    }
    if (event.key === "Tab") {
      close()
    }
  }

  return (
    <Popover open={isOpen} onOpenChange={(next) => !next && close()}>
      <PopoverAnchor asChild>
        <Input
          id={id}
          role="combobox"
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            isOpen && activeIndex >= 0 ? optionId(activeIndex) : undefined
          }
          autoComplete="off"
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            onValueChange(e.target.value)
            setOpen(true)
            setActiveIndex(-1)
          }}
          onFocus={() => value.trim().length >= 2 && setOpen(true)}
          onBlur={() => {
            // Delay so a mouse click on an option lands before the close.
            blurTimer.current = setTimeout(close, 150)
          }}
          onKeyDown={handleKeyDown}
        />
      </PopoverAnchor>

      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] max-h-72 overflow-y-auto"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {loading && suggestions.length === 0 ? (
          <p className="px-3 py-2.5 font-mono text-[11px] uppercase tracking-[0.12em] text-text-secondary">
            Searching…
          </p>
        ) : suggestions.length === 0 ? (
          <p className="px-3 py-2.5 font-mono text-[11px] uppercase tracking-[0.12em] text-text-secondary">
            No matches — press Enter to search anyway
          </p>
        ) : (
          <ul id={listboxId} role="listbox" className="py-1">
            {suggestions.map((suggestion, index) => (
              <li
                key={`${suggestion.type}-${suggestion.value}`}
                id={optionId(index)}
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(e) => {
                  // Beat the input's blur handler.
                  e.preventDefault()
                  if (blurTimer.current) clearTimeout(blurTimer.current)
                }}
                onClick={() => select(suggestion)}
                className={cn(
                  "cursor-pointer px-3 py-2",
                  index === activeIndex && "bg-accent"
                )}
              >
                <span className="block text-sm text-foreground">
                  {highlightMatch(suggestion.label, value)}
                </span>
                {suggestion.sublabel && (
                  <span className="block font-mono text-[11px] uppercase tracking-[0.08em] text-text-secondary">
                    {suggestion.sublabel}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test -- search-autocomplete
```

Expected: PASS, 13 tests.

If Radix's portal rendering interferes with `getByRole("listbox")` under jsdom, do **not** weaken the assertions — the listbox must be findable, since a screen reader has to find it too. Render the popover content inline instead by passing `forceMount` or dropping the portal in `PopoverContent`.

- [ ] **Step 6: Verify token compliance**

```bash
npm test
```

Expected: PASS — `no-hardcoded-colors.test.ts` must stay green against the two new component files.

- [ ] **Step 7: Commit**

```bash
git add components/ui/popover.tsx components/search-autocomplete.tsx __tests__/search-autocomplete.test.tsx
git commit -m "feat(search): add autocomplete combobox with keyboard navigation"
```

---

## Task 14: Wire the combobox into the filters

**Files:**
- Modify: `BadgerBaseFrontend/components/search-filters.tsx` (imports; the search block at lines 630–640)

**Interfaces:**
- Consumes: `SearchAutocomplete` (Task 13).
- Produces: no API change. `FilterState`, `EMPTY_FILTERS`, `SearchFiltersProps`, and the `onSearch` contract are untouched, so every existing consumer keeps working.

- [ ] **Step 1: Add the import**

In `BadgerBaseFrontend/components/search-filters.tsx`, after the `AvailabilityCalendar` import (line 14):

```tsx
import { SearchAutocomplete } from "./search-autocomplete"
```

- [ ] **Step 2: Replace the search input**

Replace the search block (lines 630–640) with:

```tsx
      {/* Search */}
      <div className="space-y-2">
        <Label htmlFor="search" className={fieldLabel}>Search Courses</Label>
        <SearchAutocomplete
          id="search"
          placeholder="COMP SCI 400, John Doe, etc."
          value={filters.search_param}
          onValueChange={(value) => updateFilter("search_param", value)}
          onSearch={onSearch}
        />
      </div>
```

The `Input` import stays — it is still used by the credits, seats, and RMP fields.

- [ ] **Step 3: Verify build and tests**

```bash
npm test
npm run build
```

Expected: both PASS.

- [ ] **Step 4: Manual verification against the running app**

Start the API (Task 5) and the frontend, with `API_BASE_URL` pointing at the API:

```bash
npm run dev
```

Confirm in the browser at `http://localhost:3000`:

1. Typing `comp` opens a dropdown of suggestions.
2. Typing `COMP SIC 200` still suggests `COMP SCI 200` — the headline feature.
3. Arrow keys move the highlight; Enter selects and runs the search.
4. Escape closes the dropdown and leaves the text.
5. Typing quickly fires roughly one request per pause, not one per keystroke — verify in the Network tab.
6. The dropdown renders correctly in dark mode.
7. With the API stopped, the input still accepts text and the **Search Courses** button still behaves as before.

- [ ] **Step 5: Commit**

```bash
git add components/search-filters.tsx
git commit -m "feat(search): wire autocomplete into the search filters sidebar"
```

---

## Task 15: Update the project board

**Files:**
- Modify: `~/life/projects/badgerbase/board.md`
- Create: `~/life/projects/badgerbase/fuzzy-search.md`

- [ ] **Step 1: Create the epic page**

Create `~/life/projects/badgerbase/fuzzy-search.md` following the structure of `postgres-migration.md` and `design-tokens.md`: frontmatter (`name`, `tags: [projects, projects/epic]`, `status`, `created: 2026-08-25`, `parent`), a summary, the architecture block, sub-tickets mirroring Tasks 1–14, the key decisions from the spec, and links back to `[[projects/badgerbase/overview]]` and `[[projects/badgerbase/board]]`.

- [ ] **Step 2: Update the board**

In `~/life/projects/badgerbase/board.md`, replace the bare `- [ ] Improve search` line in **Up Next** with a link to the new epic:

```markdown
- [ ] **[[projects/badgerbase/fuzzy-search|EPIC: Fuzzy Search + Autocomplete]]**
```

- [ ] **Step 3: Link from the overview**

Add to the Links section of `~/life/projects/badgerbase/overview.md`:

```markdown
- [[projects/badgerbase/fuzzy-search|Fuzzy Search + Autocomplete Epic]]
```

And add a changelog entry:

```markdown
- 2026-08-25: Planned fuzzy search + autocomplete epic
```

---

## Self-Review Notes

**Spec coverage:** Migration → T1. Endpoint, params, response, ranking, merge → T3/T4. Caching → T2/T5. Backend test table → T3/T4 (all eleven cases mapped; "prefix beats fuzzy", typo tolerance for both entity types, dedup, clamping, auth, determinism). Proxy → T9. Debounce/abort → T10/T11. Component + ARIA → T13. Styling tokens → enforced in T13 Step 6. Integration → T14. Frontend tests → T10/T11/T13. Design artifact → T12. Docs → T6. Rollout ordering → backend Tasks 1–6 land and deploy before frontend Tasks 7–14, matching the spec's "endpoint is live but unreferenced" step.

**Escaping gap closed:** the spec did not mention LIKE metacharacter escaping. Without it a user typing `%` matches every row. Added as `escapeLikePattern` in T3 with tests.

**Migration-runner gap closed:** the spec noted `ensureSchema` needed changing; T1 implements a general sorted-migration runner rather than a one-off `002` special case, so Task N+1's migration is not another trap.

**Type consistency:** `Suggestion` / `SuggestResponse` are defined once in `pg/types.ts` (T3) and re-declared structurally identically in `hooks/use-search-suggestions.ts` (T11) — separate repos, so no import is possible; the field names and nullability match exactly. `ScoredSuggestion` exists only backend-side and is stripped by `mergeSuggestions`. `MIN_QUERY_LENGTH` (2) and the limit rules appear in both T4 and T11 with the same values.
