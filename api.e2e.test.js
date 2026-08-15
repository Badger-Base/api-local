import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "./api.js";

// ─── SQLite ↔ mysql2 adapter ───────────────────────────────────────

function rewriteMysqlToSqlite(sql) {
  return sql
    // GROUP_CONCAT(DISTINCT x ORDER BY x SEPARATOR ', ') → GROUP_CONCAT(DISTINCT x)
    // SQLite DISTINCT aggregates only accept one argument; default separator is ','
    .replace(
      /GROUP_CONCAT\(\s*DISTINCT\s+([\w.]+)\s+ORDER\s+BY\s+[\w.]+(?:\s+(?:ASC|DESC))?\s+SEPARATOR\s+'[^']*'\s*\)/gi,
      "GROUP_CONCAT(DISTINCT $1)"
    )
    // CAST(... AS UNSIGNED) → CAST(... AS INTEGER)
    .replace(/CAST\(([^)]+?)\s+AS\s+UNSIGNED\)/gi, "CAST($1 AS INTEGER)")
    // CAST(... as FLOAT) / CAST(... AS FLOAT) → CAST(... AS REAL)
    .replace(/CAST\(([^)]+?)\s+as\s+FLOAT\)/g, "CAST($1 AS REAL)")
    .replace(/CAST\(([^)]+?)\s+AS\s+FLOAT\)/g, "CAST($1 AS REAL)");
}

function createSqlitePool(db) {
  return {
    execute(sql, params = []) {
      const rewritten = rewriteMysqlToSqlite(sql);
      const isRead =
        rewritten.trimStart().startsWith("SELECT") ||
        rewritten.trimStart().startsWith("WITH") ||
        rewritten.trimStart().startsWith("select") ||
        rewritten.trimStart().startsWith("with");

      if (isRead) {
        const stmt = db.prepare(rewritten);
        const rows = stmt.all(...params);
        return Promise.resolve([rows, []]);
      }
      const stmt = db.prepare(rewritten);
      const info = stmt.run(...params);
      return Promise.resolve([{ affectedRows: info.changes }, []]);
    },
  };
}

// ─── Redis mock (always cache-miss) ────────────────────────────────

function createMockRedis() {
  const sets = [];
  return {
    get: () => Promise.resolve(null),
    set: (k, v) => {
      sets.push({ k, v });
      return Promise.resolve("OK");
    },
    _sets: sets,
  };
}

// ─── Constants ─────────────────────────────────────────────────────

const API_KEY = "test-key-e2e";

const COURSES = [
  { id: "c1", uuid: "uuid-c1", designation: "COMP SCI 200", full: "COMP SCI 200", title: "Data Structures", subject: "COMP SCI", catalog: 200, minCr: 3, maxCr: 3, level: "Intermediate", prereq: "Sophomore standing", ethnic: null, social: null, hum: null, bio: null, phys: null, nat: null, lit: null, genEd: null, ls: null, gpa: 3.4, recentGpa: 3.35, aPct: 35, median: "B" },
  { id: "c2", uuid: "uuid-c2", designation: "MATH 221", full: "MATH 221", title: "Calculus I", subject: "MATH", catalog: 221, minCr: 5, maxCr: 5, level: "Elementary", prereq: "None", ethnic: null, social: null, hum: null, bio: null, phys: null, nat: "N", lit: null, genEd: null, ls: null, gpa: 2.8, recentGpa: 2.75, aPct: 18, median: "BC" },
  { id: "c3", uuid: "uuid-c3", designation: "PSYCH 202", full: "PSYCH 202", title: "Intro Psychology", subject: "PSYCH", catalog: 202, minCr: 3, maxCr: 3, level: "Elementary", prereq: "None", ethnic: null, social: "S", hum: null, bio: null, phys: null, nat: null, lit: null, genEd: null, ls: null, gpa: 3.6, recentGpa: 3.55, aPct: 40, median: "AB" },
  { id: "c4", uuid: "uuid-c4", designation: "ENGLISH 150", full: "ENGLISH 150", title: "Intro Literature", subject: "ENGLISH", catalog: 150, minCr: 3, maxCr: 3, level: "Elementary", prereq: "None", ethnic: null, social: null, hum: "H", bio: null, phys: null, nat: null, lit: "L", genEd: null, ls: null, gpa: 3.7, recentGpa: 3.65, aPct: 42, median: "AB" },
  { id: "c5", uuid: "uuid-c5", designation: "BIOLOGY 151", full: "BIOLOGY 151", title: "Intro Biology", subject: "BIOLOGY", catalog: 151, minCr: 3, maxCr: 3, level: "Elementary", prereq: "None", ethnic: null, social: null, hum: null, bio: "B", phys: null, nat: null, lit: null, genEd: null, ls: null, gpa: 3.1, recentGpa: 3.05, aPct: 22, median: "B" },
  { id: "c6", uuid: "uuid-c6", designation: "PHYSICS 201", full: "PHYSICS 201", title: "General Physics", subject: "PHYSICS", catalog: 201, minCr: 5, maxCr: 5, level: "Intermediate", prereq: "Sophomore standing", ethnic: null, social: null, hum: null, bio: null, phys: "P", nat: null, lit: null, genEd: null, ls: "C", gpa: 2.9, recentGpa: 2.85, aPct: 15, median: "B" },
  { id: "c7", uuid: "uuid-c7", designation: "ETHNIC ST 101", full: "ETHNIC ST 101", title: "Intro Ethnic Studies", subject: "ETHNIC ST", catalog: 101, minCr: 3, maxCr: 3, level: "Elementary", prereq: "None", ethnic: "ETHNIC ST", social: null, hum: null, bio: null, phys: null, nat: null, lit: null, genEd: null, ls: null, gpa: 3.8, recentGpa: 3.75, aPct: 50, median: "AB" },
  { id: "c8", uuid: "uuid-c8", designation: "COMP SCI 577", full: "COMP SCI 577", title: "Algorithms", subject: "COMP SCI", catalog: 577, minCr: 3, maxCr: 3, level: "Advanced", prereq: "Junior standing", ethnic: null, social: null, hum: null, bio: null, phys: null, nat: null, lit: null, genEd: null, ls: null, gpa: 3.0, recentGpa: 2.95, aPct: 20, median: "B" },
  { id: "c9", uuid: "uuid-c9", designation: "COMP SCI 640", full: "COMP SCI 640", title: "Networks", subject: "COMP SCI", catalog: 640, minCr: 3, maxCr: 3, level: "Advanced", prereq: "Senior standing", ethnic: null, social: null, hum: null, bio: null, phys: null, nat: null, lit: null, genEd: null, ls: null, gpa: 3.2, recentGpa: 3.15, aPct: 25, median: "B" },
  { id: "c10", uuid: "uuid-c10", designation: "MUSIC 113", full: "MUSIC 113", title: "Music Theory", subject: "MUSIC", catalog: 113, minCr: 2, maxCr: 2, level: "Elementary", prereq: "None", ethnic: null, social: null, hum: "H", bio: null, phys: null, nat: null, lit: null, genEd: null, ls: null, gpa: 3.9, recentGpa: 3.85, aPct: 55, median: "A" },
  { id: "c11", uuid: "uuid-c11", designation: "COMP SCI 300", full: "COMP SCI 300", title: "Programming II", subject: "COMP SCI", catalog: 300, minCr: 3, maxCr: 3, level: "Intermediate", prereq: "CS 200", ethnic: null, social: null, hum: null, bio: null, phys: null, nat: null, lit: null, genEd: null, ls: null, gpa: 3.3, recentGpa: 3.25, aPct: 28, median: "B" },
  { id: "c12", uuid: "uuid-c12", designation: "GEN ED 100", full: "GEN ED 100", title: "Comm B Course", subject: "GEN ED", catalog: 100, minCr: 3, maxCr: 3, level: "Elementary", prereq: "None", ethnic: null, social: null, hum: null, bio: null, phys: null, nat: null, lit: null, genEd: "COM B", ls: null, gpa: 3.5, recentGpa: 3.45, aPct: 38, median: "AB" },
];

// ms from midnight helpers
const T = (h, m) => (h * 3600 + m * 60) * 1000;

const SECTIONS = [
  // c1 - two sections
  { sid: "sec-c1-001", usid: "usec-c1-001", cuuid: "uuid-c1", status: "OPEN", seats: 30, wl: 0, cap: 60, enrolled: 30, mode: "In Person", async: 0, requisites: null },
  { sid: "sec-c1-002", usid: "usec-c1-002", cuuid: "uuid-c1", status: "WAITLISTED", seats: 0, wl: 5, cap: 40, enrolled: 40, mode: "In Person", async: 0, requisites: null },
  // c2
  { sid: "sec-c2-001", usid: "usec-c2-001", cuuid: "uuid-c2", status: "OPEN", seats: 5, wl: 0, cap: 200, enrolled: 195, mode: "In Person", async: 0, requisites: null },
  // c3
  { sid: "sec-c3-001", usid: "usec-c3-001", cuuid: "uuid-c3", status: "CLOSED", seats: 0, wl: 0, cap: 300, enrolled: 300, mode: "In Person", async: 0, requisites: null },
  // c4
  { sid: "sec-c4-001", usid: "usec-c4-001", cuuid: "uuid-c4", status: "WAITLISTED", seats: 0, wl: 10, cap: 30, enrolled: 30, mode: "In Person", async: 0, requisites: null },
  // c5
  { sid: "sec-c5-001", usid: "usec-c5-001", cuuid: "uuid-c5", status: "OPEN", seats: 20, wl: 0, cap: 100, enrolled: 80, mode: "In Person", async: 0, requisites: null },
  // c6
  { sid: "sec-c6-001", usid: "usec-c6-001", cuuid: "uuid-c6", status: "OPEN", seats: 10, wl: 0, cap: 80, enrolled: 70, mode: "In Person", async: 0, requisites: null },
  // c7
  { sid: "sec-c7-001", usid: "usec-c7-001", cuuid: "uuid-c7", status: "OPEN", seats: 25, wl: 0, cap: 50, enrolled: 25, mode: "In Person", async: 0, requisites: null },
  // c8
  { sid: "sec-c8-001", usid: "usec-c8-001", cuuid: "uuid-c8", status: "OPEN", seats: 15, wl: 0, cap: 40, enrolled: 25, mode: "In Person", async: 0, requisites: null },
  // c9
  { sid: "sec-c9-001", usid: "usec-c9-001", cuuid: "uuid-c9", status: "OPEN", seats: 8, wl: 0, cap: 35, enrolled: 27, mode: "In Person", async: 0, requisites: null },
  // c10
  { sid: "sec-c10-001", usid: "usec-c10-001", cuuid: "uuid-c10", status: "OPEN", seats: 40, wl: 0, cap: 60, enrolled: 20, mode: "In Person", async: 0, requisites: null },
  // c11 - two sections: one online, one in-person DIS
  { sid: "sec-c11-001", usid: "usec-c11-001", cuuid: "uuid-c11", status: "OPEN", seats: 10, wl: 0, cap: 100, enrolled: 90, mode: "Online", async: 1, requisites: null },
  { sid: "sec-c11-301", usid: "usec-c11-301", cuuid: "uuid-c11", status: "OPEN", seats: 15, wl: 0, cap: 25, enrolled: 10, mode: "In Person", async: 0, requisites: null },
  // c12
  { sid: "sec-c12-001", usid: "usec-c12-001", cuuid: "uuid-c12", status: "OPEN", seats: 30, wl: 0, cap: 50, enrolled: 20, mode: "In Person", async: 0, requisites: null },
];

const INSTRUCTORS = [
  { sid: "sec-c1-001", name: "Alice Chen" },
  { sid: "sec-c1-002", name: "Bob Park" },
  { sid: "sec-c2-001", name: "Carol Davis" },
  { sid: "sec-c3-001", name: "Diana Evans" },
  { sid: "sec-c4-001", name: "Ed Foster" },
  { sid: "sec-c5-001", name: "Fay Green" },
  { sid: "sec-c6-001", name: "Gary Hill" },
  { sid: "sec-c7-001", name: "Holly Ito" },
  { sid: "sec-c8-001", name: "Ivan Jones" },
  { sid: "sec-c9-001", name: "Jan Kim" },
  { sid: "sec-c10-001", name: "Ken Lee" },
  { sid: "sec-c11-001", name: "Lily Ma" },
  // sec-c11-301 has no instructor
  { sid: "sec-c12-001", name: "Mike Ng" },
];

const RMP = [
  { name: "Alice Chen", rating: 4.2, diff: 2.5, num: 20, wta: 90, legacy: "rmp-alice" },
  { name: "Bob Park", rating: 3.8, diff: 3.0, num: 15, wta: 75, legacy: "rmp-bob" },
  { name: "Carol Davis", rating: 3.0, diff: 3.5, num: 12, wta: 60, legacy: "rmp-carol" },
  { name: "Diana Evans", rating: 4.5, diff: 2.0, num: 30, wta: 95, legacy: "rmp-diana" },
  { name: "Ed Foster", rating: 4.0, diff: 2.8, num: 18, wta: 80, legacy: "rmp-ed" },
  { name: "Fay Green", rating: 3.6, diff: 2.9, num: 10, wta: 70, legacy: "rmp-fay" },
  { name: "Gary Hill", rating: 3.2, diff: 3.2, num: 8, wta: 55, legacy: "rmp-gary" },
  { name: "Holly Ito", rating: 4.3, diff: 2.2, num: 25, wta: 92, legacy: "rmp-holly" },
  { name: "Ivan Jones", rating: 3.9, diff: 2.7, num: 14, wta: 78, legacy: "rmp-ivan" },
  { name: "Jan Kim", rating: 3.7, diff: 2.6, num: 11, wta: 72, legacy: "rmp-jan" },
  { name: "Ken Lee", rating: 4.1, diff: 2.4, num: 22, wta: 88, legacy: "rmp-ken" },
  { name: "Lily Ma", rating: 3.5, diff: 3.1, num: 9, wta: 65, legacy: "rmp-lily" },
  { name: "Mike Ng", rating: 3.4, diff: 3.3, num: 7, wta: 58, legacy: "rmp-mike" },
];

// Meetings: MWF courses set mon/wed/fri, TR courses set tue/thu
const MEETINGS = [
  // c1 LEC 001 - MWF 9:00-9:50
  { usid: "usec-c1-001", num: 1, days: "MWF", secNum: "001", start: "9:00 AM", end: "9:50 AM", type: "LEC", bldg: "CS Building", room: "1240", loc: "1210 W Dayton St", mon_s: T(9,0), mon_e: T(9,50), tue_s: null, tue_e: null, wed_s: T(9,0), wed_e: T(9,50), thu_s: null, thu_e: null, fri_s: T(9,0), fri_e: T(9,50) },
  // c1 LEC 002 - TR 11:00-12:15
  { usid: "usec-c1-002", num: 1, days: "TR", secNum: "002", start: "11:00 AM", end: "12:15 PM", type: "LEC", bldg: "Humanities", room: "3650", loc: "455 N Park St", mon_s: null, mon_e: null, tue_s: T(11,0), tue_e: T(12,15), wed_s: null, wed_e: null, thu_s: T(11,0), thu_e: T(12,15), fri_s: null, fri_e: null },
  // c2 - MWF 1:00-1:50
  { usid: "usec-c2-001", num: 1, days: "MWF", secNum: "001", start: "1:00 PM", end: "1:50 PM", type: "LEC", bldg: "Van Vleck", room: "B102", loc: "480 Lincoln Dr", mon_s: T(13,0), mon_e: T(13,50), tue_s: null, tue_e: null, wed_s: T(13,0), wed_e: T(13,50), thu_s: null, thu_e: null, fri_s: T(13,0), fri_e: T(13,50) },
  // c3 - TR 2:30-3:45
  { usid: "usec-c3-001", num: 1, days: "TR", secNum: "001", start: "2:30 PM", end: "3:45 PM", type: "LEC", bldg: "Psychology", room: "105", loc: "1202 W Johnson St", mon_s: null, mon_e: null, tue_s: T(14,30), tue_e: T(15,45), wed_s: null, wed_e: null, thu_s: T(14,30), thu_e: T(15,45), fri_s: null, fri_e: null },
  // c4 - MWF 11:00-11:50
  { usid: "usec-c4-001", num: 1, days: "MWF", secNum: "001", start: "11:00 AM", end: "11:50 AM", type: "LEC", bldg: "Humanities", room: "2650", loc: "455 N Park St", mon_s: T(11,0), mon_e: T(11,50), tue_s: null, tue_e: null, wed_s: T(11,0), wed_e: T(11,50), thu_s: null, thu_e: null, fri_s: T(11,0), fri_e: T(11,50) },
  // c5 - TR 9:30-10:45
  { usid: "usec-c5-001", num: 1, days: "TR", secNum: "001", start: "9:30 AM", end: "10:45 AM", type: "LEC", bldg: "Birge Hall", room: "350", loc: "430 Lincoln Dr", mon_s: null, mon_e: null, tue_s: T(9,30), tue_e: T(10,45), wed_s: null, wed_e: null, thu_s: T(9,30), thu_e: T(10,45), fri_s: null, fri_e: null },
  // c6 - MWF 2:00-2:50
  { usid: "usec-c6-001", num: 1, days: "MWF", secNum: "001", start: "2:00 PM", end: "2:50 PM", type: "LEC", bldg: "Chamberlin", room: "2241", loc: "1150 University Ave", mon_s: T(14,0), mon_e: T(14,50), tue_s: null, tue_e: null, wed_s: T(14,0), wed_e: T(14,50), thu_s: null, thu_e: null, fri_s: T(14,0), fri_e: T(14,50) },
  // c7 - TR 1:00-2:15
  { usid: "usec-c7-001", num: 1, days: "TR", secNum: "001", start: "1:00 PM", end: "2:15 PM", type: "LEC", bldg: "Ingraham", room: "120", loc: "1155 Observatory Dr", mon_s: null, mon_e: null, tue_s: T(13,0), tue_e: T(14,15), wed_s: null, wed_e: null, thu_s: T(13,0), thu_e: T(14,15), fri_s: null, fri_e: null },
  // c8 - MWF 10:00-10:50
  { usid: "usec-c8-001", num: 1, days: "MWF", secNum: "001", start: "10:00 AM", end: "10:50 AM", type: "LEC", bldg: "CS Building", room: "1240", loc: "1210 W Dayton St", mon_s: T(10,0), mon_e: T(10,50), tue_s: null, tue_e: null, wed_s: T(10,0), wed_e: T(10,50), thu_s: null, thu_e: null, fri_s: T(10,0), fri_e: T(10,50) },
  // c9 - TR 3:30-4:45
  { usid: "usec-c9-001", num: 1, days: "TR", secNum: "001", start: "3:30 PM", end: "4:45 PM", type: "LEC", bldg: "CS Building", room: "1221", loc: "1210 W Dayton St", mon_s: null, mon_e: null, tue_s: T(15,30), tue_e: T(16,45), wed_s: null, wed_e: null, thu_s: T(15,30), thu_e: T(16,45), fri_s: null, fri_e: null },
  // c10 - MWF 3:00-3:50
  { usid: "usec-c10-001", num: 1, days: "MWF", secNum: "001", start: "3:00 PM", end: "3:50 PM", type: "LEC", bldg: "Humanities", room: "1641", loc: "455 N Park St", mon_s: T(15,0), mon_e: T(15,50), tue_s: null, tue_e: null, wed_s: T(15,0), wed_e: T(15,50), thu_s: null, thu_e: null, fri_s: T(15,0), fri_e: T(15,50) },
  // c11 LEC 001 - ONLINE, no meeting times
  { usid: "usec-c11-001", num: 1, days: null, secNum: "001", start: null, end: null, type: "LEC", bldg: null, room: null, loc: "ONLINE", mon_s: null, mon_e: null, tue_s: null, tue_e: null, wed_s: null, wed_e: null, thu_s: null, thu_e: null, fri_s: null, fri_e: null },
  // c11 DIS 301 - F 2:00-2:50
  { usid: "usec-c11-301", num: 1, days: "F", secNum: "301", start: "2:00 PM", end: "2:50 PM", type: "DIS", bldg: "CS Building", room: "B240", loc: "1210 W Dayton St", mon_s: null, mon_e: null, tue_s: null, tue_e: null, wed_s: null, wed_e: null, thu_s: null, thu_e: null, fri_s: T(14,0), fri_e: T(14,50) },
  // c12 - TR 11:00-12:15
  { usid: "usec-c12-001", num: 1, days: "TR", secNum: "001", start: "11:00 AM", end: "12:15 PM", type: "LEC", bldg: "Education", room: "159", loc: "1000 Bascom Mall", mon_s: null, mon_e: null, tue_s: T(11,0), tue_e: T(12,15), wed_s: null, wed_e: null, thu_s: T(11,0), thu_e: T(12,15), fri_s: null, fri_e: null },
];

// ─── DB Setup ──────────────────────────────────────────────────────

let db, pool, redis, app;

beforeAll(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");

  // Create tables
  db.exec(`
    CREATE TABLE courses (
      course_id TEXT PRIMARY KEY, course_uuid TEXT NOT NULL, course_title TEXT,
      course_designation TEXT, full_course_designation TEXT, subject_code TEXT,
      catalog_number INTEGER, minimum_credits INTEGER, maximum_credits INTEGER,
      level TEXT, general_education TEXT, enrollment_prerequisites TEXT,
      letters_and_science_credits TEXT, course_description TEXT, ethnic_studies TEXT,
      social_science TEXT, humanities TEXT, biological_science TEXT,
      physical_science TEXT, natural_science TEXT, literature TEXT,
      typically_offered TEXT, workplace_experience_description TEXT,
      open_to_first_year TEXT, repeatable_for_credit TEXT, status TEXT
    );
    CREATE TABLE sections (
      section_id TEXT PRIMARY KEY, unique_section_id TEXT UNIQUE,
      course_uuid TEXT NOT NULL, status TEXT, available_seats INTEGER,
      waitlist_total INTEGER, capacity INTEGER, enrolled INTEGER,
      instruction_mode TEXT, is_asynchronous INTEGER DEFAULT 0,
      section_requisites TEXT
    );
    CREATE TABLE section_instructors (
      id INTEGER PRIMARY KEY AUTOINCREMENT, section_id TEXT NOT NULL,
      instructor_name TEXT
    );
    CREATE TABLE rmp_cleaned (
      id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT UNIQUE,
      avg_rating REAL, avg_difficulty REAL, num_ratings INTEGER,
      would_take_again_percent REAL, legacy_id TEXT
    );
    CREATE TABLE section_meetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, unique_section_id TEXT NOT NULL,
      meeting_number INTEGER, meeting_days TEXT, section_number TEXT,
      start_time TEXT, end_time TEXT, meeting_type TEXT, building_name TEXT,
      room TEXT, location TEXT,
      monday_meeting_start INTEGER, monday_meeting_end INTEGER,
      tuesday_meeting_start INTEGER, tuesday_meeting_end INTEGER,
      wednesday_meeting_start INTEGER, wednesday_meeting_end INTEGER,
      thursday_meeting_start INTEGER, thursday_meeting_end INTEGER,
      friday_meeting_start INTEGER, friday_meeting_end INTEGER
    );
    CREATE TABLE madgrades_course_grades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, course_name TEXT,
      course_uuid TEXT, median_grade TEXT,
      a_percentage REAL, ab_percentage REAL, b_percentage REAL,
      bc_percentage REAL, c_percentage REAL, d_percentage REAL,
      f_percentage REAL, cumulative_gpa REAL, most_recent_gpa REAL
    );
    CREATE TABLE subjects (
      subject_code TEXT PRIMARY KEY, footnotes TEXT
    );
  `);

  // Seed subjects
  const subjectCodes = [...new Set(COURSES.map((c) => c.subject))];
  const insertSubject = db.prepare("INSERT INTO subjects VALUES (?, ?)");
  for (const sc of subjectCodes) insertSubject.run(sc, null);

  // Seed courses
  const insertCourse = db.prepare(`INSERT INTO courses VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )`);
  for (const c of COURSES) {
    insertCourse.run(
      c.id, c.uuid, c.title, c.designation, c.full, c.subject,
      c.catalog, c.minCr, c.maxCr, c.level, c.genEd, c.prereq,
      c.ls, null, c.ethnic, c.social, c.hum, c.bio, c.phys, c.nat, c.lit,
      null, null, null, null, null
    );
  }

  // Seed madgrades
  const insertGrades = db.prepare(`INSERT INTO madgrades_course_grades
    (course_name, course_uuid, median_grade, a_percentage, ab_percentage, b_percentage,
     bc_percentage, c_percentage, d_percentage, f_percentage, cumulative_gpa, most_recent_gpa)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const c of COURSES) {
    insertGrades.run(c.designation, c.uuid, c.median, c.aPct, 20, 15, 10, 5, 3, 2, c.gpa, c.recentGpa);
  }

  // Seed sections
  const insertSection = db.prepare(`INSERT INTO sections VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const s of SECTIONS) {
    insertSection.run(s.sid, s.usid, s.cuuid, s.status, s.seats, s.wl, s.cap, s.enrolled, s.mode, s.async, s.requisites);
  }

  // Seed instructors
  const insertInstr = db.prepare(`INSERT INTO section_instructors (section_id, instructor_name) VALUES (?, ?)`);
  for (const i of INSTRUCTORS) insertInstr.run(i.sid, i.name);

  // Seed RMP
  const insertRmp = db.prepare(`INSERT INTO rmp_cleaned (full_name, avg_rating, avg_difficulty, num_ratings, would_take_again_percent, legacy_id) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const r of RMP) insertRmp.run(r.name, r.rating, r.diff, r.num, r.wta, r.legacy);

  // Seed meetings
  const insertMeeting = db.prepare(`INSERT INTO section_meetings
    (unique_section_id, meeting_number, meeting_days, section_number, start_time, end_time,
     meeting_type, building_name, room, location,
     monday_meeting_start, monday_meeting_end, tuesday_meeting_start, tuesday_meeting_end,
     wednesday_meeting_start, wednesday_meeting_end, thursday_meeting_start, thursday_meeting_end,
     friday_meeting_start, friday_meeting_end)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const m of MEETINGS) {
    insertMeeting.run(
      m.usid, m.num, m.days, m.secNum, m.start, m.end, m.type, m.bldg, m.room, m.loc,
      m.mon_s, m.mon_e, m.tue_s, m.tue_e, m.wed_s, m.wed_e, m.thu_s, m.thu_e, m.fri_s, m.fri_e
    );
  }

  pool = createSqlitePool(db);
  redis = createMockRedis();
  app = createApp({ pool, redis, apiKey: API_KEY });
});

afterAll(() => {
  db?.close();
});

// ─── Helpers ───────────────────────────────────────────────────────

function authHeaders() {
  return { "x-api-key": API_KEY };
}

async function query(params = {}) {
  if (!params.limit) params.limit = "50";
  const qs = new URLSearchParams(params).toString();
  const res = await app.request(`/api/query?${qs}`, { headers: authHeaders() });
  return res.json();
}

function uuids(body) {
  return body.data.map((c) => c.course_uuid).sort();
}

const ALL = COURSES.map((c) => c.uuid).sort();
const OPEN = ["uuid-c1", "uuid-c2", "uuid-c5", "uuid-c6", "uuid-c7", "uuid-c8", "uuid-c9", "uuid-c10", "uuid-c11", "uuid-c12"].sort();

// ─── Auth ──────────────────────────────────────────────────────────

describe("auth", () => {
  it("rejects requests without API key", async () => {
    const res = await app.request("/api/query");
    expect(res.status).toBe(401);
  });

  it("rejects requests with wrong API key", async () => {
    const res = await app.request("/api/query", { headers: { "x-api-key": "wrong" } });
    expect(res.status).toBe(401);
  });

  it("accepts correct API key", async () => {
    const res = await app.request("/api/query?limit=1", { headers: authHeaders() });
    expect(res.status).toBe(200);
  });
});

// ─── Status filter ─────────────────────────────────────────────────

describe("status filter", () => {
  it("status=OPEN returns only courses with at least one OPEN section", async () => {
    const body = await query({ status: "OPEN" });
    const ids = uuids(body);
    expect(ids).toEqual(OPEN);
    expect(ids).not.toContain("uuid-c3");
    expect(ids).not.toContain("uuid-c4");
  });

  it("status=CLOSED returns only c3", async () => {
    const body = await query({ status: "CLOSED" });
    expect(uuids(body)).toEqual(["uuid-c3"]);
  });

  it("status=WAITLISTED returns c1 and c4", async () => {
    const body = await query({ status: "WAITLISTED" });
    const ids = uuids(body);
    expect(ids).toContain("uuid-c1");
    expect(ids).toContain("uuid-c4");
  });

  it("status=OPEN,WAITLISTED returns all except c3", async () => {
    const body = await query({ status: "OPEN,WAITLISTED" });
    const ids = uuids(body);
    expect(ids).not.toContain("uuid-c3");
    expect(ids.length).toBe(ALL.length - 1);
  });

  it("status=OPEN,WAITLISTED,CLOSED returns all courses", async () => {
    const body = await query({ status: "OPEN,WAITLISTED,CLOSED" });
    expect(uuids(body)).toEqual(ALL);
  });
});

// ─── Credit filters ────────────────────────────────────────────────

describe("credit filters", () => {
  it("min_credits=4 returns only 5-credit courses (c2, c6)", async () => {
    const body = await query({ min_credits: "4" });
    expect(uuids(body)).toEqual(["uuid-c2", "uuid-c6"]);
  });

  it("max_credits=3 excludes 5-credit courses", async () => {
    const body = await query({ max_credits: "3" });
    const ids = uuids(body);
    expect(ids).not.toContain("uuid-c2");
    expect(ids).not.toContain("uuid-c6");
    expect(ids.length).toBe(ALL.length - 2);
  });

  it("min_credits=3 max_credits=3 returns only 3-credit courses", async () => {
    const body = await query({ min_credits: "3", max_credits: "3" });
    const ids = uuids(body);
    expect(ids).not.toContain("uuid-c2"); // 5cr
    expect(ids).not.toContain("uuid-c6"); // 5cr
    expect(ids).not.toContain("uuid-c10"); // 2cr
  });
});

// ─── Level filter ──────────────────────────────────────────────────

describe("level filter", () => {
  it("level=Elementary returns correct courses", async () => {
    const body = await query({ level: "Elementary" });
    expect(uuids(body)).toEqual(
      ["uuid-c2", "uuid-c3", "uuid-c4", "uuid-c5", "uuid-c7", "uuid-c10", "uuid-c12"].sort()
    );
  });

  it("level=Intermediate returns c1, c6, c11", async () => {
    const body = await query({ level: "Intermediate" });
    expect(uuids(body)).toEqual(["uuid-c1", "uuid-c6", "uuid-c11"].sort());
  });

  it("level=Advanced returns c8, c9", async () => {
    const body = await query({ level: "Advanced" });
    expect(uuids(body)).toEqual(["uuid-c8", "uuid-c9"].sort());
  });
});

// ─── Prerequisite filters ──────────────────────────────────────────

describe("prerequisite filters", () => {
  it("no_prereqs returns courses with enrollment_prerequisites='None'", async () => {
    const body = await query({ no_prereqs: "true" });
    expect(uuids(body)).toEqual(
      ["uuid-c2", "uuid-c3", "uuid-c4", "uuid-c5", "uuid-c7", "uuid-c10", "uuid-c12"].sort()
    );
  });

  it("sophomore_standing returns c1, c6", async () => {
    const body = await query({ sophomore_standing: "true" });
    expect(uuids(body)).toEqual(["uuid-c1", "uuid-c6"].sort());
  });

  it("junior_standing returns c8", async () => {
    const body = await query({ junior_standing: "true" });
    expect(uuids(body)).toEqual(["uuid-c8"]);
  });

  it("senior_standing returns c9", async () => {
    const body = await query({ senior_standing: "true" });
    expect(uuids(body)).toEqual(["uuid-c9"]);
  });

  it("no_prereqs + sophomore_standing uses OR (includes both sets)", async () => {
    const body = await query({ no_prereqs: "true", sophomore_standing: "true" });
    const ids = uuids(body);
    expect(ids).toContain("uuid-c1"); // sophomore
    expect(ids).toContain("uuid-c6"); // sophomore
    expect(ids).toContain("uuid-c2"); // none
    expect(ids).toContain("uuid-c7"); // none
    expect(ids).not.toContain("uuid-c8"); // junior
    expect(ids).not.toContain("uuid-c9"); // senior
    expect(ids).not.toContain("uuid-c11"); // CS 200 prereq
  });

  it("all standing filters combined returns all except c11", async () => {
    const body = await query({
      no_prereqs: "true",
      sophomore_standing: "true",
      junior_standing: "true",
      senior_standing: "true",
    });
    const ids = uuids(body);
    expect(ids).not.toContain("uuid-c11"); // prereq is "CS 200", not a standing
    expect(ids.length).toBe(ALL.length - 1);
  });
});

// ─── Breadth requirement filters ───────────────────────────────────

describe("breadth requirement filters", () => {
  it("ethnic_studies returns only c7", async () => {
    const body = await query({ ethnic_studies: "true" });
    expect(uuids(body)).toEqual(["uuid-c7"]);
  });

  it("social_science returns only c3", async () => {
    const body = await query({ social_science: "true" });
    expect(uuids(body)).toEqual(["uuid-c3"]);
  });

  it("humanities returns c4 and c10", async () => {
    const body = await query({ humanities: "true" });
    expect(uuids(body)).toEqual(["uuid-c10", "uuid-c4"].sort());
  });

  it("biological_science returns only c5", async () => {
    const body = await query({ biological_science: "true" });
    expect(uuids(body)).toEqual(["uuid-c5"]);
  });

  it("physical_science returns only c6", async () => {
    const body = await query({ physical_science: "true" });
    expect(uuids(body)).toEqual(["uuid-c6"]);
  });

  it("natural_science returns only c2", async () => {
    const body = await query({ natural_science: "true" });
    expect(uuids(body)).toEqual(["uuid-c2"]);
  });

  it("literature returns only c4", async () => {
    const body = await query({ literature: "true" });
    expect(uuids(body)).toEqual(["uuid-c4"]);
  });

  it("l_and_s returns only c6", async () => {
    const body = await query({ l_and_s: "true" });
    expect(uuids(body)).toEqual(["uuid-c6"]);
  });

  it("gen_ed=COM B returns only c12", async () => {
    const body = await query({ gen_ed: "COM B" });
    expect(uuids(body)).toEqual(["uuid-c12"]);
  });
});

// ─── GPA / grade filters ──────────────────────────────────────────

describe("GPA and grade filters", () => {
  it("min_cumulative_gpa=3.5 returns courses with GPA >= 3.5", async () => {
    const body = await query({ min_cumulative_gpa: "3.5" });
    const ids = uuids(body);
    expect(ids).toEqual(
      ["uuid-c3", "uuid-c4", "uuid-c7", "uuid-c10", "uuid-c12"].sort()
    );
  });

  it("min_most_recent_gpa=3.5 returns courses with recent GPA >= 3.5", async () => {
    const body = await query({ min_most_recent_gpa: "3.5" });
    const ids = uuids(body);
    // c3=3.55, c4=3.65, c7=3.75, c10=3.85
    expect(ids).toContain("uuid-c3");
    expect(ids).toContain("uuid-c4");
    expect(ids).toContain("uuid-c7");
    expect(ids).toContain("uuid-c10");
    expect(ids).not.toContain("uuid-c1"); // 3.35
  });

  it("min_a_percent=40 returns courses with A% >= 40", async () => {
    const body = await query({ min_a_percent: "40" });
    expect(uuids(body)).toEqual(
      ["uuid-c3", "uuid-c4", "uuid-c7", "uuid-c10"].sort()
    );
  });

  it("median_grade=A returns only c10", async () => {
    const body = await query({ median_grade: "A" });
    expect(uuids(body)).toEqual(["uuid-c10"]);
  });

  it("median_grade=AB returns c3, c4, c7, c12", async () => {
    const body = await query({ median_grade: "AB" });
    expect(uuids(body)).toEqual(["uuid-c12", "uuid-c3", "uuid-c4", "uuid-c7"].sort());
  });
});

// ─── Search ────────────────────────────────────────────────────────

describe("search filter", () => {
  it("search_param=Calculus matches course title", async () => {
    const body = await query({ search_param: "Calculus" });
    expect(uuids(body)).toEqual(["uuid-c2"]);
  });

  it("search_param=COMP SCI matches course_designation", async () => {
    const body = await query({ search_param: "COMP SCI" });
    expect(uuids(body)).toEqual(["uuid-c1", "uuid-c11", "uuid-c8", "uuid-c9"].sort());
  });

  it("search_param=Alice matches instructor name", async () => {
    const body = await query({ search_param: "Alice" });
    expect(uuids(body)).toEqual(["uuid-c1"]);
  });

  it("search_param=ZZZZZZ returns empty", async () => {
    const body = await query({ search_param: "ZZZZZZ" });
    expect(body.data).toEqual([]);
    expect(body.count).toBe(0);
  });
});

// ─── RMP section-level filters ─────────────────────────────────────

describe("RMP section-level filters", () => {
  it("min_section_avg_rating=4.0 returns courses with high-rated sections", async () => {
    const body = await query({ min_section_avg_rating: "4.0" });
    const ids = uuids(body);
    // Alice=4.2 (c1), Diana=4.5 (c3), Ed=4.0 (c4), Holly=4.3 (c7), Ken=4.1 (c10)
    expect(ids).toContain("uuid-c1");
    expect(ids).toContain("uuid-c3");
    expect(ids).toContain("uuid-c4");
    expect(ids).toContain("uuid-c7");
    expect(ids).toContain("uuid-c10");
    expect(ids).not.toContain("uuid-c2"); // Carol=3.0
  });

  it("min_section_avg_difficulty=3.0 returns sections with difficulty >= 3.0", async () => {
    const body = await query({ min_section_avg_difficulty: "3.0" });
    const ids = uuids(body);
    // Bob=3.0 (c1), Carol=3.5 (c2), Gary=3.2 (c6), Lily=3.1 (c11), Mike=3.3 (c12)
    expect(ids).toContain("uuid-c2");
    expect(ids).toContain("uuid-c6");
  });

  it("min_section_total_ratings=20 returns well-reviewed sections", async () => {
    const body = await query({ min_section_total_ratings: "20" });
    const ids = uuids(body);
    // Alice=20 (c1), Diana=30 (c3), Holly=25 (c7), Ken=22 (c10)
    expect(ids).toContain("uuid-c1");
    expect(ids).toContain("uuid-c3");
    expect(ids).toContain("uuid-c7");
    expect(ids).toContain("uuid-c10");
  });
});

// ─── Instruction mode ──────────────────────────────────────────────

describe("instruction mode filter", () => {
  it("instruction_mode=Online returns c11", async () => {
    const body = await query({ instruction_mode: "Online" });
    expect(uuids(body)).toEqual(["uuid-c11"]);
  });

  it("instruction_mode=In Person excludes online-only courses", async () => {
    const body = await query({ instruction_mode: "In Person" });
    const ids = uuids(body);
    expect(ids).toContain("uuid-c1");
    expect(ids).toContain("uuid-c11"); // c11 has in-person DIS 301
  });
});

// ─── Available seats ───────────────────────────────────────────────

describe("available seats filter", () => {
  it("min_available_seats=20 returns courses with sections having >= 20 seats", async () => {
    const body = await query({ min_available_seats: "20" });
    const ids = uuids(body);
    // c1(30), c5(20), c7(25), c10(40), c12(30)
    expect(ids).toContain("uuid-c1");
    expect(ids).toContain("uuid-c5");
    expect(ids).toContain("uuid-c7");
    expect(ids).toContain("uuid-c10");
    expect(ids).toContain("uuid-c12");
    expect(ids).not.toContain("uuid-c2"); // 5 seats
    expect(ids).not.toContain("uuid-c3"); // 0 seats
  });
});

// ─── Sorting ───────────────────────────────────────────────────────

describe("sorting", () => {
  it("default sort is by catalog_number ascending", async () => {
    const body = await query();
    const catalogs = body.data.map((c) => c.course_uuid);
    // catalog_number order: 100(c12), 101(c7), 113(c10), 150(c4), 151(c5), 200(c1), 201(c6), 202(c3), 221(c2), 300(c11), 577(c8), 640(c9)
    expect(catalogs[0]).toBe("uuid-c12"); // 100
    expect(catalogs[1]).toBe("uuid-c7"); // 101
    expect(catalogs[2]).toBe("uuid-c10"); // 113
  });

  it("sort=cumulative_gpa orders by GPA descending", async () => {
    const body = await query({ sort: "cumulative_gpa" });
    const gpas = body.data.map((c) => c.cumulative_gpa);
    for (let i = 0; i < gpas.length - 1; i++) {
      expect(gpas[i]).toBeGreaterThanOrEqual(gpas[i + 1]);
    }
    expect(body.data[0].course_uuid).toBe("uuid-c10"); // GPA 3.9
  });

  it("sort=recent_gpa orders by most recent GPA descending", async () => {
    const body = await query({ sort: "recent_gpa" });
    const gpas = body.data.map((c) => c.most_recent_gpa);
    for (let i = 0; i < gpas.length - 1; i++) {
      expect(gpas[i]).toBeGreaterThanOrEqual(gpas[i + 1]);
    }
  });
});

// ─── Pagination ────────────────────────────────────────────────────

describe("pagination", () => {
  it("limit=3 page=1 returns 3 courses with has_more=true", async () => {
    const body = await query({ limit: "3", page: "1" });
    expect(body.data).toHaveLength(3);
    expect(body.has_more).toBe(true);
    expect(body.total_count).toBe(12);
  });

  it("limit=3 page=4 returns last 3 courses with has_more=false", async () => {
    const body = await query({ limit: "3", page: "4" });
    expect(body.data).toHaveLength(3);
    expect(body.has_more).toBe(false);
  });

  it("limit=100 returns all 12 courses", async () => {
    const body = await query({ limit: "100" });
    expect(body.data).toHaveLength(12);
    expect(body.has_more).toBe(false);
    expect(body.total_count).toBe(12);
  });

  it("page beyond data returns empty", async () => {
    const body = await query({ limit: "10", page: "100" });
    expect(body.data).toEqual([]);
    expect(body.count).toBe(0);
  });
});

// ─── Combined filters ──────────────────────────────────────────────

describe("combined filter behavior", () => {
  it("OPEN + Elementary + no prereqs = beginner courses available now", async () => {
    const body = await query({ status: "OPEN", level: "Elementary", no_prereqs: "true" });
    expect(uuids(body)).toEqual(
      ["uuid-c2", "uuid-c5", "uuid-c7", "uuid-c10", "uuid-c12"].sort()
    );
  });

  it("OPEN + 3cr exact + GPA >= 3.5 = high-GPA 3-credit open courses", async () => {
    const body = await query({
      status: "OPEN",
      min_credits: "3",
      max_credits: "3",
      min_cumulative_gpa: "3.5",
    });
    // c7(3.8 open 3cr), c12(3.5 open 3cr). c3(3.6) is CLOSED, c4(3.7) is WAITLISTED
    expect(uuids(body)).toEqual(["uuid-c12", "uuid-c7"].sort());
  });

  it("social_science + OPEN = empty (c3 is social sci but CLOSED)", async () => {
    const body = await query({ social_science: "true", status: "OPEN" });
    expect(body.data).toEqual([]);
    expect(body.count).toBe(0);
  });

  it("ethnic_studies + humanities = empty (no course has both)", async () => {
    const body = await query({ ethnic_studies: "true", humanities: "true" });
    expect(body.data).toEqual([]);
  });

  it("min_section_avg_rating=4.0 + OPEN excludes c3 (CLOSED)", async () => {
    const body = await query({ min_section_avg_rating: "4.0", status: "OPEN" });
    const ids = uuids(body);
    expect(ids).not.toContain("uuid-c3"); // Diana 4.5 but CLOSED
    expect(ids).toContain("uuid-c1"); // Alice 4.2 OPEN
    expect(ids).toContain("uuid-c7"); // Holly 4.3 OPEN
    expect(ids).toContain("uuid-c10"); // Ken 4.1 OPEN
  });

  it("search_param=COMP SCI + OPEN + min_credits=3", async () => {
    const body = await query({
      search_param: "COMP SCI",
      status: "OPEN",
      min_credits: "3",
    });
    expect(uuids(body)).toEqual(
      ["uuid-c1", "uuid-c11", "uuid-c8", "uuid-c9"].sort()
    );
  });

  it("search + sort + pagination work together", async () => {
    const body = await query({
      level: "Elementary",
      sort: "cumulative_gpa",
      limit: "3",
      page: "1",
    });
    expect(body.data).toHaveLength(3);
    // Elementary sorted by GPA desc: c10(3.9), c7(3.8), c4(3.7), c3(3.6), c12(3.5), c5(3.1), c2(2.8)
    expect(body.data[0].course_uuid).toBe("uuid-c10");
    expect(body.data[1].course_uuid).toBe("uuid-c7");
    expect(body.data[2].course_uuid).toBe("uuid-c4");
    expect(body.has_more).toBe(true);
  });

  it("GPA + grade filters combined", async () => {
    const body = await query({
      min_cumulative_gpa: "3.5",
      min_a_percent: "40",
    });
    // GPA>=3.5: c3(3.6),c4(3.7),c7(3.8),c10(3.9),c12(3.5)
    // A%>=40: c3(40),c4(42),c7(50),c10(55)
    // Intersection: c3, c4, c7, c10
    expect(uuids(body)).toEqual(["uuid-c10", "uuid-c3", "uuid-c4", "uuid-c7"].sort());
  });
});

// ─── Response shape verification ───────────────────────────────────

describe("response shape", () => {
  it("c1 has two sections with correct instructors and meetings", async () => {
    const body = await query({ search_param: "Data Structures" });
    expect(body.data).toHaveLength(1);
    const course = body.data[0];
    expect(course.course_uuid).toBe("uuid-c1");
    expect(course.course_title).toBe("Data Structures");
    expect(course.sections.length).toBe(2);

    const openSection = course.sections.find((s) => s.status === "OPEN");
    expect(openSection).toBeDefined();
    expect(openSection.available_seats).toBe(30);
    expect(openSection.instructors).toHaveLength(1);
    expect(openSection.instructors[0].name).toBe("Alice Chen");
    expect(openSection.instructors[0].avg_rating).toBe(4.2);
    expect(openSection.meetings).toHaveLength(1);
    expect(openSection.meetings[0].meeting_days).toBe("MWF");
    expect(openSection.meetings[0].monday_meeting_start).toBe(T(9, 0));
    expect(openSection.meetings[0].monday_meeting_end).toBe(T(9, 50));

    const wlSection = course.sections.find((s) => s.status === "WAITLISTED");
    expect(wlSection).toBeDefined();
    expect(wlSection.instructors[0].name).toBe("Bob Park");
    expect(wlSection.meetings[0].meeting_days).toBe("TR");
  });

  it("c11 has online section with no meetings and in-person DIS", async () => {
    const body = await query({ search_param: "Programming II" });
    const course = body.data[0];
    expect(course.sections.length).toBe(2);

    const onlineSec = course.sections.find((s) => s.instruction_mode === "Online");
    expect(onlineSec).toBeDefined();
    expect(onlineSec.is_asynchronous).toBe(1);
    expect(onlineSec.instructors).toHaveLength(1);
    expect(onlineSec.instructors[0].name).toBe("Lily Ma");

    const disSec = course.sections.find((s) => s.instruction_mode === "In Person");
    expect(disSec).toBeDefined();
    expect(disSec.instructors).toHaveLength(0); // no instructor for DIS 301
    expect(disSec.meetings).toHaveLength(1);
    expect(disSec.meetings[0].meeting_type).toBe("DIS");
    expect(disSec.meetings[0].friday_meeting_start).toBe(T(14, 0));
  });

  it("section-level RMP averages are calculated from instructor data", async () => {
    const body = await query({ search_param: "Data Structures" });
    const sec = body.data[0].sections.find((s) => s.status === "OPEN");
    // Alice has rating=4.2, only instructor → section avg = 4.2
    expect(sec.section_avg_rating).toBe(4.2);
    expect(sec.section_avg_difficulty).toBe(2.5);
    expect(sec.section_total_ratings).toBe(20);
  });

  it("response includes total_count, has_more, and filters_applied", async () => {
    const body = await query({ status: "OPEN", sort: "cumulative_gpa" });
    expect(body).toHaveProperty("total_count");
    expect(body).toHaveProperty("has_more");
    expect(body).toHaveProperty("filters_applied");
    expect(body.filters_applied.status).toBe("OPEN");
    expect(body.filters_applied.sort).toBe("cumulative_gpa");
  });
});

// ─── Caching ───────────────────────────────────────────────────────

describe("caching", () => {
  it("first request populates redis cache", async () => {
    const initialSets = redis._sets.length;
    await query({ limit: 1 });
    expect(redis._sets.length).toBeGreaterThan(initialSets);
  });

  it("cached response is returned on cache hit", async () => {
    const cachedData = { data: [{ cached: true }], count: 1, total_count: 1, has_more: false };
    const cachedRedis = {
      get: () => Promise.resolve(JSON.stringify(cachedData)),
      set: () => Promise.resolve("OK"),
    };
    const cachedApp = createApp({ pool, redis: cachedRedis, apiKey: API_KEY });
    const res = await cachedApp.request("/api/query?search_param=cached_test", { headers: authHeaders() });
    const body = await res.json();
    expect(body.data[0].cached).toBe(true);
  });
});

// ─── Health check ──────────────────────────────────────────────────

describe("health check", () => {
  it("returns healthy with real database", async () => {
    const res = await app.request("/health");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe("healthy");
  });
});

// ─── GET /api/courses ──────────────────────────────────────────────

describe("GET /api/courses", () => {
  it("returns up to 10 courses from real data", async () => {
    const res = await app.request("/api/courses", { headers: authHeaders() });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.length).toBeLessThanOrEqual(10);
    expect(body.data.length).toBeGreaterThan(0);
  });
});
