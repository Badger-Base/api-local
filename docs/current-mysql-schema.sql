-- BadgerBase Current MySQL Schema
-- Reverse-engineered from extractors, API queries, and SQL dumps.
-- This is the source of truth for the PostgreSQL migration.

-- ============================================================
-- Course Data
-- ============================================================

CREATE TABLE IF NOT EXISTS subjects (
  subject_code VARCHAR(10) PRIMARY KEY,
  footnotes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS courses (
  course_id VARCHAR(50),
  course_uuid VARCHAR(50),
  subject_code VARCHAR(10) NOT NULL,
  course_designation VARCHAR(20) NOT NULL,
  course_title VARCHAR(100),
  catalog_number INT,
  course_description TEXT,
  enrollment_prerequisites TEXT,
  letters_and_science_credits VARCHAR(1),
  full_course_designation VARCHAR(100),
  minimum_credits INT,
  maximum_credits INT,
  general_education VARCHAR(10),
  ethnic_studies VARCHAR(10),
  social_science VARCHAR(10),
  humanities VARCHAR(10),
  biological_science VARCHAR(10),
  physical_science VARCHAR(10),
  natural_science VARCHAR(10),
  literature VARCHAR(10),
  level VARCHAR(10),
  typically_offered VARCHAR(100),
  workplace_experience_description VARCHAR(100),
  grading_basis_description VARCHAR(50),
  open_to_first_year VARCHAR(1),
  repeatable_for_credit VARCHAR(1),
  status INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  -- NOTE: No primary key. No indexes. No foreign keys.
);

CREATE TABLE IF NOT EXISTS sections (
  section_id VARCHAR(50),
  unique_section_id VARCHAR(50),
  course_id VARCHAR(50) NOT NULL,
  course_uuid VARCHAR(50),
  subject_code VARCHAR(10) NOT NULL,
  catalog_number VARCHAR(20),
  status VARCHAR(20),
  available_seats INT,
  waitlist_total INT,
  capacity INT,
  enrolled INT,
  instruction_mode VARCHAR(50),
  is_asynchronous VARCHAR(5),
  section_requisites TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  -- NOTE: No primary key. No indexes. No foreign keys.
);

CREATE TABLE IF NOT EXISTS section_instructors (
  id INT AUTO_INCREMENT PRIMARY KEY,
  section_id VARCHAR(50) NOT NULL,
  unique_section_id VARCHAR(50) NOT NULL,
  instructor_name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS section_meetings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  section_id VARCHAR(50) NOT NULL,
  unique_section_id VARCHAR(50) NOT NULL,
  section_number VARCHAR(10),
  meeting_type VARCHAR(50) NOT NULL,
  meeting_number INT,
  meeting_days VARCHAR(10),
  start_time VARCHAR(10),
  end_time VARCHAR(10),
  building_name VARCHAR(100),
  room VARCHAR(100),
  location VARCHAR(100),
  monday_meeting_start INT,
  monday_meeting_end INT,
  tuesday_meeting_start INT,
  tuesday_meeting_end INT,
  wednesday_meeting_start INT,
  wednesday_meeting_end INT,
  thursday_meeting_start INT,
  thursday_meeting_end INT,
  friday_meeting_start INT,
  friday_meeting_end INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- Grade Data
-- ============================================================

CREATE TABLE IF NOT EXISTS madgrades_course_grades (
  id SERIAL PRIMARY KEY,
  course_uuid VARCHAR(255) NOT NULL,
  course_name VARCHAR(255) NOT NULL,
  cumulative_gpa DECIMAL(3,2),
  most_recent_gpa DECIMAL(3,2),
  median_grade VARCHAR(255),
  a_percentage DECIMAL(3,2),
  ab_percentage DECIMAL(3,2),
  b_percentage DECIMAL(3,2),
  bc_percentage DECIMAL(3,2),
  c_percentage DECIMAL(3,2),
  d_percentage DECIMAL(3,2),
  f_percentage DECIMAL(3,2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_madgrades_course_grades_uuid ON madgrades_course_grades(course_uuid);
CREATE INDEX idx_madgrades_course_grades_cumulative ON madgrades_course_grades(cumulative_gpa);
CREATE INDEX idx_madgrades_course_grades_recent ON madgrades_course_grades(most_recent_gpa);

-- ============================================================
-- RateMyProfessor Data
-- ============================================================

CREATE TABLE IF NOT EXISTS rmp_teachers (
  uid VARCHAR(255) PRIMARY KEY,
  first_name VARCHAR(255),
  last_name VARCHAR(255),
  department VARCHAR(255),
  avg_rating DECIMAL(3,2),
  num_ratings INTEGER,
  avg_difficulty DECIMAL(3,2),
  would_take_again_percent DECIMAL(5,2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rmp_cleaned (
  id VARCHAR(255) PRIMARY KEY,
  legacy_id VARCHAR(100),
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  full_name VARCHAR(200),
  department VARCHAR(100),
  avg_rating FLOAT,
  num_ratings INT,
  avg_difficulty FLOAT,
  would_take_again_percent FLOAT
);

-- ============================================================
-- Subscription Data
-- ============================================================

CREATE TABLE IF NOT EXISTS course_subscriptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  course_id VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  -- NOTE: Uniqueness on (email, course_id) enforced in app logic only.
);

CREATE TABLE IF NOT EXISTS section_subscriptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  section_id VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  -- NOTE: Uniqueness on (email, section_id) enforced in app logic only.
);

-- ============================================================
-- Implicit Relationships (no foreign keys enforced)
--
-- subjects.subject_code        <-- courses.subject_code
-- courses.course_uuid          <-- sections.course_uuid
-- courses.course_id            <-- sections.course_id
-- sections.section_id          <-- section_instructors.section_id
-- sections.unique_section_id   <-- section_meetings.unique_section_id
-- courses.course_designation   <-- madgrades_course_grades.course_name   (string join)
-- section_instructors.instructor_name <-- rmp_cleaned.full_name          (string join)
-- courses.course_id            <-- course_subscriptions.course_id
-- sections.section_id          <-- section_subscriptions.section_id
-- ============================================================
