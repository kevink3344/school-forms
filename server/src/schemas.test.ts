import { describe, it, expect } from "vitest";
import { createSubmissionSchema, submissionAnswerSchema, updateSubmissionValuesSchema } from "./schemas.js";

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
