import { sql, type Kysely } from "kysely";
import type {
  Database,
  CourseResponse,
  SectionResponse,
  InstructorResponse,
  MeetingResponse,
} from "./types.ts";

export async function hydrateCourses(
  db: Kysely<Database>,
  courseIds: number[]
): Promise<CourseResponse[]> {
  if (courseIds.length === 0) return [];

  // 1. Courses + madgrades
  const courses = await db
    .selectFrom("courses")
    .leftJoin(
      "madgrades_course_grades",
      "madgrades_course_grades.course_name",
      "courses.course_designation"
    )
    .select([
      "courses.id",
      "courses.course_uuid",
      "courses.course_id",
      "courses.subject_code",
      "courses.course_designation",
      "courses.full_course_designation",
      "courses.course_title",
      "courses.catalog_number",
      "courses.course_description",
      "courses.enrollment_prerequisites",
      "courses.minimum_credits",
      "courses.maximum_credits",
      "courses.letters_and_science_credits",
      "courses.ethnic_studies",
      "courses.social_science",
      "courses.humanities",
      "courses.biological_science",
      "courses.physical_science",
      "courses.natural_science",
      "courses.literature",
      "courses.general_education",
      "courses.level",
      "courses.typically_offered",
      "courses.workplace_experience_description",
      "courses.repeatable_for_credit",
      "madgrades_course_grades.cumulative_gpa",
      "madgrades_course_grades.most_recent_gpa",
      "madgrades_course_grades.median_grade",
      "madgrades_course_grades.a_percentage",
      "madgrades_course_grades.ab_percentage",
      "madgrades_course_grades.b_percentage",
      "madgrades_course_grades.bc_percentage",
      "madgrades_course_grades.c_percentage",
      "madgrades_course_grades.d_percentage",
      "madgrades_course_grades.f_percentage",
      "madgrades_course_grades.course_uuid as madgrades_course_uuid",
    ])
    .where("courses.id", "in", courseIds)
    .orderBy("courses.catalog_number", "asc")
    .execute();

  const courseIdList = courses.map((c) => c.id);

  // 2. Sections with RMP averages (weighted by num_ratings)
  const sections =
    courseIdList.length > 0
      ? await db
          .selectFrom("sections")
          .leftJoin(
            "section_instructors",
            "section_instructors.section_id",
            "sections.id"
          )
          .leftJoin(
            "rmp_cleaned",
            "rmp_cleaned.full_name",
            "section_instructors.instructor_name"
          )
          .select([
            "sections.id",
            "sections.course_ref",
            "sections.status",
            "sections.available_seats",
            "sections.waitlist_total",
            "sections.capacity",
            "sections.enrolled",
            "sections.instruction_mode",
            "sections.is_asynchronous",
            "sections.section_requisites",
            sql<string | null>`ROUND(AVG(rmp_cleaned.avg_rating)::numeric, 2)`.as(
              "section_avg_rating"
            ),
            sql<string | null>`ROUND(AVG(rmp_cleaned.avg_difficulty)::numeric, 2)`.as(
              "section_avg_difficulty"
            ),
            sql<string>`COALESCE(SUM(rmp_cleaned.num_ratings), 0)`.as(
              "section_total_ratings"
            ),
            sql<string | null>`ROUND(AVG(rmp_cleaned.would_take_again_percent)::numeric, 2)`.as(
              "section_avg_would_take_again"
            ),
          ])
          .where("sections.course_ref", "in", courseIdList)
          .groupBy([
            "sections.id",
            "sections.course_ref",
            "sections.status",
            "sections.available_seats",
            "sections.waitlist_total",
            "sections.capacity",
            "sections.enrolled",
            "sections.instruction_mode",
            "sections.is_asynchronous",
            "sections.section_requisites",
          ])
          .orderBy("sections.course_ref")
          .orderBy("sections.status", "desc")
          .execute()
      : [];

  const sectionIds = sections.map((s) => s.id);

  // 3. Instructors + meetings for those sections (two parallel queries)
  const [instructors, meetings] = await Promise.all([
    sectionIds.length > 0
      ? db
          .selectFrom("section_instructors")
          .leftJoin(
            "rmp_cleaned",
            "rmp_cleaned.full_name",
            "section_instructors.instructor_name"
          )
          .select([
            "section_instructors.section_id",
            "section_instructors.instructor_name as name",
            "rmp_cleaned.legacy_id as rmp_instructor_id",
            "rmp_cleaned.avg_rating",
            "rmp_cleaned.avg_difficulty",
            "rmp_cleaned.num_ratings",
            "rmp_cleaned.would_take_again_percent",
          ])
          .where("section_instructors.section_id", "in", sectionIds)
          .orderBy("section_instructors.instructor_name")
          .execute()
      : Promise.resolve([]),
    sectionIds.length > 0
      ? db
          .selectFrom("section_meetings")
          .select([
            "section_meetings.section_id",
            "section_meetings.meeting_number",
            "section_meetings.section_number",
            "section_meetings.meeting_type",
            "section_meetings.meeting_days",
            "section_meetings.start_time",
            "section_meetings.end_time",
            "section_meetings.building_name",
            "section_meetings.room",
            "section_meetings.location",
          ])
          .where("section_meetings.section_id", "in", sectionIds)
          .orderBy("section_meetings.meeting_number")
          .execute()
      : Promise.resolve([]),
  ]);

  // Group instructors and meetings by section_id
  const instructorsBySection = new Map<number, InstructorResponse[]>();
  for (const inst of instructors) {
    const list = instructorsBySection.get(inst.section_id) ?? [];
    list.push({
      name: inst.name,
      rmp_instructor_id: inst.rmp_instructor_id ?? null,
      avg_rating: inst.avg_rating != null ? Number(inst.avg_rating) : null,
      avg_difficulty:
        inst.avg_difficulty != null ? Number(inst.avg_difficulty) : null,
      num_ratings: inst.num_ratings != null ? Number(inst.num_ratings) : null,
      would_take_again_percent:
        inst.would_take_again_percent != null
          ? Number(inst.would_take_again_percent)
          : null,
    });
    instructorsBySection.set(inst.section_id, list);
  }

  const meetingsBySection = new Map<number, MeetingResponse[]>();
  for (const mtg of meetings) {
    const list = meetingsBySection.get(mtg.section_id) ?? [];
    list.push({
      meeting_number: mtg.meeting_number,
      section_number: mtg.section_number,
      meeting_type: mtg.meeting_type,
      meeting_days: mtg.meeting_days,
      start_time: mtg.start_time,
      end_time: mtg.end_time,
      building_name: mtg.building_name,
      room: mtg.room,
      location: mtg.location,
    });
    meetingsBySection.set(mtg.section_id, list);
  }

  // Assemble sections by course
  const sectionsByCourse = new Map<number, SectionResponse[]>();
  for (const sec of sections) {
    const list = sectionsByCourse.get(sec.course_ref) ?? [];
    list.push({
      section_id: sec.id,
      status: sec.status,
      available_seats: sec.available_seats,
      waitlist_total: sec.waitlist_total,
      capacity: sec.capacity,
      enrolled: sec.enrolled,
      instruction_mode: sec.instruction_mode,
      is_asynchronous: sec.is_asynchronous,
      section_avg_rating:
        sec.section_avg_rating != null ? Number(sec.section_avg_rating) : null,
      section_avg_difficulty:
        sec.section_avg_difficulty != null
          ? Number(sec.section_avg_difficulty)
          : null,
      section_total_ratings: Number(sec.section_total_ratings) || 0,
      section_avg_would_take_again:
        sec.section_avg_would_take_again != null
          ? Number(sec.section_avg_would_take_again)
          : null,
      section_requisites: sec.section_requisites,
      instructors: instructorsBySection.get(sec.id) ?? [],
      meetings: meetingsBySection.get(sec.id) ?? [],
    });
    sectionsByCourse.set(sec.course_ref, list);
  }

  // Assemble final response
  return courses.map(
    (c): CourseResponse => ({
      course_uuid: c.course_uuid,
      course_id: c.course_id,
      subject_code: c.subject_code,
      course_designation: c.course_designation,
      full_course_designation: c.full_course_designation,
      course_title: c.course_title,
      catalog_number: c.catalog_number,
      course_description: c.course_description,
      enrollment_prerequisites: c.enrollment_prerequisites,
      minimum_credits: c.minimum_credits,
      maximum_credits: c.maximum_credits,
      letters_and_science_credits: c.letters_and_science_credits,
      ethnic_studies: c.ethnic_studies,
      social_science: c.social_science,
      humanities: c.humanities,
      biological_science: c.biological_science,
      physical_science: c.physical_science,
      natural_science: c.natural_science,
      literature: c.literature,
      general_education: c.general_education,
      level: c.level,
      typically_offered: c.typically_offered,
      workplace_experience_description: c.workplace_experience_description,
      repeatable_for_credit: c.repeatable_for_credit,
      cumulative_gpa: c.cumulative_gpa != null ? Number(c.cumulative_gpa) : null,
      most_recent_gpa:
        c.most_recent_gpa != null ? Number(c.most_recent_gpa) : null,
      median_grade: c.median_grade,
      a_percent: c.a_percentage != null ? Number(c.a_percentage) : null,
      ab_percent: c.ab_percentage != null ? Number(c.ab_percentage) : null,
      b_percent: c.b_percentage != null ? Number(c.b_percentage) : null,
      bc_percent: c.bc_percentage != null ? Number(c.bc_percentage) : null,
      c_percent: c.c_percentage != null ? Number(c.c_percentage) : null,
      d_percent: c.d_percentage != null ? Number(c.d_percentage) : null,
      f_percent: c.f_percentage != null ? Number(c.f_percentage) : null,
      madgrades_course_uuid: c.madgrades_course_uuid,
      sections: sectionsByCourse.get(c.id) ?? [],
    })
  );
}
