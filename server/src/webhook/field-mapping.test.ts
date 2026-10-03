import { describe, it, expect } from "vitest";
import {
  planSubmissionFields,
  normalizeLabel,
  isEmptyAnswer,
  type MatchedField,
} from "./field-mapping.js";

// -----------------------------------------------------------------------------
// The webhook's answer-matching rules (docs/plans/google-form-undefined-fields.md §8).
//
// This file exists because the API could only ever store an answer that pointed
// at a PRE-DEFINED form field by numeric id: `submissionAnswerSchema` requires
// `field_id`, and `submission_values.field_id` is a foreign key to
// `form_fields(id)`. A Google Form whose questions were never defined in this
// app's designer therefore failed outright. `planSubmissionFields` is the pure
// half of the fix — it decides which answers land on a defined field and which
// are captured as per-submission text fields — and every edge case lives here,
// so it is where the interesting tests belong (no DB needed).
//
// Each test is named for the real-world defect it prevents, so a failure reads
// as a symptom rather than as an assertion.
// -----------------------------------------------------------------------------

const FIELDS: MatchedField[] = [
  { id: 9, label: "Student Name", type: "text" },
  { id: 10, label: "School", type: "text" },
];

const SCHOOL_LABELS = ["school", "school name"];

describe("planSubmissionFields — capture path", () => {
  it("captures EVERY answer when the form has no defined fields", () => {
    // The headline case: a Google Form nobody has designed in this app.
    const plan = planSubmissionFields(
      [],
      [
        { label: "Student name", value: "Ada" },
        { label: "Grade", value: "9" },
      ],
      SCHOOL_LABELS
    );
    expect(plan.values).toEqual([]);
    expect(plan.captured.map((c) => c.label)).toEqual(["Student name", "Grade"]);
    expect(plan.captured.map((c) => c.sort_order)).toEqual([0, 1]);
  });

  it("splits a partially matching payload between values and captured", () => {
    const plan = planSubmissionFields(
      FIELDS,
      [
        { label: "Student Name", value: "Ada" },
        { label: "Something new", value: "x" },
      ],
      SCHOOL_LABELS
    );
    expect(plan.values).toEqual([{ field_id: 9, value: "Ada" }]);
    expect(plan.captured.map((c) => c.label)).toEqual(["Something new"]);
  });

  it("creates ONE captured field per title when a payload repeats it", () => {
    const plan = planSubmissionFields(
      [],
      [
        { label: "Course", value: "English" },
        { label: " course ", value: "Maths" },
      ],
      SCHOOL_LABELS
    );
    expect(plan.captured).toEqual([{ label: "Course", value: "English", sort_order: 0 }]);
  });

  it("truncates a title longer than the NVARCHAR(200) label column", () => {
    const plan = planSubmissionFields([], [{ label: "x".repeat(500), value: "v" }], SCHOOL_LABELS);
    expect(plan.captured[0].label).toHaveLength(200);
  });
});

describe("planSubmissionFields — matching", () => {
  it("prefers field_id over a label that names a DIFFERENT field", () => {
    // The Apps Script sends both when it can resolve the title. If the label
    // ever won here, a renamed Google Form question would silently write its
    // answer into the wrong field.
    const plan = planSubmissionFields(
      FIELDS,
      [{ field_id: 9, label: "School", value: "Ada" }],
      SCHOOL_LABELS
    );
    expect(plan.values).toEqual([{ field_id: 9, value: "Ada" }]);
    expect(plan.captured).toEqual([]);
  });

  it("falls back to the label when field_id is not on THIS form", () => {
    // An id from another form's numbering must not become a FK violation.
    const plan = planSubmissionFields(
      FIELDS,
      [{ field_id: 999, label: "Student Name", value: "Ada" }],
      SCHOOL_LABELS
    );
    expect(plan.values).toEqual([{ field_id: 9, value: "Ada" }]);
  });

  it("captures an answer whose field_id AND label both miss (never dropped)", () => {
    const plan = planSubmissionFields(
      FIELDS,
      [{ field_id: 999, label: "Nope", value: "Ada" }],
      SCHOOL_LABELS
    );
    expect(plan.values).toEqual([]);
    expect(plan.captured.map((c) => c.label)).toEqual(["Nope"]);
  });

  it("matches a title case- and whitespace-insensitively", () => {
    // "titles must EXACTLY match labels" was the old rule, and it is why a
    // question typo lost an answer outright.
    const plan = planSubmissionFields(
      FIELDS,
      [{ label: "  student name  ", value: "Ada" }],
      SCHOOL_LABELS
    );
    expect(plan.values).toEqual([{ field_id: 9, value: "Ada" }]);
  });

  it("resolves a field_id that arrives as a STRING (the driver's real behaviour)", () => {
    // `form_fields.id` comes back from SQL Server as text while the wire id is a
    // number, and `Map.get` compares with SameValueZero — `"9"` never matches 9.
    // If this test fails, EVERY answer of every matched submission is captured.
    const plan = planSubmissionFields(
      FIELDS,
      [{ field_id: "9" as unknown as number, label: "ignored", value: "Ada" }],
      SCHOOL_LABELS
    );
    expect(plan.values).toEqual([{ field_id: 9, value: "Ada" }]);
    expect(plan.captured).toEqual([]);
  });
});

describe("planSubmissionFields — blank vs real answers", () => {
  it("drops blank answers but KEEPS false and 0", () => {
    // false/0 are answers a parent gave, matching the client's
    // `FieldValue.isEmpty` rule. An unchecked checkbox must not vanish.
    const plan = planSubmissionFields(
      [],
      [
        { label: "Empty string", value: "" },
        { label: "Whitespace", value: "   " },
        { label: "Null", value: null },
        { label: "Empty array", value: [] },
        { label: "False", value: false },
        { label: "Zero", value: 0 },
      ],
      SCHOOL_LABELS
    );
    expect(plan.captured.map((c) => c.label)).toEqual(["False", "Zero"]);
  });
});

describe("planSubmissionFields — value shaping", () => {
  it("flattens an array so a captured checkbox reads as text", () => {
    // Captured fields are stored as `text`, and only collection types decode
    // JSON on read — so an array stored raw would read back as '["a","b"]'.
    const plan = planSubmissionFields(
      [],
      [{ label: "Courses", value: ["Maths", "English"] }],
      SCHOOL_LABELS
    );
    expect(plan.captured[0].value).toBe("Maths, English");
  });

  it("leaves an array INTACT for a matched field (its type decodes JSON)", () => {
    const plan = planSubmissionFields(
      FIELDS,
      [{ field_id: 9, value: ["a", "b"] }],
      SCHOOL_LABELS
    );
    expect(plan.values[0].value).toEqual(["a", "b"]);
  });
});

describe("planSubmissionFields — school routing", () => {
  it("takes the school name from a captured 'School Name' answer", () => {
    // A district-wide form with no defined fields is exactly the case where the
    // defined-field lookup finds nothing and the raw title is the only signal.
    const plan = planSubmissionFields(
      [],
      [{ label: "School Name", value: "Broughton High School" }],
      SCHOOL_LABELS
    );
    expect(plan.schoolName).toBe("Broughton High School");
  });

  it("takes the school name from a MATCHED 'School' field too", () => {
    const plan = planSubmissionFields(
      FIELDS,
      [{ field_id: 10, value: "Broughton High School" }],
      SCHOOL_LABELS
    );
    expect(plan.schoolName).toBe("Broughton High School");
  });

  it("leaves schoolName null when no answer names a school", () => {
    const plan = planSubmissionFields(FIELDS, [{ field_id: 9, value: "Ada" }], SCHOOL_LABELS);
    expect(plan.schoolName).toBeNull();
  });
});

describe("normalizeLabel / isEmptyAnswer", () => {
  it("normalizeLabel trims and case-folds", () => {
    expect(normalizeLabel("  Student NAME ")).toBe("student name");
  });

  it("isEmptyAnswer treats blank/null/[] as empty and false/0 as answers", () => {
    for (const blank of ["", "  ", null, undefined, []]) {
      expect(isEmptyAnswer(blank as never), JSON.stringify(blank)).toBe(true);
    }
    for (const real of ["a", 0, false, ["a"]]) {
      expect(isEmptyAnswer(real as never), JSON.stringify(real)).toBe(false);
    }
  });
});

