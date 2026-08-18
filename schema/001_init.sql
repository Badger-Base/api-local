-- BadgerBase PostgreSQL Schema
-- Migration from MySQL single-file API to structured Postgres
-- See UUID_SPIKE.md for identifier consolidation rationale

BEGIN;

-- ── Enum types ──────────────────────────────────────────────────────

CREATE TYPE section_status AS ENUM ('OPEN', 'CLOSED', 'WAITLISTED');

-- ── Subjects ────────────────────────────────────────────────────────

CREATE TABLE subjects (
    subject_code VARCHAR(20) PRIMARY KEY,
    footnotes    TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Courses ─────────────────────────────────────────────────────────
-- courses.status rollup REMOVED — derive from sections at query time.
-- Breadth fields converted from magic strings to booleans.

CREATE TABLE courses (
    id                              SERIAL PRIMARY KEY,
    course_id                       VARCHAR(50) NOT NULL,  -- UW API courseId, shared across cross-listings
    course_uuid                     VARCHAR(50) NOT NULL UNIQUE,  -- generated per cross-listing entry
    subject_code                    VARCHAR(20) NOT NULL REFERENCES subjects(subject_code),
    course_designation              VARCHAR(30) NOT NULL,
    full_course_designation         VARCHAR(100),
    course_title                    VARCHAR(200),
    catalog_number                  INTEGER,
    course_description              TEXT,
    enrollment_prerequisites        TEXT,

    -- Credits
    minimum_credits                 INTEGER,
    maximum_credits                 INTEGER,
    letters_and_science_credits     BOOLEAN NOT NULL DEFAULT false,

    -- Breadth requirements (were magic strings, now booleans)
    ethnic_studies                  BOOLEAN NOT NULL DEFAULT false,
    social_science                  BOOLEAN NOT NULL DEFAULT false,
    humanities                      BOOLEAN NOT NULL DEFAULT false,
    biological_science              BOOLEAN NOT NULL DEFAULT false,
    physical_science                BOOLEAN NOT NULL DEFAULT false,
    natural_science                 BOOLEAN NOT NULL DEFAULT false,
    literature                      BOOLEAN NOT NULL DEFAULT false,

    -- General education & level
    general_education               VARCHAR(20),
    level                           VARCHAR(20),

    -- Metadata
    typically_offered               VARCHAR(100),
    workplace_experience_description VARCHAR(200),
    grading_basis_description       VARCHAR(50),
    open_to_first_year              BOOLEAN NOT NULL DEFAULT false,
    repeatable_for_credit           BOOLEAN NOT NULL DEFAULT false,

    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Sections ────────────────────────────────────────────────────────
-- unique_section_id REMOVED — use id (auto-increment PK) for all joins.
-- Linked to courses via course_ref (FK to courses.id), NOT courses.course_id.

CREATE TABLE sections (
    id                  SERIAL PRIMARY KEY,
    section_id          VARCHAR(50) NOT NULL,  -- UW enrollmentClassNumber, shared across cross-listings
    section_uuid        VARCHAR(50) NOT NULL UNIQUE,
    course_ref          INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    status              section_status NOT NULL DEFAULT 'CLOSED',
    available_seats     INTEGER NOT NULL DEFAULT 0,
    waitlist_total      INTEGER NOT NULL DEFAULT 0,
    capacity            INTEGER NOT NULL DEFAULT 0,
    enrolled            INTEGER NOT NULL DEFAULT 0,
    instruction_mode    VARCHAR(50),
    is_asynchronous     BOOLEAN NOT NULL DEFAULT false,
    section_requisites  TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Section instructors ─────────────────────────────────────────────

CREATE TABLE section_instructors (
    id              SERIAL PRIMARY KEY,
    section_id      INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    instructor_name VARCHAR(200) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Section meetings ────────────────────────────────────────────────

CREATE TABLE section_meetings (
    id                      SERIAL PRIMARY KEY,
    section_id              INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    meeting_number          INTEGER,
    section_number          VARCHAR(10),
    meeting_type            VARCHAR(50) NOT NULL,
    meeting_days            VARCHAR(10),
    start_time              VARCHAR(20),
    end_time                VARCHAR(20),
    building_name           VARCHAR(100),
    room                    VARCHAR(50),
    location                VARCHAR(200),

    -- Day-specific millisecond timestamps for time-range filtering
    monday_meeting_start    INTEGER,
    monday_meeting_end      INTEGER,
    tuesday_meeting_start   INTEGER,
    tuesday_meeting_end     INTEGER,
    wednesday_meeting_start INTEGER,
    wednesday_meeting_end   INTEGER,
    thursday_meeting_start  INTEGER,
    thursday_meeting_end    INTEGER,
    friday_meeting_start    INTEGER,
    friday_meeting_end      INTEGER,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── RMP data ────────────────────────────────────────────────────────

CREATE TABLE rmp_cleaned (
    id                       SERIAL PRIMARY KEY,
    full_name                VARCHAR(200) NOT NULL UNIQUE,
    avg_rating               NUMERIC(3,2),
    avg_difficulty           NUMERIC(3,2),
    num_ratings              INTEGER NOT NULL DEFAULT 0,
    would_take_again_percent NUMERIC(5,2),
    legacy_id                VARCHAR(50),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Madgrades course grades ─────────────────────────────────────────

CREATE TABLE madgrades_course_grades (
    id               SERIAL PRIMARY KEY,
    course_name      VARCHAR(30) NOT NULL,
    course_uuid      VARCHAR(50),
    median_grade     VARCHAR(5),
    a_percentage     NUMERIC(5,2),
    ab_percentage    NUMERIC(5,2),
    b_percentage     NUMERIC(5,2),
    bc_percentage    NUMERIC(5,2),
    c_percentage     NUMERIC(5,2),
    d_percentage     NUMERIC(5,2),
    f_percentage     NUMERIC(5,2),
    cumulative_gpa   NUMERIC(4,2),
    most_recent_gpa  NUMERIC(4,2),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Subscriptions ───────────────────────────────────────────────────

CREATE TABLE course_subscriptions (
    id         SERIAL PRIMARY KEY,
    email      VARCHAR(255) NOT NULL,
    course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(email, course_id)
);

CREATE TABLE section_subscriptions (
    id         SERIAL PRIMARY KEY,
    email      VARCHAR(255) NOT NULL,
    section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(email, section_id)
);

-- ── Indexes ─────────────────────────────────────────────────────────
-- Composite indexes for the EXISTS subquery pattern (section-level filtering)

CREATE INDEX idx_sections_course_status     ON sections (course_ref, status);
CREATE INDEX idx_sections_course_mode_seats ON sections (course_ref, instruction_mode, available_seats);
CREATE INDEX idx_meetings_section           ON section_meetings (section_id);
CREATE INDEX idx_instructors_section        ON section_instructors (section_id);
CREATE INDEX idx_rmp_name                   ON rmp_cleaned (full_name);
CREATE INDEX idx_courses_course_id          ON courses (course_id);  -- UW API ID, not unique (cross-listings)
CREATE INDEX idx_courses_level              ON courses (level);
CREATE INDEX idx_courses_subject            ON courses (subject_code);
CREATE INDEX idx_courses_catalog            ON courses (catalog_number);
CREATE INDEX idx_courses_designation        ON courses (course_designation);
CREATE INDEX idx_grades_course_name         ON madgrades_course_grades (course_name);
CREATE INDEX idx_grades_course_uuid         ON madgrades_course_grades (course_uuid);
CREATE INDEX idx_course_subs_email          ON course_subscriptions (email);
CREATE INDEX idx_section_subs_email         ON section_subscriptions (email);

-- ── Updated-at trigger ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_courses_updated_at
    BEFORE UPDATE ON courses FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_sections_updated_at
    BEFORE UPDATE ON sections FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_rmp_updated_at
    BEFORE UPDATE ON rmp_cleaned FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_grades_updated_at
    BEFORE UPDATE ON madgrades_course_grades FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMIT;
