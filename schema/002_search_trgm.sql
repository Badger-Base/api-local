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
