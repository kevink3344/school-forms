import { describe, it, expect } from "vitest";
import {
  planSubmissionFields,
  adhocRowsMatchingLabel,
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
  // `School` is the ALREADY-BOUND field, so the collision guard has something to
  // collide with: item 555 belongs to it and must never be re-learned by another
  // field (see the "item_id" block at the end of this file).
  { id: 10, label: "School", type: "text", source_item_id: "555" },
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

// -----------------------------------------------------------------------------
// Promotion must migrate exactly the rows the CAPTURE path would have matched
// against a field with that label (docs/plans/google-form-undefined-fields.md
// §11). If the two rules ever diverge, an admin creating the "right" field would
// silently strand answers on some submissions and not others — and only the ones
// with the odd capitalisation would be visibly wrong.
// -----------------------------------------------------------------------------
describe("adhocRowsMatchingLabel — promotion selects what capture would", () => {
  const rows = [
    { id: 1, label: "Student ID" },
    { id: 2, label: "  student id  " },
    { id: 3, label: "Student Name" },
    { id: 4, label: "STUDENT ID" },
  ];

  it("matches a title case- and whitespace-insensitively", () => {
    expect(adhocRowsMatchingLabel(rows, "Student ID").map((r) => r.id)).toEqual([1, 2, 4]);
  });

  it("leaves a different title alone", () => {
    expect(adhocRowsMatchingLabel(rows, "Student Name").map((r) => r.id)).toEqual([3]);
  });

  it("returns NOTHING when no row matches, rather than everything", () => {
    // The failure that matters: a promote that migrated rows it did not match
    // would rewrite other questions' answers.
    expect(adhocRowsMatchingLabel(rows, "Nope")).toEqual([]);
  });

  it("does not match on a substring", () => {
    // "Student" must not sweep up both "Student ID" and "Student Name".
    expect(adhocRowsMatchingLabel(rows, "Student")).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Retitle-resilience (`form_fields.source_item_id`,
// docs/plans/google-form-undefined-fields.md §15).
//
// The incident these prevent: a question titled "Course choice #1" was retitled in
// Google. The Apps Script resolves `field_id` by TITLE, so the retitle removed
// `field_id` from the payload entirely; the answer matched no field, was captured
// as ad-hoc text, and the mapped column went silently blank for 68 submissions
// before anyone noticed. Google's own item id is the one identity a retitle
// cannot destroy — so these tests are about (a) a renamed question still landing
// on its field, and (b) the binding being LEARNED from ordinary traffic rather
// than configured, because there is no backfill anyone could run.
// -----------------------------------------------------------------------------
describe("planSubmissionFields — item_id (surviving a question retitle)", () => {
  it("resolves a RENAMED question through the field's stored item id", () => {
    // ★ The headline case. The title is new so the label cannot match, and the
    // Apps Script could not resolve `field_id` for the same reason — `item_id` is
    // the only thing left that identifies the question. Without this the answer
    // is captured instead, which is exactly what happened in production.
    const plan = planSubmissionFields(
      FIELDS,
      [{ label: "Course choice #1 (2026-27)", item_id: "555", value: "Spanish" }],
      SCHOOL_LABELS
    );
    expect(plan.values).toEqual([{ field_id: 10, value: "Spanish" }]);
    expect(plan.captured).toEqual([]);
  });

  it("still CAPTURES a renamed question when the field was never bound", () => {
    // The honest limit of the fix, and it must not silently become a value: with
    // no stored item id there is nothing to match on, so the answer is captured
    // (never dropped). This submission is also what teaches the binding below.
    const plan = planSubmissionFields(
      FIELDS,
      [{ label: "Course choice #1 (2026-27)", item_id: "777", value: "Spanish" }],
      SCHOOL_LABELS
    );
    expect(plan.values).toEqual([]);
    expect(plan.captured.map((c) => c.label)).toEqual(["Course choice #1 (2026-27)"]);
  });

  it("does NOT let item_id outrank a title that still matches", () => {
    // The new tier is LAST on purpose: every payload that resolves today must go
    // on resolving to the same field. Here the title says `Student Name` (9) while
    // the item id belongs to `School` (10) — an inconsistency that only a stale
    // binding could produce. The title wins, so nothing is remapped.
    const plan = planSubmissionFields(
      FIELDS,
      [{ label: "Student Name", item_id: "555", value: "Ada" }],
      SCHOOL_LABELS
    );
    expect(plan.values).toEqual([{ field_id: 9, value: "Ada" }]);
  });

  it("learns the binding on first sight, from a title match", () => {
    // How the column is populated at all. `Student Name` (9) has no item id, and
    // the answer still carries the old title, so this is the moment the pairing is
    // provable — and the only moment, since the next submission may be renamed.
    const plan = planSubmissionFields(
      FIELDS,
      [{ field_id: 9, label: "Student Name", item_id: "123", value: "Ada" }],
      SCHOOL_LABELS
    );
    expect(plan.learned).toEqual([{ field_id: 9, item_id: "123" }]);
  });

  it("learns it from a LABEL-only match too (a form with no resolvable field_id)", () => {
    const plan = planSubmissionFields(
      FIELDS,
      [{ label: "Student Name", item_id: "123", value: "Ada" }],
      SCHOOL_LABELS
    );
    expect(plan.learned).toEqual([{ field_id: 9, item_id: "123" }]);
  });

  it("proposes NOTHING once the field is already bound (the steady state)", () => {
    // If this ever fails, every submission of every form issues an UPDATE forever
    // — a silent write on the hot path for no benefit.
    const plan = planSubmissionFields(
      FIELDS,
      [{ label: "School", item_id: "555", value: "Broughton" }],
      SCHOOL_LABELS
    );
    expect(plan.learned).toEqual([]);
  });

  it("proposes NOTHING when the answer carries no item_id", () => {
    // Every payload from an un-updated Apps Script takes this path, so it must
    // stay a no-op rather than binding a field to nothing.
    const plan = planSubmissionFields(
      FIELDS,
      [{ field_id: 9, label: "Student Name", value: "Ada" }],
      SCHOOL_LABELS
    );
    expect(plan.learned).toEqual([]);
  });

  it("never gives ONE item id two owners", () => {
    // Item 555 already belongs to `School` (10). If `Student Name` (9) could claim
    // it too, a later retitle would have two fields eligible for the same question
    // and no rule to choose between them.
    const plan = planSubmissionFields(
      FIELDS,
      [{ field_id: 9, label: "Student Name", item_id: "555", value: "Ada" }],
      SCHOOL_LABELS
    );
    expect(plan.learned).toEqual([]);
  });

  it("binds an item id to at most ONE field when a payload repeats it", () => {
    // A duplicated answer is malformed, so the outcome must be deterministic
    // rather than "whichever field the payload happened to list last".
    const plan = planSubmissionFields(
      FIELDS,
      [
        { field_id: 9, label: "Student Name", item_id: "123", value: "Ada" },
        { field_id: 9, label: "Student Name", item_id: "123", value: "Ada" },
      ],
      SCHOOL_LABELS
    );
    expect(plan.learned).toEqual([{ field_id: 9, item_id: "123" }]);
  });

  it("folds a NUMBER item id onto the stored string, so a field cannot acquire two", () => {
    // `item.getId()` reaches us through a JSON payload a spreadsheet can coerce.
    // `123` and `"123"` must be one identity or the guard above compares nothing.
    const plan = planSubmissionFields(
      FIELDS,
      [{ field_id: 9, label: "Student Name", item_id: 123, value: "Ada" }],
      SCHOOL_LABELS
    );
    expect(plan.learned).toEqual([{ field_id: 9, item_id: "123" }]);
  });

  it("truncates an absurd item id to the column's 64 chars instead of failing", () => {
    // Same rule the captured LABEL follows: a value that does not fit is
    // shortened, never allowed to 400 or 500 a parent's submission.
    const plan = planSubmissionFields(
      FIELDS,
      [{ field_id: 9, label: "Student Name", item_id: "9".repeat(500), value: "Ada" }],
      SCHOOL_LABELS
    );
    expect(plan.learned).toEqual([{ field_id: 9, item_id: "9".repeat(64) }]);
  });

  it("ignores a blank item id rather than binding on empty", () => {
    const plan = planSubmissionFields(
      FIELDS,
      [{ field_id: 9, label: "Student Name", item_id: "   ", value: "Ada" }],
      SCHOOL_LABELS
    );
    expect(plan.learned).toEqual([]);
  });

  it("leaves a blank field's answer alone (nothing to bind)", () => {
    // A blank answer is skipped before matching, so it can never teach a binding.
    const plan = planSubmissionFields(
      FIELDS,
      [{ field_id: 9, label: "Student Name", item_id: "123", value: "" }],
      SCHOOL_LABELS
    );
    expect(plan.values).toEqual([]);
    expect(plan.learned).toEqual([]);
  });

  it("binds every unbound field from a single submission", () => {
    // The real shape of the first submission after deployment: no field is bound
    // yet, so one payload teaches the whole mapping at once.
    const unbound: MatchedField[] = [
      { id: 9, label: "Student Name", type: "text" },
      { id: 10, label: "School", type: "text" },
    ];
    const plan = planSubmissionFields(
      unbound,
      [
        { field_id: 9, label: "Student Name", item_id: "123", value: "Ada" },
        { label: "School", item_id: "555", value: "Broughton" },
      ],
      SCHOOL_LABELS
    );
    expect(plan.learned).toEqual([
      { field_id: 9, item_id: "123" },
      { field_id: 10, item_id: "555" },
    ]);
  });
});

