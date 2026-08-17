# UUID Consolidation Spike

## Current state: 4 identifiers, inconsistent joins

The MySQL schema uses four separate identifiers across courses and sections:

| Identifier | Source | Used by |
|---|---|---|
| `courses.course_id` | UW Course Search API | Identifies the underlying UW course (shared across cross-listings) |
| `courses.course_uuid` | Generated (`uuidv4()`) at ETL time | API grouping key, all frontend queries |
| `sections.section_id` | UW API enrollment class number | `section_instructors` joins |
| `sections.unique_section_id` | Generated (`uuidv4()`) at ETL time | `section_meetings` joins |

The inconsistency: `section_instructors` joins on `section_id` (the UW API number), while `section_meetings` joins on `unique_section_id` (the generated UUID). Both are string-based, neither has a foreign key constraint.

## Cross-listing complication

The UW API gives the same `courseId` to all cross-listings of a course. For example, "Cooperative Education Program" appears under I SY E 1, B M E 1, M E 1, etc. — all sharing `courseId: "025015"`. The scraper processes each subject independently, so the same underlying course appears as 10+ separate rows.

`course_uuid` (generated per scrape hit) is what gives each cross-listing its own identity. Without it, all cross-listings would collapse into one row. Similarly, `section_id` (enrollmentClassNumber) can appear under multiple cross-listings — the same physical section listed under different departments.

This means: **`course_id` and `section_id` are NOT unique** in BadgerBase's data model.

## Postgres consolidation

- Every table gets an auto-increment `id` as its internal primary key
- `course_uuid` kept as `UNIQUE` — it's the per-cross-listing identity, the grouping key used everywhere in the API
- `course_id` kept but NOT UNIQUE — it's the UW API's courseId, shared across cross-listings
- `section_id` kept but NOT UNIQUE — it's the UW enrollmentClassNumber, can repeat across cross-listings
- `unique_section_id` removed — the auto-increment `sections.id` PK replaces it (each section row within a specific cross-listing gets its own identity)
- All FK relationships reference the internal `id` PKs with `ON DELETE CASCADE`
- `sections.course_ref` (not `course_id`) for the FK to `courses.id` — avoids confusion with `courses.course_id` (the UW API field, a VARCHAR)

## Impact on ETL

The extractors currently generate `course_uuid` and `unique_section_id` via `uuidv4()`. In the new schema:

- `course_uuid` generation stays — it's the per-cross-listing identity key (regenerated each scrape, but that's fine since ETL does full reimport)
- `unique_section_id` generation can be dropped — the Postgres auto-increment `sections.id` replaces it
- The ETL insert order matters now (courses before sections, sections before instructors/meetings) because of FK constraints, but this is already the natural insert order
- The ETL needs to resolve the `courses.id` after inserting a course row to use as the FK for sections (use `RETURNING id` or a lookup by `course_uuid`)
