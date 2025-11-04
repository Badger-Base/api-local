import { Hono } from "hono";
import { cors } from "hono/cors";
import mysql from "mysql2/promise";

const app = new Hono();

// Create MySQL connection pool
const pool = mysql.createPool({
  uri: Bun.env.MYSQL_URL,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});
console.log("=== DATABASE DEBUG ===");
console.log("MYSQL_URL:", Bun.env.MYSQL_URL);
console.log("URL length:", Bun.env.MYSQL_URL?.length);
console.log("URL type:", typeof Bun.env.MYSQL_URL);
console.log("=====================");

app.use("/*", cors());

app.get("/api/courses", async (c) => {
  const apiKey = c.req.header("x-api-key");

  if (!apiKey || apiKey !== Bun.env.GET_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const [courses] = await pool.execute("SELECT * FROM courses LIMIT 10");
    return c.json({ data: courses });
  } catch (error) {
    console.error("Error in /api/courses:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

app.get("/api/query", async (c) => {
  const apiKey = c.req.header("x-api-key");

  if (!apiKey || apiKey !== Bun.env.GET_API_KEY) {
    return c.json(
      {
        error: "Unauthorized",
        "received-key": apiKey,
        "expected-key": Bun.env.GET_API_KEY,
        "keys-match": apiKey === Bun.env.GET_API_KEY,
      },
      401
    );
  }

  try {
    // Get query parameters for filtering
    const {
      search_param,
      status,
      min_available_seats,
      instruction_mode,
      limit = 10,
      min_credits,
      max_credits,
      level,
      gen_ed,
      ethnic_studies,
      social_science,
      humanities,
      biological_science,
      physical_science,
      natural_science,
      literature,
      min_cumulative_gpa,
      min_most_recent_gpa,
      median_grade,
      min_a_percent,
      no_prereqs,
      sophomore_standing,
      junior_standing,
      senior_standing,
      // New RMP section-level filters
      min_section_avg_rating,
      min_section_avg_difficulty,
      min_section_total_ratings,
      min_section_avg_would_take_again,
      // New meeting time filters - now supporting comma-separated millisecond ranges
      meeting_days,
      l_and_s,
      mondayStartTime,
      mondayEndTime,
      tuesdayStartTime,
      tuesdayEndTime,
      wednesdayStartTime,
      wednesdayEndTime,
      thursdayStartTime,
      thursdayEndTime,
      fridayStartTime,
      fridayEndTime,
      building_name,
      in_person_only, // this needs to be fixed
      page = 1,
      sort,
      
    } = c.req.query();

    // Build WHERE clause for section filters
    let sectionFilters = [];
    let courseFilters = [];
    let rmpSectionFilters = []; // New: for RMP section-level filters
    let meetingFilters = []; // New: for meeting-related filters
    let filterParams = [];
    let daysWithFilters = [];

    // Helper function to create time range filters for a specific day
    const addDayTimeFilter = (dayColumn, startTimes, endTimes, dayName) => {
      if (startTimes && endTimes) {
        const startArray = startTimes.split(',').map(t => parseInt(t.trim()));
        const endArray = endTimes.split(',').map(t => parseInt(t.trim()));

        if (startArray.length !== endArray.length) {
          console.warn(`Mismatch in ${dayName} time arrays: ${startArray.length} start times vs ${endArray.length} end times`);
          return;
        }

        // Create OR conditions for each time range
        const timeRangeConditions = [];
        for (let i = 0; i < startArray.length; i++) {
          const startTime = startArray[i];
          const endTime = endArray[i];

          // Check if the meeting overlaps with the availability window
          // Meeting overlaps if: meeting_start < availability_end AND meeting_end > availability_start
          timeRangeConditions.push(`(
            section_meetings.${dayColumn}_meeting_start IS NOT NULL AND 
            (section_meetings.${dayColumn}_meeting_start < ?
            OR section_meetings.${dayColumn}_meeting_end > ?)
          )`);

          filterParams.push(startTime, endTime);
        }

        if (timeRangeConditions.length > 0) {
          daysWithFilters.push(dayName);
          //Joining or so in case of multiple availability windows in a single day
          meetingFilters.push(`(${timeRangeConditions.join(' OR ')})`);
        }
      }
    };

    if (status) {
      // Handle multiple statuses separated by commas
      const statusList = status.split(",").map((s) => s.trim().toUpperCase());
      if (statusList.length === 1) {
        sectionFilters.push("sections.status = ?");
        filterParams.push(statusList[0]);
      } else {
        // Multiple statuses - use IN clause
        const statusPlaceholders = statusList.map(() => "?").join(",");
        sectionFilters.push(`sections.status IN (${statusPlaceholders})`);
        filterParams.push(...statusList);
      }
    }

    if (instruction_mode) {
      sectionFilters.push("sections.instruction_mode = ?");
      filterParams.push(instruction_mode);
    }

    if (min_available_seats) {
      sectionFilters.push("sections.available_seats >= ?");
      filterParams.push(min_available_seats);
    }

    if (min_a_percent) {
      courseFilters.push("madgrades_course_grades.a_percentage >= ?");
      filterParams.push(min_a_percent);
    }

    if (median_grade) {
      courseFilters.push("madgrades_course_grades.median_grade = ?");
      filterParams.push(median_grade);
    }

    if (l_and_s) {
      courseFilters.push("letters_and_science_credits = 'C'");
    }

    // Course-level filters
    if (min_credits) {
      courseFilters.push("courses.minimum_credits >= ?");
      filterParams.push(min_credits);
    }
    if (max_credits) {
      courseFilters.push("courses.maximum_credits <= ?");
      filterParams.push(max_credits);
    }

    if (level) {
      courseFilters.push("courses.level = ?");
      filterParams.push(level);
    }
    if (gen_ed) {
      courseFilters.push("courses.general_education = ?");
      filterParams.push(gen_ed);
    }
    if (ethnic_studies) {
      courseFilters.push("courses.ethnic_studies = ?");
      filterParams.push("ETHNIC ST");
    }
    if (social_science) {
      courseFilters.push("courses.social_science = ?");
      filterParams.push("S");
    }
    if (humanities) {
      courseFilters.push("courses.humanities = ?");
      filterParams.push("H");
    }
    if (biological_science) {
      courseFilters.push("courses.biological_science = ?");
      filterParams.push("B");
    }
    if (physical_science) {
      courseFilters.push("courses.physical_science = ?");
      filterParams.push("P");
    }
    if (natural_science) {
      courseFilters.push("courses.natural_science = ?");
      filterParams.push("N");
    }
    if (literature) {
      courseFilters.push("courses.literature = ?");
      filterParams.push("L");
    }

    if (in_person_only) {
      meetingFilters.push("section_meetings.location != 'ONLINE' AND section_meetings.location != 'OFF CAMPUS'");
    }

    if (no_prereqs || sophomore_standing || junior_standing || senior_standing) {
      const prereqConditions = [];

      if (no_prereqs) {
        prereqConditions.push("courses.enrollment_prerequisites = ?");
        filterParams.push("None");
      }
      if (sophomore_standing) {
        prereqConditions.push("(courses.enrollment_prerequisites = ? OR courses.enrollment_prerequisites = ?)");
        filterParams.push("Sophomore standing", "Sophomore standing only");
      }
      if (junior_standing) {
        prereqConditions.push("(courses.enrollment_prerequisites = ? OR courses.enrollment_prerequisites = ?)");
        filterParams.push("Junior standing", "Junior standing only");
      }
      if (senior_standing) {
        prereqConditions.push("(courses.enrollment_prerequisites = ? OR courses.enrollment_prerequisites = ?)");
        filterParams.push("Senior standing", "Senior standing only");
      }

      // Add the OR condition to course filters
      courseFilters.push(`(${prereqConditions.join(" OR ")})`);
    }

    if (min_cumulative_gpa) {
      courseFilters.push("madgrades_course_grades.cumulative_gpa >= ?");
      filterParams.push(min_cumulative_gpa);
    }

    if (min_most_recent_gpa) {
      courseFilters.push("madgrades_course_grades.most_recent_gpa >= ?");
      filterParams.push(min_most_recent_gpa);
    }

    // New RMP section-level filters
    if (min_section_avg_rating) {
      rmpSectionFilters.push("section_rmp_avg.section_avg_rating >= ?");
      filterParams.push(parseFloat(min_section_avg_rating));
    }
    if (min_section_avg_difficulty) {
      rmpSectionFilters.push("section_rmp_avg.section_avg_difficulty >= ?");
      filterParams.push(parseFloat(min_section_avg_difficulty));
    }
    if (min_section_total_ratings) {
      rmpSectionFilters.push("section_rmp_avg.section_total_ratings >= ?");
      filterParams.push(parseInt(min_section_total_ratings));
    }
    if (min_section_avg_would_take_again) {
      rmpSectionFilters.push(
        "section_rmp_avg.section_avg_would_take_again >= ?"
      );
      filterParams.push(parseFloat(min_section_avg_would_take_again));
    }

    // Add day-specific time filters and collect them
    const dayFilters = [];

    addDayTimeFilter('monday', mondayStartTime, mondayEndTime, 'Monday'); ``
    addDayTimeFilter('tuesday', tuesdayStartTime, tuesdayEndTime, 'Tuesday');
    addDayTimeFilter('wednesday', wednesdayStartTime, wednesdayEndTime, 'Wednesday');
    addDayTimeFilter('thursday', thursdayStartTime, thursdayEndTime, 'Thursday');
    addDayTimeFilter('friday', fridayStartTime, fridayEndTime, 'Friday');


    console.log("Days with filters:", daysWithFilters);
    console.log("Meeting filters:", meetingFilters);


    console.log("Days with filters:", daysWithFilters);
    const allDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];


    // If we have any day filters, combine them with AND logic
    // This means: the section must be compatible with ALL specified days
    if (daysWithFilters.length > 0) {
      allDays.forEach(day => {
        if (!daysWithFilters.includes(day)) {
          meetingFilters.push(`section_meetings.${day}_meeting_start IS NULL AND section_meetings.${day}_meeting_end IS NULL`);
        }
      });

    }



    console.log("Meeting filters:", meetingFilters);



    if (search_param) {
      courseFilters.push(
        "(courses.course_designation LIKE ? OR courses.course_title LIKE ? OR courses.full_course_designation LIKE ? OR si.instructor_name LIKE ?)"
      );
      const searchValue = `%${search_param}%`;
      filterParams.push(searchValue, searchValue, searchValue, searchValue);
    }

    const offset = (page - 1) * limit;

    let allFilters = [
      ...sectionFilters,
      ...courseFilters,
      ...rmpSectionFilters,
    ];

    console.log("All filters:", allFilters);
    console.log("Filter params:", filterParams);

    const limitValue = parseInt(limit) || 10;

    // Build ORDER BY clause based on sort parameter
    let orderByClause = "ORDER BY courses.catalog_number"; // default
    if (sort) {
      const sortLower = sort.toLowerCase();
      if (sortLower === "cumulative_gpa") {
        orderByClause = "ORDER BY madgrades_course_grades.cumulative_gpa DESC";
      } else if (sortLower === "recent_gpa") {
        orderByClause = "ORDER BY madgrades_course_grades.most_recent_gpa DESC";
      }
      // If sort is not recognized, keep default
    }

    // Determine if we need to join section_meetings table
    const needMeetingJoin = meetingFilters.length > 0;


    if (needMeetingJoin) {
      const meetingSubquery = `
      NOT EXISTS (
        SELECT 1 
        FROM section_meetings 
        WHERE section_meetings.unique_section_id = sections.unique_section_id
        AND (${meetingFilters.join(' OR ')})
      )
      `
      allFilters.push(meetingSubquery);
    }

    // UPDATED: Count query now uses DISTINCT course_uuid instead of course_id
    let totalCountSql = `
     WITH section_rmp_avg AS (
          SELECT 
            sections.section_id,
            sections.course_uuid,
            CASE 
              WHEN COUNT(CASE WHEN rmp_cleaned.avg_rating IS NOT NULL THEN 1 END) > 0 
              THEN ROUND(
                SUM(CASE WHEN rmp_cleaned.avg_rating IS NOT NULL 
                    THEN rmp_cleaned.avg_rating * COALESCE(rmp_cleaned.num_ratings, 1) 
                    ELSE 0 END) / 
                SUM(CASE WHEN rmp_cleaned.avg_rating IS NOT NULL 
                    THEN COALESCE(rmp_cleaned.num_ratings, 1) 
                    ELSE 0 END), 2)
              ELSE NULL 
            END as section_avg_rating,
            CASE 
              WHEN COUNT(CASE WHEN rmp_cleaned.avg_difficulty IS NOT NULL THEN 1 END) > 0 
              THEN ROUND(
                SUM(CASE WHEN rmp_cleaned.avg_difficulty IS NOT NULL 
                    THEN rmp_cleaned.avg_difficulty * COALESCE(rmp_cleaned.num_ratings, 1) 
                    ELSE 0 END) / 
                SUM(CASE WHEN rmp_cleaned.avg_difficulty IS NOT NULL 
                    THEN COALESCE(rmp_cleaned.num_ratings, 1) 
                    ELSE 0 END), 2)
              ELSE NULL 
            END as section_avg_difficulty,
            SUM(CASE WHEN rmp_cleaned.avg_rating IS NOT NULL 
                THEN COALESCE(rmp_cleaned.num_ratings, 1) 
                ELSE 0 END) as section_total_ratings,
            CASE 
              WHEN COUNT(CASE WHEN rmp_cleaned.would_take_again_percent IS NOT NULL THEN 1 END) > 0 
              THEN ROUND(
                SUM(CASE WHEN rmp_cleaned.would_take_again_percent IS NOT NULL 
                    THEN rmp_cleaned.would_take_again_percent * COALESCE(rmp_cleaned.num_ratings, 1) 
                    ELSE 0 END) / 
                SUM(CASE WHEN rmp_cleaned.would_take_again_percent IS NOT NULL 
                    THEN COALESCE(rmp_cleaned.num_ratings, 1) 
                    ELSE 0 END), 2)
              ELSE NULL 
            END as section_avg_would_take_again
          FROM sections
          LEFT JOIN section_instructors si ON sections.section_id = si.section_id
          LEFT JOIN rmp_cleaned ON si.instructor_name = rmp_cleaned.full_name
          GROUP BY sections.section_id, sections.course_uuid
        )
    SELECT COUNT(DISTINCT courses.course_uuid) AS total
    FROM courses
    JOIN sections ON courses.course_uuid = sections.course_uuid
    JOIN madgrades_course_grades ON courses.course_designation = madgrades_course_grades.course_name
    LEFT JOIN section_instructors si ON sections.section_id = si.section_id
    ${rmpSectionFilters.length > 0
        ? "JOIN section_rmp_avg ON sections.section_id = section_rmp_avg.section_id"
        : ""
      }
    ${allFilters.length > 0 ? `WHERE ${allFilters.join(" AND ")}` : ""}
  `;

    const [countRows] = await pool.execute(totalCountSql, filterParams);
    const totalCount = countRows?.[0]?.total ?? 0;
    const hasMore = offset + limitValue < totalCount;

    // Build the query with RMP section calculations - UPDATED to use course_uuid
    let distinctCoursesSql, queryParams;

    if (allFilters.length > 0) {
      // Create a CTE (Common Table Expression) to calculate section-level RMP averages
      distinctCoursesSql = `
        WITH section_rmp_avg AS (
          SELECT 
            sections.section_id,
            sections.course_uuid,
            CASE 
              WHEN COUNT(CASE WHEN rmp_cleaned.avg_rating IS NOT NULL THEN 1 END) > 0 
              THEN ROUND(
                SUM(CASE WHEN rmp_cleaned.avg_rating IS NOT NULL 
                    THEN rmp_cleaned.avg_rating * COALESCE(rmp_cleaned.num_ratings, 1) 
                    ELSE 0 END) / 
                SUM(CASE WHEN rmp_cleaned.avg_rating IS NOT NULL 
                    THEN COALESCE(rmp_cleaned.num_ratings, 1) 
                    ELSE 0 END), 2)
              ELSE NULL 
            END as section_avg_rating,
            CASE 
              WHEN COUNT(CASE WHEN rmp_cleaned.avg_difficulty IS NOT NULL THEN 1 END) > 0 
              THEN ROUND(
                SUM(CASE WHEN rmp_cleaned.avg_difficulty IS NOT NULL 
                    THEN rmp_cleaned.avg_difficulty * COALESCE(rmp_cleaned.num_ratings, 1) 
                    ELSE 0 END) / 
                SUM(CASE WHEN rmp_cleaned.avg_difficulty IS NOT NULL 
                    THEN COALESCE(rmp_cleaned.num_ratings, 1) 
                    ELSE 0 END), 2)
              ELSE NULL 
            END as section_avg_difficulty,
            SUM(CASE WHEN rmp_cleaned.avg_rating IS NOT NULL 
                THEN COALESCE(rmp_cleaned.num_ratings, 1) 
                ELSE 0 END) as section_total_ratings,
            CASE 
              WHEN COUNT(CASE WHEN rmp_cleaned.would_take_again_percent IS NOT NULL THEN 1 END) > 0 
              THEN ROUND(
                SUM(CASE WHEN rmp_cleaned.would_take_again_percent IS NOT NULL 
                    THEN rmp_cleaned.would_take_again_percent * COALESCE(rmp_cleaned.num_ratings, 1) 
                    ELSE 0 END) / 
                SUM(CASE WHEN rmp_cleaned.would_take_again_percent IS NOT NULL 
                    THEN COALESCE(rmp_cleaned.num_ratings, 1) 
                    ELSE 0 END), 2)
              ELSE NULL 
            END as section_avg_would_take_again
          FROM sections
          LEFT JOIN section_instructors si ON sections.section_id = si.section_id
          LEFT JOIN rmp_cleaned ON si.instructor_name = rmp_cleaned.full_name
          GROUP BY sections.section_id, sections.course_uuid
        )
        SELECT DISTINCT courses.course_uuid
        FROM courses
        JOIN sections ON courses.course_uuid = sections.course_uuid
        JOIN madgrades_course_grades ON courses.course_designation = madgrades_course_grades.course_name
        LEFT JOIN section_instructors si ON sections.section_id = si.section_id
        ${rmpSectionFilters.length > 0
          ? "JOIN section_rmp_avg ON sections.section_id = section_rmp_avg.section_id"
          : ""
        }
        ${needMeetingJoin
          ? "LEFT JOIN section_meetings ON sections.unique_section_id = section_meetings.unique_section_id"
          : ""
        }
        ${allFilters.length > 0 ? `WHERE ${allFilters.join(" AND ")}` : ""}
        LIMIT ${limitValue} OFFSET ${offset}
      `;
      queryParams = filterParams;
    } else {
      // No filters - simple query using course_uuid
      distinctCoursesSql = `
        SELECT DISTINCT courses.course_uuid
        FROM courses
        JOIN sections ON courses.course_uuid = sections.course_uuid
        LIMIT ${limitValue} OFFSET ${offset}
      `;
      queryParams = [];
    }

    console.log("=== DISTINCT COURSES QUERY ===");
    console.log("SQL:", distinctCoursesSql);
    console.log("Params:", queryParams);
    console.log("===============================");

    const [courseUuids] = await pool.execute(distinctCoursesSql, queryParams);

    if (!Array.isArray(courseUuids) || courseUuids.length === 0) {
      return c.json({
        data: [],
        count: 0,
      });
    }

    // Get full course details for these course UUIDs - UPDATED to use course_uuid
    const courseUuidList = courseUuids.map((row) => row.course_uuid);
    const coursePlaceholders = courseUuidList.map(() => "?").join(",");

    // UPDATED: Select one representative course per course_uuid (pick the first one)
    const coursesSql = `
      SELECT 
        courses.course_uuid,
        MIN(courses.course_id) as course_id,
        MAX(courses.course_title) as course_title,
        MAX(courses.course_designation) as course_designation,
        MAX(courses.enrollment_prerequisites) as enrollment_prerequisites,
        MAX(courses.letters_and_science_credits) as letters_and_science_credits,
        MAX(courses.course_description) as course_description,
        MAX(courses.subject_code) as subject_code,
        MAX(courses.full_course_designation) as full_course_designation,
        MAX(courses.minimum_credits) as minimum_credits,
        MAX(courses.general_education) as general_education,
        MAX(courses.maximum_credits) as maximum_credits,
        MAX(courses.ethnic_studies) as ethnic_studies,
        MAX(courses.social_science) as social_science,
        MAX(courses.humanities) as humanities,
        MAX(courses.biological_science) as biological_science,
        MAX(courses.physical_science) as physical_science,
        MAX(courses.natural_science) as natural_science,
        MAX(courses.literature) as literature,
        MAX(courses.level) as level,
        MAX(courses.typically_offered) as typically_offered,
        MAX(madgrades_course_grades.median_grade) as median_grade,
        MAX(courses.workplace_experience_description) as workplace_experience_description,
        MAX(courses.open_to_first_year) as open_to_first_year,
        MAX(courses.repeatable_for_credit) as repeatable_for_credit,
        MAX(ROUND(CAST(madgrades_course_grades.a_percentage as FLOAT), 2)) as a_percent,
        MAX(ROUND(CAST(madgrades_course_grades.ab_percentage as FLOAT), 2)) as ab_percent,
        MAX(ROUND(CAST(madgrades_course_grades.b_percentage as FLOAT), 2)) as b_percent,
        MAX(ROUND(CAST(madgrades_course_grades.bc_percentage as FLOAT), 2)) as bc_percent,
        MAX(ROUND(CAST(madgrades_course_grades.c_percentage as FLOAT), 2)) as c_percent,
        MAX(ROUND(CAST(madgrades_course_grades.d_percentage as FLOAT), 2)) as d_percent,
        MAX(ROUND(CAST(madgrades_course_grades.f_percentage as FLOAT), 2)) as f_percent,
        MAX(ROUND(CAST(madgrades_course_grades.cumulative_gpa AS FLOAT), 2)) AS cumulative_gpa,
        MAX(ROUND(CAST(madgrades_course_grades.most_recent_gpa AS FLOAT), 2)) AS most_recent_gpa,
        MAX(madgrades_course_grades.course_uuid) AS madgrades_course_uuid,
        MAX(subjects.footnotes) AS subject_footnotes,
        GROUP_CONCAT(DISTINCT courses.course_designation ORDER BY courses.course_designation SEPARATOR ', ') as all_course_designations
      FROM courses 
      JOIN madgrades_course_grades ON courses.course_designation = madgrades_course_grades.course_name
      LEFT JOIN subjects ON courses.subject_code = subjects.subject_code
      WHERE courses.course_uuid IN (${coursePlaceholders})
      GROUP BY courses.course_uuid, courses.catalog_number, madgrades_course_grades.cumulative_gpa, madgrades_course_grades.most_recent_gpa, subjects.footnotes
      ${orderByClause}
    `;

    const [coursesResults] = await pool.execute(coursesSql, courseUuidList);

    // Get sections with pre-calculated RMP averages and meetings - UPDATED to use course_uuid
    const sectionsWithRmpAndMeetingsSql = `
      WITH section_rmp_avg AS (
        SELECT 
          sections.section_id,
          sections.unique_section_id,
          sections.course_uuid,
          sections.status,
          sections.available_seats,
          sections.waitlist_total,
          sections.capacity,
          sections.enrolled,
          sections.instruction_mode,
          sections.is_asynchronous,
          sections.section_requisites,
          CASE 
            WHEN COUNT(CASE WHEN rmp_cleaned.avg_rating IS NOT NULL THEN 1 END) > 0 
            THEN ROUND(
              SUM(CASE WHEN rmp_cleaned.avg_rating IS NOT NULL 
                  THEN rmp_cleaned.avg_rating * COALESCE(rmp_cleaned.num_ratings, 1) 
                  ELSE 0 END) / 
              SUM(CASE WHEN rmp_cleaned.avg_rating IS NOT NULL 
                  THEN COALESCE(rmp_cleaned.num_ratings, 1) 
                  ELSE 0 END), 2)
            ELSE NULL 
          END as section_avg_rating,
          CASE 
            WHEN COUNT(CASE WHEN rmp_cleaned.avg_difficulty IS NOT NULL THEN 1 END) > 0 
            THEN ROUND(
              SUM(CASE WHEN rmp_cleaned.avg_difficulty IS NOT NULL 
                  THEN rmp_cleaned.avg_difficulty * COALESCE(rmp_cleaned.num_ratings, 1) 
                  ELSE 0 END) / 
              SUM(CASE WHEN rmp_cleaned.avg_difficulty IS NOT NULL 
                  THEN COALESCE(rmp_cleaned.num_ratings, 1) 
                  ELSE 0 END), 2)
            ELSE NULL 
          END as section_avg_difficulty,
          CAST(SUM(CASE WHEN rmp_cleaned.avg_rating IS NOT NULL 
            THEN COALESCE(rmp_cleaned.num_ratings, 1) 
            ELSE 0 END) AS UNSIGNED) AS section_total_ratings,
          CASE 
            WHEN COUNT(CASE WHEN rmp_cleaned.would_take_again_percent IS NOT NULL THEN 1 END) > 0 
            THEN ROUND(
              SUM(CASE WHEN rmp_cleaned.would_take_again_percent IS NOT NULL 
                  THEN rmp_cleaned.would_take_again_percent * COALESCE(rmp_cleaned.num_ratings, 1) 
                  ELSE 0 END) / 
              SUM(CASE WHEN rmp_cleaned.would_take_again_percent IS NOT NULL 
                  THEN COALESCE(rmp_cleaned.num_ratings, 1) 
                  ELSE 0 END), 2)
            ELSE NULL 
          END as section_avg_would_take_again
        FROM sections
        LEFT JOIN section_instructors si ON sections.section_id = si.section_id
        LEFT JOIN rmp_cleaned ON si.instructor_name = rmp_cleaned.full_name
        WHERE sections.course_uuid IN (${coursePlaceholders})
        GROUP BY sections.section_id, sections.course_uuid, sections.unique_section_id, sections.status, 
                 sections.available_seats, sections.waitlist_total, sections.capacity, 
                 sections.enrolled, sections.instruction_mode, sections.is_asynchronous, sections.section_requisites
      )
      SELECT 
        sra.*,
        si.instructor_name,
        rmp.avg_rating as instructor_avg_rating,
        rmp.avg_difficulty as instructor_avg_difficulty,
        rmp.num_ratings as instructor_num_ratings,
        rmp.legacy_id as rmp_instructor_id,
        rmp.would_take_again_percent as instructor_would_take_again_percent,
        sm.meeting_number,
        sm.meeting_days,
        sm.start_time,
        sm.end_time,
        sm.meeting_type,
        sm.building_name,
        sm.room,
        sm.location,
        sm.monday_meeting_start,
        sm.monday_meeting_end,
        sm.tuesday_meeting_start,
        sm.tuesday_meeting_end,
        sm.wednesday_meeting_start,
        sm.wednesday_meeting_end,
        sm.thursday_meeting_start,
        sm.thursday_meeting_end,
        sm.friday_meeting_start,
        sm.friday_meeting_end
      FROM section_rmp_avg sra
      LEFT JOIN section_instructors si ON sra.section_id = si.section_id
      LEFT JOIN rmp_cleaned rmp ON si.instructor_name = rmp.full_name
      LEFT JOIN section_meetings sm ON sra.unique_section_id = sm.unique_section_id
      ORDER BY sra.course_uuid, sra.status DESC, si.instructor_name, sm.meeting_number
    `;

    const [sectionsResults] = await pool.execute(
      sectionsWithRmpAndMeetingsSql,
      courseUuidList
    );

    console.log("=== SECTIONS WITH RMP AND MEETINGS RESULTS ===");
    console.log("Total rows returned:", sectionsResults.length);
    console.log("First few rows:", sectionsResults.slice(0, 3));
    console.log("===============================================");

    // Group sections by course_uuid and section, including meetings - UPDATED to use course_uuid
    const sectionsByCourseUuid = {};

    if (Array.isArray(sectionsResults)) {
      sectionsResults.forEach((row) => {
        if (!sectionsByCourseUuid[row.course_uuid]) {
          sectionsByCourseUuid[row.course_uuid] = {};
        }

        // Use unique_section_id as key to group instructors and meetings by section
        if (!sectionsByCourseUuid[row.course_uuid][row.unique_section_id]) {
          sectionsByCourseUuid[row.course_uuid][row.unique_section_id] = {
            section_id: row.section_id,
            unique_section_id: row.unique_section_id,
            status: row.status,
            available_seats: row.available_seats,
            waitlist_total: row.waitlist_total,
            capacity: row.capacity,
            enrolled: row.enrolled,
            instruction_mode: row.instruction_mode,
            is_asynchronous: row.is_asynchronous,
            section_requisites: row.section_requisites,
            instructors: [],
            meetings: [], // New: array to store meeting times
            // Pre-calculated section-level averages from SQL
            section_avg_rating: row.section_avg_rating,
            section_avg_difficulty: row.section_avg_difficulty,
            section_total_ratings: row.section_total_ratings,
            section_avg_would_take_again: row.section_avg_would_take_again,
          };
        }

        // Add instructor if it exists and isn't already added
        if (row.instructor_name) {
          const existingInstructor = sectionsByCourseUuid[row.course_uuid][
            row.unique_section_id
          ].instructors.find((inst) => inst.name === row.instructor_name);

          if (!existingInstructor) {
            const instructorData = {
              name: row.instructor_name,
              avg_rating: row.instructor_avg_rating,
              avg_difficulty: row.instructor_avg_difficulty,
              num_ratings: row.instructor_num_ratings,
              would_take_again_percent: row.instructor_would_take_again_percent,
              rmp_instructor_id: row.rmp_instructor_id,
            };

            sectionsByCourseUuid[row.course_uuid][
              row.unique_section_id
            ].instructors.push(instructorData);
          }
        }

        // Add meeting if it exists and isn't already added
        if (row.meeting_number !== null && row.meeting_number !== undefined) {
          const existingMeeting = sectionsByCourseUuid[row.course_uuid][
            row.unique_section_id
          ].meetings.find(
            (meeting) =>
              meeting.meeting_number === row.meeting_number &&
              meeting.meeting_days === row.meeting_days &&
              meeting.start_time === row.start_time &&
              meeting.end_time === row.end_time &&
              meeting.meeting_type === row.meeting_type &&
              meeting.building_name === row.building_name &&
              meeting.room === row.room
          );

          if (!existingMeeting) {
            const meetingData = {
              meeting_number: row.meeting_number,
              meeting_days: row.meeting_days,
              meeting_type: row.meeting_type,
              start_time: row.start_time,
              end_time: row.end_time,
              building_name: row.building_name,
              room: row.room,
              location: row.location,
              // Add day-specific millisecond times for frontend use
              monday_meeting_start: row.monday_meeting_start,
              monday_meeting_end: row.monday_meeting_end,
              tuesday_meeting_start: row.tuesday_meeting_start,
              tuesday_meeting_end: row.tuesday_meeting_end,
              wednesday_meeting_start: row.wednesday_meeting_start,
              wednesday_meeting_end: row.wednesday_meeting_end,
              thursday_meeting_start: row.thursday_meeting_start,
              thursday_meeting_end: row.thursday_meeting_end,
              friday_meeting_start: row.friday_meeting_start,
              friday_meeting_end: row.friday_meeting_end,
            };

            sectionsByCourseUuid[row.course_uuid][
              row.unique_section_id
            ].meetings.push(meetingData);
          }
        }
      });
    }

    // Convert sections object to array for each course_uuid
    Object.keys(sectionsByCourseUuid).forEach((courseUuid) => {
      sectionsByCourseUuid[courseUuid] = Object.values(
        sectionsByCourseUuid[courseUuid]
      );
    });

    // Combine courses with their sections - UPDATED to use course_uuid
    const coursesWithSections = coursesResults.map((course) => {
      return {
        ...course,
        sections: sectionsByCourseUuid[course.course_uuid] || [],
      };
    });

    console.log("=== FINAL COURSES WITH SECTIONS AND MEETINGS ===");
    console.log(`Total courses: ${coursesWithSections.length}`);
    coursesWithSections.forEach((course) => {
      console.log(
        `Course ${course.course_uuid}: ${course.sections.length} sections`
      );
      course.sections.forEach((section) => {
        console.log(
          `  Section ${section.unique_section_id}: rating=${section.section_avg_rating}, ${section.meetings.length} meetings`
        );
      });
    });

    return c.json({
      data: coursesWithSections,
      count: coursesWithSections.length,
      total_count: totalCount,
      has_more: hasMore,
      filters_applied: {
        status,
        min_available_seats,
        instruction_mode,
        min_section_avg_rating,
        min_section_avg_difficulty,
        min_section_total_ratings,
        min_section_avg_would_take_again,
        meeting_days,
        mondayStartTime,
        mondayEndTime,
        tuesdayStartTime,
        tuesdayEndTime,
        wednesdayStartTime,
        wednesdayEndTime,
        thursdayStartTime,
        thursdayEndTime,
        fridayStartTime,
        fridayEndTime,
        building_name,
        sort,
      },
    });
  } catch (error) {
    console.error("Error in /api/query:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// Health check endpoint
app.get("/health", async (c) => {
  try {
    await pool.execute("SELECT 1");
    return c.json({ status: "healthy", database: "connected" });
  } catch (error) {
    return c.json({ status: "unhealthy", database: "disconnected" }, 500);
  }
});

Bun.serve({
  port: Bun.env.PORT ?? 3000,
  fetch: app.fetch,
});