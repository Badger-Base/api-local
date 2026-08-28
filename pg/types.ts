import type { ColumnType, Generated, Selectable } from "kysely";

// ── Table types (match 001_init.sql exactly) ──

export interface CoursesTable {
  id: Generated<number>;
  course_id: string;
  course_uuid: string;
  subject_code: string;
  course_designation: string;
  full_course_designation: string | null;
  course_title: string | null;
  catalog_number: number | null;
  course_description: string | null;
  enrollment_prerequisites: string | null;
  minimum_credits: number | null;
  maximum_credits: number | null;
  letters_and_science_credits: boolean;
  ethnic_studies: boolean;
  social_science: boolean;
  humanities: boolean;
  biological_science: boolean;
  physical_science: boolean;
  natural_science: boolean;
  literature: boolean;
  general_education: string | null;
  level: string | null;
  typically_offered: string | null;
  workplace_experience_description: string | null;
  grading_basis_description: string | null;
  open_to_first_year: boolean;
  repeatable_for_credit: boolean;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export interface SectionsTable {
  id: Generated<number>;
  section_id: string;
  section_uuid: string;
  course_ref: number;
  status: "OPEN" | "CLOSED" | "WAITLISTED";
  available_seats: number;
  waitlist_total: number;
  capacity: number;
  enrolled: number;
  instruction_mode: string | null;
  is_asynchronous: boolean;
  section_requisites: string | null;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export interface SectionInstructorsTable {
  id: Generated<number>;
  section_id: number;
  instructor_name: string;
  created_at: ColumnType<Date, never, never>;
}

export interface SectionMeetingsTable {
  id: Generated<number>;
  section_id: number;
  meeting_number: number | null;
  section_number: string | null;
  meeting_type: string;
  meeting_days: string | null;
  start_time: string | null;
  end_time: string | null;
  building_name: string | null;
  room: string | null;
  location: string | null;
  monday_meeting_start: number | null;
  monday_meeting_end: number | null;
  tuesday_meeting_start: number | null;
  tuesday_meeting_end: number | null;
  wednesday_meeting_start: number | null;
  wednesday_meeting_end: number | null;
  thursday_meeting_start: number | null;
  thursday_meeting_end: number | null;
  friday_meeting_start: number | null;
  friday_meeting_end: number | null;
  created_at: ColumnType<Date, never, never>;
}

export interface RmpCleanedTable {
  id: Generated<number>;
  full_name: string;
  avg_rating: number | null;
  avg_difficulty: number | null;
  num_ratings: number;
  would_take_again_percent: number | null;
  legacy_id: string | null;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export interface MadgradesCourseGradesTable {
  id: Generated<number>;
  course_name: string;
  course_uuid: string | null;
  median_grade: string | null;
  a_percentage: number | null;
  ab_percentage: number | null;
  b_percentage: number | null;
  bc_percentage: number | null;
  c_percentage: number | null;
  d_percentage: number | null;
  f_percentage: number | null;
  cumulative_gpa: number | null;
  most_recent_gpa: number | null;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

export interface CourseSubscriptionsTable {
  id: Generated<number>;
  email: string;
  course_id: number;
  created_at: ColumnType<Date, never, never>;
}

export interface SectionSubscriptionsTable {
  id: Generated<number>;
  email: string;
  section_id: number;
  created_at: ColumnType<Date, never, never>;
}

export interface SubjectsTable {
  subject_code: string;
  footnotes: string | null;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

// ── Kysely Database interface ──

export interface Database {
  subjects: SubjectsTable;
  courses: CoursesTable;
  sections: SectionsTable;
  section_instructors: SectionInstructorsTable;
  section_meetings: SectionMeetingsTable;
  rmp_cleaned: RmpCleanedTable;
  madgrades_course_grades: MadgradesCourseGradesTable;
  course_subscriptions: CourseSubscriptionsTable;
  section_subscriptions: SectionSubscriptionsTable;
}

// ── API Response types ──

export interface InstructorResponse {
  name: string;
  rmp_instructor_id: string | null;
  avg_rating: number | null;
  avg_difficulty: number | null;
  num_ratings: number | null;
  would_take_again_percent: number | null;
}

export interface MeetingResponse {
  meeting_number: number | null;
  section_number: string | null;
  meeting_days: string | null;
  meeting_type: string;
  start_time: string | null;
  end_time: string | null;
  building_name: string | null;
  room: string | null;
  location: string | null;
  monday_meeting_start: number | null;
  monday_meeting_end: number | null;
  tuesday_meeting_start: number | null;
  tuesday_meeting_end: number | null;
  wednesday_meeting_start: number | null;
  wednesday_meeting_end: number | null;
  thursday_meeting_start: number | null;
  thursday_meeting_end: number | null;
  friday_meeting_start: number | null;
  friday_meeting_end: number | null;
}

export interface SectionResponse {
  section_id: string;
  section_uuid: string;
  status: string;
  available_seats: number;
  waitlist_total: number;
  capacity: number;
  enrolled: number;
  instruction_mode: string | null;
  is_asynchronous: boolean;
  section_avg_rating: number | null;
  section_avg_difficulty: number | null;
  section_total_ratings: number;
  section_avg_would_take_again: number | null;
  section_requisites: string | null;
  instructors: InstructorResponse[];
  meetings: MeetingResponse[];
}

export interface CourseResponse {
  course_uuid: string;
  course_id: string;
  subject_code: string;
  course_designation: string;
  full_course_designation: string | null;
  course_title: string | null;
  catalog_number: number | null;
  course_description: string | null;
  enrollment_prerequisites: string | null;
  minimum_credits: number | null;
  maximum_credits: number | null;
  letters_and_science_credits: boolean;
  ethnic_studies: boolean;
  social_science: boolean;
  humanities: boolean;
  biological_science: boolean;
  physical_science: boolean;
  natural_science: boolean;
  literature: boolean;
  general_education: string | null;
  level: string | null;
  typically_offered: string | null;
  workplace_experience_description: string | null;
  grading_basis_description: string | null;
  open_to_first_year: boolean;
  repeatable_for_credit: boolean;
  cumulative_gpa: number | null;
  most_recent_gpa: number | null;
  median_grade: string | null;
  a_percent: number | null;
  ab_percent: number | null;
  b_percent: number | null;
  bc_percent: number | null;
  c_percent: number | null;
  d_percent: number | null;
  f_percent: number | null;
  madgrades_course_uuid: string | null;
  sections: SectionResponse[];
}

export interface ApiQueryResponse {
  data: CourseResponse[];
  count: number;
  total_count: number;
  has_more: boolean;
}

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
