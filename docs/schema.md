# BadgerBase MySQL Schema

Full schema reference for both APIs (`api.js` and `subscription_api.ts`).
Reverse-engineered from extractors, SQL dumps, and API queries.

---

## Course Data Tables

### `courses`
Source: `course_search_and_enroll_extractor.js`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| course_id | VARCHAR(50) | | UW system course ID |
| course_uuid | VARCHAR(50) | | Primary join key for sections |
| subject_code | VARCHAR(10) | NOT NULL | e.g. "COMP SCI", "MATH" |
| course_designation | VARCHAR(20) | NOT NULL | e.g. "SCI 101" — joined to madgrades |
| course_title | VARCHAR(100) | | |
| catalog_number | INT | | Numeric part of designation, used for default sort |
| course_description | TEXT | | |
| enrollment_prerequisites | TEXT | | Free text: "None", "Sophomore standing", etc. |
| letters_and_science_credits | VARCHAR(1) | | "C" if counts |
| full_course_designation | VARCHAR(100) | | e.g. "COMP SCI 101" |
| minimum_credits | INT | | |
| maximum_credits | INT | | |
| general_education | VARCHAR(10) | | |
| ethnic_studies | VARCHAR(10) | | "ETHNIC ST" if qualifies |
| social_science | VARCHAR(10) | | "S" if qualifies |
| humanities | VARCHAR(10) | | "H" if qualifies |
| biological_science | VARCHAR(10) | | "B" if qualifies |
| physical_science | VARCHAR(10) | | "P" if qualifies |
| natural_science | VARCHAR(10) | | "N" if qualifies |
| literature | VARCHAR(10) | | "L" if qualifies |
| level | VARCHAR(10) | | e.g. "Elementary" |
| typically_offered | VARCHAR(100) | | |
| workplace_experience_description | VARCHAR(100) | | |
| grading_basis_description | VARCHAR(50) | | |
| open_to_first_year | VARCHAR(1) | | |
| repeatable_for_credit | VARCHAR(1) | | |
| status | INT | DEFAULT 0 | 0=closed, 1=waitlisted, 2=open |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

**No primary key.** No indexes.

---

### `sections`
Source: `course_search_and_enroll_extractor.js`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| section_id | VARCHAR(50) | | Enrollment class number |
| unique_section_id | VARCHAR(50) | | UUID, used for meeting/instructor joins |
| course_id | VARCHAR(50) | NOT NULL | FK → courses.course_id |
| course_uuid | VARCHAR(50) | | FK → courses.course_uuid |
| subject_code | VARCHAR(10) | NOT NULL | |
| catalog_number | VARCHAR(20) | | |
| status | VARCHAR(20) | | "OPEN", "CLOSED", "WAITLISTED" |
| available_seats | INT | | |
| waitlist_total | INT | | |
| capacity | INT | | |
| enrolled | INT | | |
| instruction_mode | VARCHAR(50) | | |
| is_asynchronous | VARCHAR(5) | | |
| section_requisites | TEXT | | |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

**No primary key.** No indexes.

---

### `section_instructors`
Source: `course_search_and_enroll_extractor.js`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | INT | AUTO_INCREMENT PRIMARY KEY | |
| section_id | VARCHAR(50) | NOT NULL | FK → sections.section_id |
| unique_section_id | VARCHAR(50) | NOT NULL | |
| instructor_name | VARCHAR(100) | NOT NULL | String-joined to rmp_cleaned.full_name |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

---

### `section_meetings`
Source: `course_search_and_enroll_extractor.js`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | INT | AUTO_INCREMENT PRIMARY KEY | |
| section_id | VARCHAR(50) | NOT NULL | |
| unique_section_id | VARCHAR(50) | NOT NULL | FK → sections.unique_section_id |
| section_number | VARCHAR(10) | | |
| meeting_type | VARCHAR(50) | NOT NULL | LEC, DIS, LAB, etc. |
| meeting_number | INT | | |
| meeting_days | VARCHAR(10) | | e.g. "MWF", "TR" |
| start_time | VARCHAR(10) | | Human-readable ("9:00 AM") |
| end_time | VARCHAR(10) | | Human-readable |
| building_name | VARCHAR(100) | | |
| room | VARCHAR(100) | | |
| location | VARCHAR(100) | | "ONLINE", "OFF CAMPUS", or building |
| monday_meeting_start | INT | | Milliseconds from midnight |
| monday_meeting_end | INT | | |
| tuesday_meeting_start | INT | | |
| tuesday_meeting_end | INT | | |
| wednesday_meeting_start | INT | | |
| wednesday_meeting_end | INT | | |
| thursday_meeting_start | INT | | |
| thursday_meeting_end | INT | | |
| friday_meeting_start | INT | | |
| friday_meeting_end | INT | | |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

---

### `subjects`
Source: `course_search_and_enroll_extractor.js`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| subject_code | VARCHAR(10) | PRIMARY KEY | |
| footnotes | TEXT | | |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

---

## Grade Data Tables

### `madgrades_course_grades`
Source: `madgrades_extractor.js`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | SERIAL | PRIMARY KEY | |
| course_uuid | VARCHAR(255) | NOT NULL | Madgrades UUID (different namespace from courses.course_uuid) |
| course_name | VARCHAR(255) | NOT NULL | String-joined to courses.course_designation |
| cumulative_gpa | DECIMAL(3,2) | | |
| most_recent_gpa | DECIMAL(3,2) | | |
| median_grade | VARCHAR(255) | | "A", "AB", "B", etc. |
| a_percentage | DECIMAL(3,2) | | |
| ab_percentage | DECIMAL(3,2) | | |
| b_percentage | DECIMAL(3,2) | | |
| bc_percentage | DECIMAL(3,2) | | |
| c_percentage | DECIMAL(3,2) | | |
| d_percentage | DECIMAL(3,2) | | |
| f_percentage | DECIMAL(3,2) | | |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

**Indexes:** `course_uuid`, `cumulative_gpa`, `most_recent_gpa`

---

## RateMyProfessor Tables

### `rmp_cleaned`
Source: `rmp_preprocessor.py` (processed from `rmp_teachers`)

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | VARCHAR(255) | PRIMARY KEY | Base64-encoded RMP teacher ID |
| legacy_id | VARCHAR(100) | | Numeric RMP ID |
| first_name | VARCHAR(100) | | Cleaned/normalized |
| last_name | VARCHAR(100) | | Cleaned/normalized |
| full_name | VARCHAR(200) | | String-joined to section_instructors.instructor_name |
| department | VARCHAR(100) | | |
| avg_rating | FLOAT | | 0–5 scale |
| num_ratings | INT | | |
| avg_difficulty | FLOAT | | 0–5 scale |
| would_take_again_percent | FLOAT | | 0–100 |

### `rmp_teachers` (raw, pre-processing)
Source: `rmp-extractor.js`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| uid | VARCHAR(255) | PRIMARY KEY | |
| first_name | VARCHAR(255) | | |
| last_name | VARCHAR(255) | | |
| department | VARCHAR(255) | | |
| avg_rating | DECIMAL(3,2) | | |
| num_ratings | INTEGER | | |
| avg_difficulty | DECIMAL(3,2) | | |
| would_take_again_percent | DECIMAL(5,2) | | |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

---

## Subscription Tables

### `course_subscriptions`
Source: `subscription_api.ts`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | INT | AUTO_INCREMENT PRIMARY KEY | (inferred) |
| email | VARCHAR | NOT NULL | User email, from Supabase JWT |
| course_id | VARCHAR | NOT NULL | FK → courses.course_id |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | (inferred) |

**Unique constraint (inferred):** `(email, course_id)` — enforced in app logic via duplicate check.

### `section_subscriptions`
Source: `subscription_api.ts`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | INT | AUTO_INCREMENT PRIMARY KEY | (inferred) |
| email | VARCHAR | NOT NULL | User email, from Supabase JWT |
| section_id | VARCHAR | NOT NULL | FK → sections.section_id |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | (inferred) |

**Unique constraint (inferred):** `(email, section_id)` — enforced in app logic via duplicate check.

---

## Relationships

```
subjects.subject_code          ←── courses.subject_code
courses.course_uuid            ←── sections.course_uuid
courses.course_id              ←── sections.course_id
sections.section_id            ←── section_instructors.section_id
sections.unique_section_id     ←── section_meetings.unique_section_id
courses.course_designation     ←── madgrades_course_grades.course_name     (string join)
section_instructors.instructor_name ←── rmp_cleaned.full_name              (string join)
courses.course_id              ←── course_subscriptions.course_id
sections.section_id            ←── section_subscriptions.section_id
sections.course_uuid           ←── courses.course_uuid                     (subscription list query)
```

## Known Issues

1. **No foreign keys enforced** — all relationships are implicit string matches.
2. **No primary keys on `courses` or `sections`** — the two largest tables.
3. **Fragile string-based joins** — `course_designation = course_name` and `instructor_name = full_name`.
4. **Inconsistent status types** — `courses.status` is INT (0/1/2), `sections.status` is VARCHAR.
5. **DECIMAL(3,2) for percentages** — max 9.99, but values can be 0–100. Should be DECIMAL(5,2).
6. **Breadth designators as single chars** — could be booleans or enums.
7. **10 day-specific meeting columns** — could be normalized into a meetings-per-day join table.
8. **Subscription uniqueness not enforced at DB level** — only checked in application code.
9. **`rmp_teachers` is unused by the API** — only `rmp_cleaned` matters after preprocessing.
