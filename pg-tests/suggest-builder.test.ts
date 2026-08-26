import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { setupTestDb, type TestDb } from "./setup.ts";
import { fixture } from "./fixtures/default.ts";
import {
  searchCourses,
  searchInstructors,
  mergeSuggestions,
  escapeLikePattern,
  type ScoredSuggestion,
} from "../pg/builders/suggest.ts";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await setupTestDb();
  await testDb.seed(fixture);
});

afterAll(async () => {
  await testDb.teardown();
});

const values = (rows: ScoredSuggestion[]) => rows.map((r) => r.value);

describe("escapeLikePattern", () => {
  it("escapes LIKE wildcards so they match literally", () => {
    expect(escapeLikePattern("100%_x")).toBe("100\\%\\_x");
  });

  it("escapes backslashes before wildcards", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });
});

describe("searchCourses", () => {
  it("returns an exact designation match first", async () => {
    const rows = await searchCourses(testDb.db, "COMP SCI 200", 8);
    expect(rows[0].value).toBe("COMP SCI 200");
    expect(rows[0].type).toBe("course");
  });

  it("ranks prefix matches above fuzzy-only matches", async () => {
    const rows = await searchCourses(testDb.db, "COMP SCI 5", 8);
    const top = rows.slice(0, 2).map((r) => r.value);
    expect(top).toContain("COMP SCI 540");
    expect(top).toContain("COMP SCI 577");
    // A fuzzy-only match must not outrank a literal prefix match.
    expect(rows[0].score).toBeGreaterThanOrEqual(2.0);
  });

  it("tolerates a typo in the designation", async () => {
    const rows = await searchCourses(testDb.db, "COMP SIC 200", 8);
    expect(values(rows)).toContain("COMP SCI 200");
  });

  it("matches on course title words", async () => {
    const rows = await searchCourses(testDb.db, "Algorithms", 8);
    expect(values(rows)).toContain("COMP SCI 577");
  });

  it("carries the title as sublabel and the uuid", async () => {
    const rows = await searchCourses(testDb.db, "COMP SCI 200", 8);
    expect(rows[0].sublabel).toBe("Programming I");
    expect(rows[0].course_uuid).toBe("uuid-cs200");
  });

  it("respects the limit", async () => {
    const rows = await searchCourses(testDb.db, "COMP SCI", 2);
    expect(rows.length).toBe(2);
  });

  it("treats % as a literal character, not a wildcard", async () => {
    const rows = await searchCourses(testDb.db, "%", 8);
    expect(rows.length).toBe(0);
  });

  it("is deterministic across repeated runs", async () => {
    const a = await searchCourses(testDb.db, "COMP SCI", 8);
    const b = await searchCourses(testDb.db, "COMP SCI", 8);
    expect(values(a)).toEqual(values(b));
  });
});

describe("searchInstructors", () => {
  it("tolerates a typo in the instructor name", async () => {
    const rows = await searchInstructors(testDb.db, "Willliams", 8);
    expect(values(rows)).toContain("Jim Williams");
  });

  it("returns an instructor once regardless of section count", async () => {
    const rows = await searchInstructors(testDb.db, "Jim Williams", 8);
    const hits = rows.filter((r) => r.value === "Jim Williams");
    expect(hits.length).toBe(1);
  });

  it("reports the section count in the sublabel", async () => {
    const rows = await searchInstructors(testDb.db, "Jim Williams", 8);
    expect(rows[0].sublabel).toBe("Instructor · 3 sections");
  });

  it("singularizes a one-section instructor", async () => {
    const rows = await searchInstructors(testDb.db, "Math Teacher", 8);
    expect(rows[0].sublabel).toBe("Instructor · 1 section");
  });

  it("has a null course_uuid", async () => {
    const rows = await searchInstructors(testDb.db, "Jim Williams", 8);
    expect(rows[0].course_uuid).toBeNull();
  });
});

describe("mergeSuggestions", () => {
  const course = (value: string, score: number): ScoredSuggestion => ({
    type: "course", value, label: value, sublabel: null, course_uuid: "u", score,
  });
  const instructor = (value: string, score: number): ScoredSuggestion => ({
    type: "instructor", value, label: value, sublabel: null, course_uuid: null, score,
  });

  it("sorts by score descending", () => {
    const merged = mergeSuggestions([course("a", 1.0)], [instructor("b", 2.0)], 8);
    expect(merged.map((m) => m.value)).toEqual(["b", "a"]);
  });

  it("truncates to the limit", () => {
    const merged = mergeSuggestions(
      [course("a", 3), course("b", 2), course("c", 1)], [], 2
    );
    expect(merged.length).toBe(2);
  });

  it("guarantees an instructor slot when courses would fill every slot", () => {
    const merged = mergeSuggestions(
      [course("a", 3.0), course("b", 2.9)], [instructor("prof", 0.4)], 2
    );
    expect(merged.map((m) => m.value)).toEqual(["a", "prof"]);
  });

  it("does not force an instructor slot when there are no instructors", () => {
    const merged = mergeSuggestions([course("a", 3.0), course("b", 2.9)], [], 2);
    expect(merged.map((m) => m.value)).toEqual(["a", "b"]);
  });

  it("strips the score from its output", () => {
    const merged = mergeSuggestions([course("a", 3.0)], [], 8);
    expect("score" in merged[0]).toBe(false);
  });
});
