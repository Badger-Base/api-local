# GET /api/query — Parameter Reference

All parameters are query string parameters. All are optional. Results are paginated and return courses with their full section details.

## Enrollment Status

### `status`

**Course-level filter.** Determines which courses are returned based on the enrollment state across all of their sections. All sections of matched courses are always included in the response.

| Value | Meaning |
|---|---|
| `OPEN` | At least one section of the course has open seats |
| `WAITLISTED` | At least one section of the course has waitlist availability |
| `CLOSED` | **None** of the course's sections have open seats or waitlist — every section is closed |

Comma-separated values combine with OR logic: `status=OPEN,WAITLISTED` returns courses that have at least one open OR at least one waitlisted section. `status=OPEN,CLOSED` returns courses that are either open or fully closed.

Note the asymmetry: OPEN and WAITLISTED use "at least one section matches" logic, while CLOSED uses "all sections match" logic. A course with 3 OPEN sections and 1 CLOSED section matches `status=OPEN` but NOT `status=CLOSED`.

### `min_available_seats`

Section-level filter. Courses must have at least one section with `available_seats >= value`.

### `instruction_mode`

Section-level filter. Courses must have at least one section matching this instruction mode (e.g., `In Person`, `Online`).

## Credits

### `min_credits`

Course-level filter. `courses.minimum_credits >= value`. A course with `minimum_credits=3` passes `min_credits=2` but fails `min_credits=4`.

### `max_credits`

Course-level filter. `courses.maximum_credits <= value`. A course with `maximum_credits=5` passes `max_credits=5` but fails `max_credits=4`.

When used together, `min_credits=2&max_credits=4` returns courses whose credit range fits entirely within [2, 4] — both the floor and ceiling of the course's credit range must fall within the bounds.

## Course Attributes

### `level`

Exact match on course level. Values: `Elementary`, `Intermediate`, `Advanced`, `Basic`.

### `gen_ed`

Exact match on general education designation (e.g., `COM B`).

### `l_and_s`

Boolean flag. If present, filters to courses with `letters_and_science_credits = 'C'`.

### Breadth Requirements

All boolean flags. If present, filters to courses that satisfy the requirement.

| Parameter | Breadth Requirement | DB value matched |
|---|---|---|
| `ethnic_studies` | Ethnic Studies | `ETHNIC ST` |
| `social_science` | Social Science | `S` |
| `humanities` | Humanities | `H` |
| `biological_science` | Biological Science | `B` |
| `physical_science` | Physical Science | `P` |
| `natural_science` | Natural Science | `N` |
| `literature` | Literature | `L` |

Multiple breadth parameters combine with AND: `humanities=true&literature=true` returns courses that satisfy both.

## Prerequisites

### `no_prereqs`, `sophomore_standing`, `junior_standing`, `senior_standing`

Boolean flags. When multiple are provided, they combine with **OR** logic. `no_prereqs=true&sophomore_standing=true` returns courses that have no prerequisites OR require only sophomore standing.

## Grades and GPA

### `min_cumulative_gpa`

Course-level filter. `madgrades_course_grades.cumulative_gpa >= value`.

### `min_most_recent_gpa`

Course-level filter. `madgrades_course_grades.most_recent_gpa >= value`.

### `min_a_percent`

Course-level filter. `madgrades_course_grades.a_percentage >= value`.

### `median_grade`

Exact match on median letter grade (e.g., `A`, `AB`, `B`, `BC`, `C`).

## RateMyProfessors (Section-Level)

These filter based on section-level RMP aggregates — each section's RMP score is a weighted average across all instructors teaching that section. Courses must have at least one section meeting the threshold.

### `min_section_avg_rating`

Minimum section-level average RMP rating (e.g., `4.0`).

### `min_section_avg_difficulty`

Minimum section-level average difficulty (e.g., `3.0`).

### `min_section_total_ratings`

Minimum total RMP ratings across a section's instructors.

### `min_section_avg_would_take_again`

Minimum section-level average would-take-again percentage.

## Meeting Time Filters

Schedule-based filters use milliseconds-since-midnight format. Each day accepts comma-separated lists for multiple time windows.

### `{day}StartTime` / `{day}EndTime`

Days: `monday`, `tuesday`, `wednesday`, `thursday`, `friday`.

Filters **out** sections whose meetings conflict with the specified availability windows. A section is excluded if any of its meetings start before the start time or end after the end time on that day.

When time filters are specified for some days, sections that meet on **unfiltered** days are also excluded — the filter assumes availability only on the specified days.

### `in_person_only`

Boolean flag. Excludes sections with location `ONLINE` or `OFF CAMPUS`.

### `building_name`

Not yet implemented in filtering (parameter is accepted but unused in WHERE clause).

## Search

### `search_param`

Free-text search across `course_designation`, `course_title`, `full_course_designation`, and `instructor_name`. Uses `LIKE %value%` matching.

## Sorting

### `sort`

| Value | Behavior |
|---|---|
| *(default)* | `ORDER BY courses.catalog_number ASC` |
| `cumulative_gpa` | `ORDER BY madgrades_course_grades.cumulative_gpa DESC` |
| `recent_gpa` | `ORDER BY madgrades_course_grades.most_recent_gpa DESC` |

## Pagination

### `page`

1-indexed page number. Default: `1`.

### `limit`

Results per page. Default: `10`.

## Filter Interaction Summary

- **AND** across different filter groups: status AND credits AND level AND breadth, etc.
- **OR** within prerequisite filters: `no_prereqs + sophomore_standing` is OR.
- **OR** within comma-separated status values: `OPEN,WAITLISTED` is OR.
- **AND** within breadth requirements: `humanities + literature` is AND.
- Status is a **course-level** concept — sections are never removed from the response. You always see all sections of every matched course.
