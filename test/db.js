import { Database } from "bun:sqlite";

export function rewriteMysqlToSqlite(sql) {
  return sql
    .replace(
      /GROUP_CONCAT\(\s*DISTINCT\s+([\w.]+)\s+ORDER\s+BY\s+[\w.]+(?:\s+(?:ASC|DESC))?\s+SEPARATOR\s+'[^']*'\s*\)/gi,
      "GROUP_CONCAT(DISTINCT $1)"
    )
    .replace(/CAST\(([^)]+?)\s+AS\s+UNSIGNED\)/gi, "CAST($1 AS INTEGER)")
    .replace(/CAST\(([^)]+?)\s+as\s+FLOAT\)/g, "CAST($1 AS REAL)")
    .replace(/CAST\(([^)]+?)\s+AS\s+FLOAT\)/g, "CAST($1 AS REAL)");
}

export function createSqlitePool(db) {
  return {
    execute(sql, params = []) {
      const rewritten = rewriteMysqlToSqlite(sql);
      const trimmed = rewritten.trimStart().toUpperCase();
      const isRead = trimmed.startsWith("SELECT") || trimmed.startsWith("WITH");

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

export function createMockRedis() {
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

const SCHEMA = `
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
  CREATE TABLE course_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    course_id TEXT NOT NULL
  );
  CREATE TABLE section_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    section_id TEXT NOT NULL
  );
`;

export function setupDb() {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);

  function seed(fixture) {
    if (fixture.courses) {
      const subjectCodes = [...new Set(fixture.courses.map((c) => c.subject))];
      const insertSubject = db.prepare("INSERT OR IGNORE INTO subjects VALUES (?, ?)");
      for (const sc of subjectCodes) insertSubject.run(sc, null);

      const insertCourse = db.prepare(
        `INSERT INTO courses VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const c of fixture.courses) {
        insertCourse.run(
          c.id, c.uuid, c.title, c.designation, c.full, c.subject,
          c.catalog ?? null, c.minCr ?? null, c.maxCr ?? null,
          c.level ?? null, c.genEd ?? null, c.prereq ?? null,
          c.ls ?? null, null, c.ethnic ?? null, c.social ?? null,
          c.hum ?? null, c.bio ?? null, c.phys ?? null, c.nat ?? null,
          c.lit ?? null, null, null, null, null, null
        );
      }

      const hasGrades = fixture.courses.some((c) => c.gpa != null);
      if (hasGrades) {
        const insertGrades = db.prepare(
          `INSERT INTO madgrades_course_grades
            (course_name, course_uuid, median_grade, a_percentage, ab_percentage, b_percentage,
             bc_percentage, c_percentage, d_percentage, f_percentage, cumulative_gpa, most_recent_gpa)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const c of fixture.courses) {
          if (c.gpa != null) {
            insertGrades.run(
              c.designation, c.uuid, c.median ?? null,
              c.aPct ?? null, 20, 15, 10, 5, 3, 2,
              c.gpa, c.recentGpa ?? null
            );
          }
        }
      }
    }

    if (fixture.sections) {
      const insertSection = db.prepare(`INSERT INTO sections VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const s of fixture.sections) {
        insertSection.run(
          s.sid, s.usid, s.cuuid, s.status, s.seats,
          s.wl ?? null, s.cap ?? null, s.enrolled ?? null,
          s.mode, s.async ?? 0, s.requisites ?? null
        );
      }
    }

    if (fixture.instructors) {
      const insertInstr = db.prepare(
        `INSERT INTO section_instructors (section_id, instructor_name) VALUES (?, ?)`
      );
      for (const i of fixture.instructors) insertInstr.run(i.sid, i.name);
    }

    if (fixture.rmp) {
      const insertRmp = db.prepare(
        `INSERT INTO rmp_cleaned (full_name, avg_rating, avg_difficulty, num_ratings, would_take_again_percent, legacy_id) VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const r of fixture.rmp) insertRmp.run(r.name, r.rating, r.diff, r.num, r.wta, r.legacy);
    }

    if (fixture.meetings) {
      const insertMeeting = db.prepare(
        `INSERT INTO section_meetings
          (unique_section_id, meeting_number, meeting_days, section_number, start_time, end_time,
           meeting_type, building_name, room, location,
           monday_meeting_start, monday_meeting_end, tuesday_meeting_start, tuesday_meeting_end,
           wednesday_meeting_start, wednesday_meeting_end, thursday_meeting_start, thursday_meeting_end,
           friday_meeting_start, friday_meeting_end)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const m of fixture.meetings) {
        insertMeeting.run(
          m.usid, m.num ?? null, m.days ?? null, m.secNum ?? null,
          m.start ?? null, m.end ?? null, m.type ?? null,
          m.bldg ?? null, m.room ?? null, m.loc ?? null,
          m.mon_s ?? null, m.mon_e ?? null, m.tue_s ?? null, m.tue_e ?? null,
          m.wed_s ?? null, m.wed_e ?? null, m.thu_s ?? null, m.thu_e ?? null,
          m.fri_s ?? null, m.fri_e ?? null
        );
      }
    }
  }

  function teardown() {
    db?.close();
  }

  return { db, pool: createSqlitePool(db), seed, teardown };
}
