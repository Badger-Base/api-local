import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDb, type TestDb, type TestFixture } from "./setup.ts";
import { createPgApp } from "../pg/routes/courses.ts";

let testDb: TestDb;
let app: ReturnType<typeof createPgApp>;

const API_KEY = "test-key";

const crosslistFixture: TestFixture = {
  subjects: [
    { subject_code: "BOTANY", footnotes: null },
    { subject_code: "ZOOLOGY", footnotes: null },
    { subject_code: "ENVIR ST", footnotes: null },
    { subject_code: "ENGL", footnotes: null },
    { subject_code: "COMP SCI", footnotes: null },
  ],

  courses: [
    {
      id: 1, course_id: "BIO516", course_uuid: "uuid-bot516",
      subject_code: "BOTANY", course_designation: "BOTANY 516",
      full_course_designation: "BOTANY 516 — Ecology",
      course_title: "Ecology", catalog_number: 516,
      course_description: "Ecology cross-listed",
      enrollment_prerequisites: "None",
      minimum_credits: 3, maximum_credits: 3,
      letters_and_science_credits: true,
      ethnic_studies: false, social_science: false, humanities: false,
      biological_science: true, physical_science: false,
      natural_science: false, literature: false,
      general_education: "QR-B", level: "Intermediate",
      typically_offered: "Fall",
      workplace_experience_description: null,
      grading_basis_description: "A-F",
      open_to_first_year: false, repeatable_for_credit: false,
    },
    {
      id: 2, course_id: "BIO516", course_uuid: "uuid-zoo516",
      subject_code: "ZOOLOGY", course_designation: "ZOOLOGY 516",
      full_course_designation: "ZOOLOGY 516 — Ecology",
      course_title: "Ecology", catalog_number: 516,
      course_description: "Ecology cross-listed",
      enrollment_prerequisites: "None",
      minimum_credits: 3, maximum_credits: 3,
      letters_and_science_credits: true,
      ethnic_studies: false, social_science: false, humanities: false,
      biological_science: true, physical_science: false,
      natural_science: false, literature: false,
      general_education: "QR-B", level: "Intermediate",
      typically_offered: "Fall",
      workplace_experience_description: null,
      grading_basis_description: "A-F",
      open_to_first_year: false, repeatable_for_credit: false,
    },
    {
      id: 3, course_id: "BIO516", course_uuid: "uuid-envst516",
      subject_code: "ENVIR ST", course_designation: "ENVIR ST 516",
      full_course_designation: "ENVIR ST 516 — Ecology",
      course_title: "Ecology", catalog_number: 516,
      course_description: "Ecology cross-listed",
      enrollment_prerequisites: "None",
      minimum_credits: 3, maximum_credits: 3,
      letters_and_science_credits: true,
      ethnic_studies: false, social_science: false, humanities: false,
      biological_science: true, physical_science: false,
      natural_science: false, literature: false,
      general_education: "QR-B", level: "Intermediate",
      typically_offered: "Fall",
      workplace_experience_description: null,
      grading_basis_description: "A-F",
      open_to_first_year: false, repeatable_for_credit: false,
    },
    {
      id: 4, course_id: "ENGL418", course_uuid: "uuid-engl418",
      subject_code: "ENGL", course_designation: "ENGL 418",
      full_course_designation: "ENGL 418 — Technical Writing",
      course_title: "Technical Writing", catalog_number: 418,
      course_description: "Technical writing course",
      enrollment_prerequisites: "None",
      minimum_credits: 3, maximum_credits: 3,
      letters_and_science_credits: true,
      ethnic_studies: false, social_science: false, humanities: true,
      biological_science: false, physical_science: false,
      natural_science: false, literature: false,
      general_education: "QR-B", level: "Advanced",
      typically_offered: "Spring",
      workplace_experience_description: null,
      grading_basis_description: "A-F",
      open_to_first_year: false, repeatable_for_credit: false,
    },
    {
      id: 5, course_id: "CS200", course_uuid: "uuid-cs200",
      subject_code: "COMP SCI", course_designation: "COMP SCI 200",
      full_course_designation: "COMP SCI 200 — Programming I",
      course_title: "Programming I", catalog_number: 200,
      course_description: "Intro to programming",
      enrollment_prerequisites: "None",
      minimum_credits: 3, maximum_credits: 3,
      letters_and_science_credits: true,
      ethnic_studies: false, social_science: false, humanities: false,
      biological_science: false, physical_science: false,
      natural_science: false, literature: false,
      general_education: null, level: "Elementary",
      typically_offered: "Fall, Spring",
      workplace_experience_description: null,
      grading_basis_description: "A-F",
      open_to_first_year: true, repeatable_for_credit: false,
    },
  ],

  sections: [
    { id: 1, section_id: "LEC001", section_uuid: "suuid-cl-1", course_ref: 1, status: "OPEN", available_seats: 30, waitlist_total: 0, capacity: 50, enrolled: 20, instruction_mode: "In Person", is_asynchronous: false, section_requisites: null },
    { id: 2, section_id: "LEC001", section_uuid: "suuid-cl-2", course_ref: 2, status: "OPEN", available_seats: 30, waitlist_total: 0, capacity: 50, enrolled: 20, instruction_mode: "In Person", is_asynchronous: false, section_requisites: null },
    { id: 3, section_id: "LEC001", section_uuid: "suuid-cl-3", course_ref: 3, status: "OPEN", available_seats: 30, waitlist_total: 0, capacity: 50, enrolled: 20, instruction_mode: "In Person", is_asynchronous: false, section_requisites: null },
    { id: 4, section_id: "LEC001", section_uuid: "suuid-cl-4", course_ref: 4, status: "OPEN", available_seats: 10, waitlist_total: 0, capacity: 40, enrolled: 30, instruction_mode: "In Person", is_asynchronous: false, section_requisites: null },
    { id: 5, section_id: "LEC001", section_uuid: "suuid-cl-5", course_ref: 5, status: "OPEN", available_seats: 50, waitlist_total: 0, capacity: 200, enrolled: 150, instruction_mode: "In Person", is_asynchronous: false, section_requisites: null },
  ],

  section_instructors: [
    { section_ref: 1, instructor_name: "Eco Prof" },
    { section_ref: 2, instructor_name: "Eco Prof" },
    { section_ref: 3, instructor_name: "Eco Prof" },
    { section_ref: 4, instructor_name: "Writing Prof" },
    { section_ref: 5, instructor_name: "CS Prof" },
  ],

  section_meetings: [
    { section_id: 1, meeting_number: 1, section_number: "001", meeting_type: "LEC", meeting_days: "MWF", start_time: "10:00 AM", end_time: "10:50 AM", building_name: "Birge", room: "350", location: "Birge 350", monday_meeting_start: 36000000, monday_meeting_end: 39000000, tuesday_meeting_start: null, tuesday_meeting_end: null, wednesday_meeting_start: 36000000, wednesday_meeting_end: 39000000, thursday_meeting_start: null, thursday_meeting_end: null, friday_meeting_start: 36000000, friday_meeting_end: 39000000 },
    { section_id: 2, meeting_number: 1, section_number: "001", meeting_type: "LEC", meeting_days: "MWF", start_time: "10:00 AM", end_time: "10:50 AM", building_name: "Birge", room: "350", location: "Birge 350", monday_meeting_start: 36000000, monday_meeting_end: 39000000, tuesday_meeting_start: null, tuesday_meeting_end: null, wednesday_meeting_start: 36000000, wednesday_meeting_end: 39000000, thursday_meeting_start: null, thursday_meeting_end: null, friday_meeting_start: 36000000, friday_meeting_end: 39000000 },
    { section_id: 3, meeting_number: 1, section_number: "001", meeting_type: "LEC", meeting_days: "MWF", start_time: "10:00 AM", end_time: "10:50 AM", building_name: "Birge", room: "350", location: "Birge 350", monday_meeting_start: 36000000, monday_meeting_end: 39000000, tuesday_meeting_start: null, tuesday_meeting_end: null, wednesday_meeting_start: 36000000, wednesday_meeting_end: 39000000, thursday_meeting_start: null, thursday_meeting_end: null, friday_meeting_start: 36000000, friday_meeting_end: 39000000 },
    { section_id: 5, meeting_number: 1, section_number: "001", meeting_type: "LEC", meeting_days: "MWF", start_time: "9:55 AM", end_time: "10:45 AM", building_name: "CS", room: "1240", location: "CS 1240", monday_meeting_start: 35700000, monday_meeting_end: 38700000, tuesday_meeting_start: null, tuesday_meeting_end: null, wednesday_meeting_start: 35700000, wednesday_meeting_end: 38700000, thursday_meeting_start: null, thursday_meeting_end: null, friday_meeting_start: 35700000, friday_meeting_end: 38700000 },
  ],

  rmp_cleaned: [
    { id: 1, full_name: "Eco Prof", avg_rating: 4.2, avg_difficulty: 3.0, num_ratings: 60, would_take_again_percent: 85.0, legacy_id: "rmp-eco" },
    { id: 2, full_name: "Writing Prof", avg_rating: 3.5, avg_difficulty: 2.5, num_ratings: 40, would_take_again_percent: 70.0, legacy_id: "rmp-write" },
    { id: 3, full_name: "CS Prof", avg_rating: 4.0, avg_difficulty: 3.5, num_ratings: 100, would_take_again_percent: 80.0, legacy_id: "rmp-cs" },
  ],

  madgrades_course_grades: [
    { id: 1, course_name: "BOTANY 516", course_uuid: "mg-bot516", median_grade: "AB", a_percentage: 0.30, ab_percentage: 0.25, b_percentage: 0.20, bc_percentage: 0.12, c_percentage: 0.08, d_percentage: 0.03, f_percentage: 0.02, cumulative_gpa: 3.20, most_recent_gpa: 3.30 },
    { id: 2, course_name: "ZOOLOGY 516", course_uuid: "mg-zoo516", median_grade: "AB", a_percentage: 0.30, ab_percentage: 0.25, b_percentage: 0.20, bc_percentage: 0.12, c_percentage: 0.08, d_percentage: 0.03, f_percentage: 0.02, cumulative_gpa: 3.20, most_recent_gpa: 3.30 },
    { id: 3, course_name: "ENVIR ST 516", course_uuid: "mg-envst516", median_grade: "AB", a_percentage: 0.30, ab_percentage: 0.25, b_percentage: 0.20, bc_percentage: 0.12, c_percentage: 0.08, d_percentage: 0.03, f_percentage: 0.02, cumulative_gpa: 3.20, most_recent_gpa: 3.30 },
    // No madgrades entry for ENGL 418 — tests the INNER JOIN drop
    { id: 4, course_name: "COMP SCI 200", course_uuid: "mg-cs200", median_grade: "AB", a_percentage: 0.35, ab_percentage: 0.25, b_percentage: 0.20, bc_percentage: 0.10, c_percentage: 0.05, d_percentage: 0.03, f_percentage: 0.02, cumulative_gpa: 3.40, most_recent_gpa: 3.50 },
  ],
};

beforeAll(async () => {
  testDb = await setupTestDb();
  await testDb.seed(crosslistFixture);

  const mockCache = {
    get: async () => null,
    set: async () => {},
    bustAll: async () => {},
  };

  app = createPgApp({ db: testDb.db, cache: mockCache, apiKey: API_KEY });
});

afterAll(async () => {
  await testDb.teardown();
});

function authHeaders() {
  return { "x-api-key": API_KEY };
}

async function query(params: Record<string, string> = {}) {
  if (!params.limit) params.limit = "50";
  const qs = new URLSearchParams(params).toString();
  const res = await app.request(`/api/query?${qs}`, { headers: authHeaders() });
  return res.json();
}

describe("gen_ed filter with cross-listings", () => {
  it("returns all cross-listed courses separately for gen_ed=QR-B", async () => {
    const body = await query({ gen_ed: "QR-B" });
    const designations = body.data.map((c: any) => c.course_designation).sort();
    expect(designations).toContain("BOTANY 516");
    expect(designations).toContain("ZOOLOGY 516");
    expect(designations).toContain("ENVIR ST 516");
  });

  it("cross-listed courses each have their own course_uuid", async () => {
    const body = await query({ gen_ed: "QR-B" });
    const uuids = body.data.map((c: any) => c.course_uuid);
    const uniqueUuids = new Set(uuids);
    expect(uniqueUuids.size).toBe(uuids.length);
  });

  it("drops courses without madgrades match (INNER JOIN)", async () => {
    const body = await query({ gen_ed: "QR-B" });
    const designations = body.data.map((c: any) => c.course_designation);
    expect(designations).not.toContain("ENGL 418");
  });

  it("total_count reflects only courses with madgrades matches", async () => {
    const body = await query({ gen_ed: "QR-B" });
    expect(body.total_count).toBe(3);
  });

  it("non-gen_ed courses are excluded by gen_ed filter", async () => {
    const body = await query({ gen_ed: "QR-B" });
    const designations = body.data.map((c: any) => c.course_designation);
    expect(designations).not.toContain("COMP SCI 200");
  });

  it("gen_ed filter with no matches returns empty", async () => {
    const body = await query({ gen_ed: "QR-A" });
    expect(body.data.length).toBe(0);
    expect(body.total_count).toBe(0);
  });

  it("cross-listed courses share the same course_id", async () => {
    const body = await query({ gen_ed: "QR-B" });
    const courseIds = body.data.map((c: any) => c.course_id);
    const bot = body.data.find((c: any) => c.course_designation === "BOTANY 516");
    const zoo = body.data.find((c: any) => c.course_designation === "ZOOLOGY 516");
    const envst = body.data.find((c: any) => c.course_designation === "ENVIR ST 516");
    expect(bot.course_id).toBe(zoo.course_id);
    expect(bot.course_id).toBe(envst.course_id);
  });

  it("each cross-listed course has its own sections", async () => {
    const body = await query({ gen_ed: "QR-B" });
    for (const course of body.data) {
      expect(course.sections.length).toBeGreaterThan(0);
    }
  });
});
