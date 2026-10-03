import { describe, it, expect } from "vitest";
import {
  createSubmissionSchema,
  createWebhookSubmissionSchema,
  promoteAdhocFieldSchema,
  submissionAnswerSchema,
  updateFormSchema,
  updateSubmissionValuesSchema,
} from "./schemas.js";

// -----------------------------------------------------------------------------
// The webhook's inbound contract.
//
// This file exists because the API shipped an inbound schema that REFUSED the
// ids the API itself served. `GET /api/forms/:id/public` hands out `fields[].id`;
// the Google Apps Script reads `field.id` and echoes it back verbatim as
// `field_id`. When that value arrives as TEXT — a JSON number round-tripped
// through a spreadsheet cell, a `String(...)` in the caller, or any client that
// stores ids as strings — `z.number()` answered:
//
//   400 {"error":"Validation failed","details":{"formErrors":[],"fieldErrors":
//        {"answers":["Expected number, received string"]}}}
//
// reproduced live with 11 identical entries: the production webhook rejected
// every single answer of a submission. JSON has no integer type, so a
// transmitted id must be read with `z.coerce`.
//
// ★ CORRECTION (2026-10-03). This header used to end "the server-minted ids
// elsewhere (form_fields.id on the admin design path) legitimately stay strict."
// That exemption was wrong, and it is the reason the same bug shipped a second
// time: saving a form description in staging failed with 13 identical entries
// under the key `fields`. The designer does not mint those ids — it LOADS them
// from `GET /api/forms/:id` and sends them back, so on a driver that returns
// numeric columns as text they arrive as `"37"` and the API refused ids it had
// just served. Who mints an id says nothing about what the wire carries.
// `fieldSchema.id` is `z.coerce` for that reason; see the note there.
// -----------------------------------------------------------------------------

const STRING_IDS = {
  form_id: "2",
  answers: [
    { field_id: "9", value: "Ada" },
    { field_id: "10", value: "2015-04-02" },
  ],
};

const NUMBER_IDS = {
  form_id: 2,
  answers: [
    { field_id: 9, value: "Ada" },
    { field_id: 10, value: "2015-04-02" },
  ],
};

describe("createSubmissionSchema — transmitted ids", () => {
  it("accepts numeric ids (must keep working)", () => {
    const parsed = createSubmissionSchema.safeParse(NUMBER_IDS);
    expect(parsed.success).toBe(true);
  });

  it("accepts ids that arrive as text (the production webhook bug)", () => {
    const parsed = createSubmissionSchema.safeParse(STRING_IDS);
    if (!parsed.success) {
      throw new Error(
        `a string id was rejected: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`
      );
    }
    expect(parsed.success).toBe(true);
  });

  it("coerces a text id to a real NUMBER, so downstream === comparisons work", () => {
    // The point of the fix is not merely to stop returning 400 — it is that the
    // handler must receive numbers, because submission ids are compared with `===`
    // against values that came out of the database.
    const parsed = createSubmissionSchema.parse(STRING_IDS);
    expect(typeof parsed.form_id).toBe("number");
    expect(parsed.form_id).toBe(2);
    expect(typeof parsed.answers[0].field_id).toBe("number");
    expect(parsed.answers.map((a) => a.field_id)).toEqual([9, 10]);
  });

  it("still accepts a mixed payload (text form_id, numeric field_id)", () => {
    const parsed = createSubmissionSchema.safeParse({
      form_id: "2",
      answers: [{ field_id: 9, value: "Ada" }],
    });
    expect(parsed.success).toBe(true);
  });

  // --- failing controls: coercion must not become "accept anything" ----------

  it("CONTROL: still rejects a non-numeric id", () => {
    const parsed = createSubmissionSchema.safeParse({
      form_id: "abc",
      answers: [{ field_id: "9", value: "Ada" }],
    });
    // If this ever starts passing, the coercion is swallowing junk ids.
    expect(parsed.success).toBe(false);
  });

  it("CONTROL: still rejects a non-numeric field_id", () => {
    const parsed = createSubmissionSchema.safeParse({
      form_id: 2,
      answers: [{ field_id: "not-an-id", value: "Ada" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("CONTROL: still rejects zero and negative ids", () => {
    for (const bad of ["0", 0, "-1", -1]) {
      const parsed = createSubmissionSchema.safeParse({
        form_id: 2,
        answers: [{ field_id: bad, value: "Ada" }],
      });
      // If this ever starts passing, an id that cannot exist is being accepted.
      expect(parsed.success, `field_id=${JSON.stringify(bad)} was accepted`).toBe(false);
    }
  });

  it("CONTROL: still rejects an empty answers array", () => {
    const parsed = createSubmissionSchema.safeParse({ form_id: 2, answers: [] });
    expect(parsed.success).toBe(false);
  });
});

describe("submissionAnswerSchema — value union is unchanged", () => {
  it("keeps accepting the value shapes parents submit", () => {
    for (const value of ["text", 42, true, ["a", "b"], null]) {
      const parsed = submissionAnswerSchema.safeParse({ field_id: "9", value });
      expect(parsed.success, `value=${JSON.stringify(value)}`).toBe(true);
    }
  });
});

describe("updateSubmissionValuesSchema — shares the same answer shape", () => {
  it("accepts text ids on the staff edit path too", () => {
    const parsed = updateSubmissionValuesSchema.safeParse({
      answers: [{ field_id: "9", value: "corrected" }],
      staff_only: true,
    });
    if (!parsed.success) {
      throw new Error(
        `a string id was rejected on the staff edit path: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`
      );
    }
    expect(typeof parsed.data.answers[0].field_id).toBe("number");
  });
});

// -----------------------------------------------------------------------------
// The WEBHOOK-only answer shape (docs/plans/google-form-undefined-fields.md §5).
//
// A Google Form that was never defined in this app's designer can only identify
// its questions by TITLE, so the webhook accepts `label` as an alternative to
// `field_id`. The last control below is the important one: the IN-APP parent
// schema must still refuse a label-only answer, because loosening that path
// would let a parent's answer belong to no field at all — a designer mistake
// that is a loud 400 today and has to stay one.
// -----------------------------------------------------------------------------

describe("createWebhookSubmissionSchema — label is an acceptable identity", () => {
  it("accepts a label-only answer (the whole point: a form with no defined fields)", () => {
    const parsed = createWebhookSubmissionSchema.safeParse({
      form_id: 11,
      answers: [{ label: "Student Name", value: "Ada" }],
    });
    if (!parsed.success) {
      throw new Error(
        `a label-only answer was rejected: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`
      );
    }
    expect(parsed.data.answers[0].label).toBe("Student Name");
    expect(parsed.data.answers[0].field_id).toBeUndefined();
  });

  it("accepts an answer carrying BOTH field_id and label, and still coerces the id", () => {
    const parsed = createWebhookSubmissionSchema.safeParse({
      form_id: 11,
      answers: [{ field_id: "9", label: "Student Name", value: "Ada" }],
    });
    if (!parsed.success) throw new Error("an answer with both identities was rejected");
    // Coercion still applies, so the handler receives numbers and its `===`
    // comparisons against database values keep working.
    expect(typeof parsed.data.answers[0].field_id).toBe("number");
    expect(parsed.data.answers[0].field_id).toBe(9);
  });

  it("accepts an explicit null field_id alongside a label", () => {
    const parsed = createWebhookSubmissionSchema.safeParse({
      form_id: 11,
      answers: [{ field_id: null, label: "Grade", value: "9" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("ACCEPTS a 300-char title — truncation is the capture path's job", () => {
    const parsed = createWebhookSubmissionSchema.safeParse({
      form_id: 11,
      answers: [{ label: "x".repeat(300), value: "v" }],
    });
    expect(parsed.success).toBe(true);
  });

  // --- failing controls ------------------------------------------------------

  it("CONTROL: rejects an answer with NEITHER field_id nor label", () => {
    const parsed = createWebhookSubmissionSchema.safeParse({
      form_id: 11,
      answers: [{ value: "Ada" }],
    });
    // If this ever passes, the webhook accepts an answer nothing can be written
    // against: no field to match, and no title to capture.
    expect(parsed.success).toBe(false);
  });

  it("CONTROL: rejects a whitespace-only label with no field_id", () => {
    const parsed = createWebhookSubmissionSchema.safeParse({
      form_id: 11,
      answers: [{ label: "   ", value: "Ada" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("CONTROL: still rejects an empty answers array", () => {
    const parsed = createWebhookSubmissionSchema.safeParse({ form_id: 11, answers: [] });
    expect(parsed.success).toBe(false);
  });

  it("CONTROL: the IN-APP parent schema still REFUSES a label-only answer", () => {
    const parsed = createSubmissionSchema.safeParse({
      form_id: 2,
      answers: [{ label: "Student Name", value: "Ada" }],
    });
    expect(parsed.success).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// The same contract for a FORM's fields — the admin design path.
//
// The header above used to exempt this path. It is not exempt. `AdminFormDesigner`
// loads a form with `GET /api/forms/:id` and sends `fields[].id` straight back on
// save, so on a driver that returns numeric columns as text every id is `"37"`.
//
// What that looked like in staging while editing only the DESCRIPTION (the whole
// field list rides along with the request, which is why an unrelated edit failed):
//
//   400 "Validation failed — fields: Expected number, received string" × 13
//
// 13 is the form's field count, and every entry is identical, because Zod's
// `flatten()` keys `fieldErrors` by `issue.path[0]` ALONE — so `fields.0.id` …
// `fields.12.id` all collapse into one key, `fields`, and the message cannot name
// the field that was rejected. Worth knowing when reading any 400 of this shape.
// -----------------------------------------------------------------------------

const FORM_PAYLOAD = {
  title: "CDM",
  description: "District form",
  fields: [
    { id: "37", label: "Student Name", type: "text", required: true, staff_only: false, sort_order: 0 },
    { id: "38", label: "School", type: "text", required: true, staff_only: false, sort_order: 1 },
  ],
};

describe("updateFormSchema — transmitted field ids", () => {
  it("accepts numeric field ids (must keep working)", () => {
    const parsed = updateFormSchema.safeParse({
      ...FORM_PAYLOAD,
      fields: FORM_PAYLOAD.fields.map((f) => ({ ...f, id: Number(f.id) })),
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts field ids that arrive as text (the staging save bug)", () => {
    const parsed = updateFormSchema.safeParse(FORM_PAYLOAD);
    if (!parsed.success) {
      throw new Error(
        `a string field id was rejected: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`
      );
    }
    expect(parsed.success).toBe(true);
  });

  it("coerces a text field id to a real NUMBER, so the UPDATE-vs-INSERT match works", () => {
    // Not merely "no longer 400". `reconcileFormFields` compares these ids against
    // a set built from database rows using `Set.has`, which matches nothing across
    // a type boundary — so the handler has to receive real numbers, or it renumbers
    // every field on save. See server/src/id-comparison.test.ts.
    const parsed = updateFormSchema.parse(FORM_PAYLOAD);
    expect(parsed.fields?.map((f) => f.id)).toEqual([37, 38]);
    expect(typeof parsed.fields?.[0]?.id).toBe("number");
  });

  it("still accepts an OMITTED id — that is how a newly added field arrives", () => {
    const parsed = updateFormSchema.safeParse({ fields: [{ label: "Notes", type: "textarea" }] });
    if (!parsed.success) {
      throw new Error(
        `an id-less field was rejected: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`
      );
    }
    expect(parsed.data.fields?.[0]?.id).toBeUndefined();
  });

  it("CONTROL: still REJECTS an id that is not a number at all", () => {
    // The coercion must not become a rubber stamp: `z.coerce.number()` turns
    // "abc" into NaN, which `.int()` refuses.
    const parsed = updateFormSchema.safeParse({
      fields: [{ id: "abc", label: "Notes", type: "textarea" }],
    });
    expect(parsed.success).toBe(false);
  });
});


// -----------------------------------------------------------------------------
// Promoting a captured field to a real form field
// (docs/plans/google-form-undefined-fields.md §11).
//
// The plain action — "make this captured question a real text field" — is an
// EMPTY body, because the ad-hoc row already carries the label and its type is
// always `text`. If this schema ever required a key, the detail page's one-click
// promote would start failing validation, so the empty-body case is the first
// test here rather than an afterthought.
// -----------------------------------------------------------------------------

describe("promoteAdhocFieldSchema", () => {
  it("accepts an EMPTY body — the one-click promote", () => {
    const parsed = promoteAdhocFieldSchema.safeParse({});
    if (!parsed.success) {
      throw new Error(
        `an empty promote body was rejected: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`
      );
    }
    expect(parsed.data.type).toBeUndefined();
    expect(parsed.data.backfill).toBeUndefined();
  });

  it("accepts every optional shaping key", () => {
    const parsed = promoteAdhocFieldSchema.safeParse({
      type: "date",
      options: ["A", "B"],
      required: true,
      staff_only: true,
      backfill: false,
    });
    expect(parsed.success).toBe(true);
  });

  it("CONTROL: rejects an unknown field type", () => {
    // The type is written to `form_fields.type`, whose CHECK constraint would
    // otherwise fail the INSERT as a 500.
    expect(promoteAdhocFieldSchema.safeParse({ type: "bogus" }).success).toBe(false);
  });

  it("CONTROL: rejects a non-boolean backfill", () => {
    expect(promoteAdhocFieldSchema.safeParse({ backfill: "yes" }).success).toBe(false);
  });
});
