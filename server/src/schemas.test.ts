import { describe, it, expect } from "vitest";
import {
  createSubmissionSchema,
  createWebhookSubmissionSchema,
  submissionAnswerSchema,
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
// transmitted id must be read with `z.coerce`. The server-minted ids elsewhere
// (form_fields.id on the admin design path) legitimately stay strict.
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
