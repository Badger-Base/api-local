# BadgerBase Fuzzy Search + Autocomplete

**Date:** 2026-08-25
**Status:** Draft — pending review
**Approach:** Postgres `pg_trgm` trigram matching behind a new suggest endpoint on the v2 (Postgres) API, consumed by a debounced combobox in the frontend search input.

## Goal

Replace the current substring-only course search with typo-tolerant fuzzy matching, and surface suggestions in a dropdown as the user types.

Today `search_param` runs a plain `ILIKE '%term%'` across `courses.course_designation`, `courses.course_title`, `courses.full_course_designation`, and `section_instructors.instructor_name` (`pg/routes/courses.ts:68-88`). This means:

- A typo returns zero results. `"COMP SIC 200"` finds nothing.
- Word order matters. `"intro algorithms"` misses `"Introduction to Algorithms"`.
- There is no feedback until the user clicks **Search Courses** — no incremental discovery.

**Primary objective:** A user who half-remembers a course or misspells an instructor still finds what they want.
**Secondary objective:** Suggestions appear as they type, so the search box teaches them what exists.

## Constraints

- **v2 API only.** All work lands on the Postgres/Kysely API under `pg/`. The legacy MySQL `api.js` is not touched — it is being decommissioned in Phase 6.
- **The frontend is already on v2 for queries.** `app/api/proxy/route.ts` calls `${API_BASE_URL}/v2/api/query`. The suggest endpoint mounts on the same service behind the same `GET_API_KEY`, so no new environment variables and no new deploy target are needed. Railway deploys on merge to main.
- **The dropdown is progressive enhancement.** The existing flow — type into the input, press Enter or click **Search Courses** — must keep working unchanged if the suggest endpoint is slow, errored, or unreachable.
- **`search_param` semantics do not change in this spec.** The suggest endpoint is additive. Making the main `/api/query` search fuzzy is deliberately deferred (see Out of Scope).
- **No new infrastructure.** `pg_trgm` ships with Postgres; the corpus is a few thousand courses.

## Approach Selection

| Option | Verdict |
|---|---|
| **Postgres `pg_trgm` + GIN indexes** | **Chosen.** Real typo tolerance, no new services, testable in the existing `pg-tests` harness (which runs against a real Postgres, not the SQLite adapter the legacy tests use). |
| Client-side fuzzy (Fuse.js) over a prefetched course list | Rejected. No endpoint or throttling, as requested. Ships the whole catalog to the browser, and instructor names live section-side so the payload balloons. |
| Dedicated search service (Meilisearch / Typesense / Algolia) | Rejected. New infra to run, pay for, and keep in sync via ETL, for a corpus small enough that Postgres handles it in single-digit milliseconds. |

## Architecture

```
api-local/
  schema/002_search_trgm.sql       <- NEW: pg_trgm extension + GIN indexes
  pg/routes/search.ts              <- NEW: createPgSearchApp — GET /api/search/suggest
  pg/cache.ts                      <- MODIFIED: parameterize prefix + TTL
  server.ts                        <- MODIFIED: mount search app at /v2
  pg-tests/setup.ts                <- MODIFIED: apply 002 alongside 001
  pg-tests/search-route.test.ts    <- NEW
  pg-tests/fixtures/default.ts     <- MODIFIED: rows that exercise fuzzy ranking
  docs/query-api-reference.md      <- MODIFIED: document the new endpoint

BadgerBaseFrontend/
  lib/allowed-origins.ts           <- NEW: extracted from app/api/proxy/route.ts
  app/api/proxy/route.ts           <- MODIFIED: import the shared allowlist
  app/api/search-suggest/route.ts  <- NEW: proxy to /v2/api/search/suggest
  hooks/use-debounced-value.ts     <- NEW
  hooks/use-search-suggestions.ts  <- NEW: debounce + abort + fetch state
  components/ui/popover.tsx        <- NEW (shadcn add popover)
  components/search-autocomplete.tsx <- NEW: the combobox
  components/search-filters.tsx    <- MODIFIED: swap the search Input for it
```

The search route is a separate Hono app (`createPgSearchApp`) rather than another handler inside `createPgApp`, mirroring how `pg/routes/subscriptions.ts` is already split out. `createPgApp` is a query pipeline; suggestions are a different concern with different caching and a different response shape.

## Backend

### Migration — `schema/002_search_trgm.sql`

```sql
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

`pg-tests/setup.ts` currently applies `schema/001_init.sql` only, and short-circuits entirely when `to_regclass('public.courses')` is non-null. That guard means an already-initialized test database would never pick up `002`. Change `ensureSchema` to apply migration files in sorted order, each guarded by its own idempotency check (`CREATE EXTENSION IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` make `002` safe to re-run unconditionally).

### Endpoint — `GET /v2/api/search/suggest`

Auth: `apiKeyAuth(apiKey)` on `/api/*`, identical to the other v2 apps.

**Parameters**

| Param | Required | Default | Notes |
|---|---|---|---|
| `q` | yes | — | Trimmed. Fewer than 2 characters returns an empty list with HTTP 200. |
| `limit` | no | `8` | Clamped to `[1, 10]`. Non-numeric falls back to the default. |

**Response**

```json
{
  "suggestions": [
    {
      "type": "course",
      "value": "COMP SCI 200",
      "label": "COMP SCI 200",
      "sublabel": "Programming I",
      "course_uuid": "abc-123"
    },
    {
      "type": "instructor",
      "value": "Jim Williams",
      "label": "Jim Williams",
      "sublabel": "Instructor · 12 sections",
      "course_uuid": null
    }
  ]
}
```

`value` is what gets written into `search_param` when the suggestion is selected. `course_uuid` is carried so a later iteration can deep-link straight to a course without a round trip; the frontend in this spec ignores it.

**Ranking**

Courses and instructors are queried separately, each scored, then merged and truncated to `limit`.

Score for a row is the greatest of its per-field scores, where each field scores as:

1. `2.0 + similarity` — field starts with `q` (case-insensitive `ILIKE 'q%'`)
2. `1.0 + similarity` — field contains `q` (`ILIKE '%q%'`)
3. `similarity(field, q)` — trigram similarity, only if `>= 0.3`
4. otherwise the row is excluded

The tiered constants guarantee prefix matches always outrank substring matches, which always outrank pure fuzzy matches. Typing `"COMP SCI 4"` must never rank a fuzzy typo hit above the literal prefix hits. Ties break on `courses.catalog_number ASC` for courses and rating count `DESC` for instructors, so ordering is deterministic across runs.

The similarity floor is `0.3` — Postgres' `pg_trgm` default. It is defined as an exported constant in `search.ts`, not inlined, so it can be tuned in one place.

Instructor rows aggregate: `SELECT instructor_name, COUNT(DISTINCT section_id)` grouped by name, so each instructor appears once regardless of how many sections they teach.

Merge rule, in order:

1. Concatenate course and instructor rows and sort by score descending.
2. Take the top `limit`.
3. If that slice contains no instructor row **and** at least one instructor scored above the floor, replace the lowest-scoring course row with the highest-scoring instructor row.

A student searching a professor's name should never see a dropdown of only course codes.

### Caching

Suggestions are cached in Redis. `pg/cache.ts` currently hardcodes `CACHE_PREFIX = "pg:query:"` and `CACHE_TTL = 3600`. Change `createCache(redis)` to `createCache(redis, { prefix, ttl })` with the current values as defaults, so existing call sites are unaffected, and construct a second instance for suggestions with prefix `pg:suggest:` and a 300-second TTL.

Short TTL because suggestion text tracks the catalog, and 5 minutes bounds staleness after an ETL run without a cache-busting hook. `bustAll` must remain scoped to its own prefix so busting query cache does not wipe suggestions or vice versa.

Cache failures degrade to a miss, never an error — the existing behavior.

### Backend tests — `pg-tests/search-route.test.ts`

Following the `courses-route.test.ts` pattern (real Postgres via `TEST_DATABASE_URL`, seeded fixture, `app.request(...)`).

| Case | Assertion |
|---|---|
| Exact designation | `q=COMP SCI 200` returns that course first |
| Prefix beats fuzzy | `q=COMP SCI 2` ranks `COMP SCI 200` above a fuzzy-only match |
| Typo tolerance — designation | `q=COMP SIC 200` still surfaces `COMP SCI 200` |
| Typo tolerance — instructor | `q=Willliams` still surfaces `Jim Williams` |
| Title word match | `q=algorithms` surfaces `Introduction to Algorithms` |
| Instructor guaranteed slot | an instructor-heavy query returns at least one `type: "instructor"` |
| Instructor deduplication | an instructor on 3 sections appears exactly once |
| `q` under 2 chars | returns `{ suggestions: [] }`, HTTP 200 |
| `limit` clamping | `limit=999` returns at most 10; `limit=abc` returns 8 |
| Auth | a request with no `x-api-key` is rejected |
| Determinism | the same query run twice returns identical ordering |

`pg-tests/fixtures/default.ts` gains rows that make ranking assertions meaningful: courses whose titles share words, an instructor teaching multiple sections, and a near-miss designation pair.

## Frontend

### Proxy — `app/api/search-suggest/route.ts`

Mirrors `app/api/proxy/route.ts`: origin allowlist check, then a server-side fetch to `${API_BASE_URL}/v2/api/search/suggest` with `x-api-key` from `process.env.API_KEY`. The key stays server-side, as it does today.

`ALLOWED_ORIGINS` is currently a literal array inside `app/api/proxy/route.ts`. Rather than copy it, extract it to `lib/allowed-origins.ts` and import it from both routes — otherwise adding a domain means remembering two files.

Uses the existing `fetchWithRetry` from `lib/fetch-with-retry.ts`, consistent with the query proxy.

### Request pacing — debounce, not throttle

A **debounce** of 200ms, not a throttle. Throttle emits on a fixed cadence during continuous typing, firing requests for prefixes the user has already typed past. Debounce waits for a pause, which is the correct trigger for "the user has typed enough to mean something." 200ms is below the ~250ms threshold where input feels laggy, while collapsing a typed word into roughly one request.

Paired with an `AbortController` that cancels the in-flight request whenever a new one starts. Without it, responses can resolve out of order and paint stale suggestions under a newer query — the classic autocomplete race.

Split across two hooks:
- `hooks/use-debounced-value.ts` — generic value debouncer, no fetch knowledge.
- `hooks/use-search-suggestions.ts` — owns abort, loading/error state, and the minimum-length guard, and returns `{ suggestions, loading, error }`.

The split keeps the fetch policy testable without mounting a component.

### Component — `components/search-autocomplete.tsx`

Wraps the existing search `Input`. `components/ui/` has `dropdown-menu` and `multi-select-dropdown` but no combobox primitive, so add shadcn's `popover` and hand-roll the listbox. `cmdk`/Command is the wrong fit — it filters client-side over a static list, while these suggestions are server-ranked and must render in the order the API returns.

ARIA combobox pattern:

| Key | Behavior |
|---|---|
| `↓` / `↑` | Move active option; wraps at both ends |
| `Enter` | Select active option; with none active, run the search as today |
| `Escape` | Close the dropdown, keep the typed text |
| `Tab` | Close and move focus on, no selection |
| Blur | Close, after a click-settle delay so mouse selection still registers |

Wiring: `role="combobox"` with `aria-expanded` / `aria-controls` / `aria-activedescendant` on the input, `role="listbox"` on the panel, `role="option"` with `aria-selected` on rows. Selecting a suggestion sets `search_param` and immediately triggers `onSearch()` — one interaction, not two.

**States:** idle (closed) · loading · results · empty (`No matches` — the button still runs a full search) · error (silently closed; never blocks the existing flow).

Matched substrings are highlighted within each row so it is visible *why* a fuzzy result matched.

### Styling

Design tokens only — `docs/superpowers/specs/2026-08-13-design-tokens-design.md` in the frontend repo governs, and `__tests__/no-hardcoded-colors.test.ts` enforces it. The dropdown uses `--color-surface-raised`, `--color-border`, `--shadow-lg`, `--radius-lg`; the active row uses `--color-primary-subtle`; type labels reuse the existing `fieldLabel` treatment from `search-filters.tsx` (mono, uppercase, `0.12em` tracking) so the dropdown reads as part of the same registrar-ink system.

### Integration — `components/search-filters.tsx`

The search block at lines 630-640 swaps its `Input` for `<SearchAutocomplete />`. `FilterState`, `EMPTY_FILTERS`, and the `onSearch` contract are unchanged, so every other consumer of `SearchFilters` is untouched.

### Frontend tests

`__tests__/` currently holds only build and token guards; these are the first behavioral component tests, matching the "Add frontend test coverage" item already on the board.

- `use-debounced-value` — only the trailing value propagates during rapid changes.
- `use-search-suggestions` — under 2 characters issues no request; a superseded request is aborted; an out-of-order response never overwrites a newer one.
- `search-autocomplete` — arrow-key navigation, Enter selection, Escape, empty state, and that a failed fetch leaves the plain input usable.

## Design Artifact

Before the component is built, a Claude Artifact mocks every dropdown state — idle, loading, mixed course/instructor results with match highlighting, empty, and keyboard-active — in both light and dark, using the real tokens. It is a design-approval step: the visual gets signed off before it is implemented, not after.

## Rollout

1. Migration and endpoint merge first, with tests. Deploys to Railway on merge; the endpoint is live but unreferenced.
2. Verify against production data — latency and ranking quality on real course and instructor names, not just fixtures.
3. Frontend merges after. If suggestions look wrong in production, reverting is a single-component change and search keeps working.

There is no feature flag. The endpoint is inert until the frontend calls it, and the component degrades to today's plain input on any failure, which covers the same ground more simply.

## Success Criteria

- `"COMP SIC 200"` and `"Willliams"` both return the intended target.
- Suggestions render under 150ms at p95 against production data, cache warm.
- Typing a 12-character query fires roughly one request, not twelve.
- The dropdown is fully keyboard-operable and screen-reader-labeled.
- Suggest endpoint failure leaves the existing search flow working, with no visible error.
- Existing `/api/query` behavior and all current tests are unchanged.

## Out of Scope

- **Fuzzy `search_param` on `/api/query`.** The suggest endpoint proves the ranking approach against real queries first; folding trigram scoring into the main filter pipeline changes results for every existing user and deserves its own spec.
- **Search-as-you-type results.** The dropdown suggests terms; running the full filtered query still requires selection or Enter.
- **Recent/popular searches.** Needs persistence and a PostHog-backed popularity signal.
- **Synonyms and abbreviation expansion** (`"cs"` → `"COMP SCI"`). A curated alias table, worth doing, separately.
- **Legacy `api.js` backport.** It is being decommissioned.
