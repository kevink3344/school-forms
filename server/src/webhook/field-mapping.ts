// -----------------------------------------------------------------------------
// Pure mapping of an inbound Google Forms payload onto a form's fields.
// (docs/plans/google-form-undefined-fields.md §5)
//
// WHY THIS IS ITS OWN MODULE
// `db/queries.ts` imports the pool and the dialect, so this repo's DB-free tests
// read its source AS TEXT instead of importing it (see
// `db/google-doc-field.test.ts`). The matching rules below are pure — no DB, no
// I/O — so they live here where an ordinary unit test can import them directly
// and cover every edge case in §8 of the plan.
//
// THE ONE IDEA
// An inbound answer can identify itself two ways: by `field_id` (how the webhook
// has always worked) or by the Google Form question title in `label` (the only
// identity available when a form was never defined in this app's designer). A
// title that matches a defined field is stored against that field exactly as
// before; a title that matches nothing becomes a per-submission `text` field, so
// an answer is never dropped.
// -----------------------------------------------------------------------------

export interface IncomingAnswer {
  /** Server-side form field id, when the caller could resolve one. */
  field_id?: number | null;
  /** The Google Form question title — always sent by the current Apps Script. */
  label?: string | null;
  value: string | number | boolean | string[] | null;
}

/** A form's own field definition, as far as matching is concerned. */
export interface MatchedField {
  /**
   * `form_fields.id`.
   *
   * ★ Callers must hand over a NUMBER, but they must not ASSUME it already is
   * one: the SQL Server driver returns numeric columns as strings (see the
   * `resolveSubmissionSchoolId` note in `db/queries.ts`) while every `field_id`
   * on the wire is a number. `Map.get` compares with SameValueZero, so a `"11"`
   * key can never match `11` — every answer would be captured instead of
   * matched, silently. This module normalises with `Number()` on the way in.
   */
  id: number;
  label: string;
  type: string;
}

export interface FieldPlan {
  /** → `submission_values` (resolved against a field this form defines). */
  values: { field_id: number; value: IncomingAnswer["value"] }[];
  /** → `submission_adhoc_fields`, always written with `type: "text"`. */
  captured: { label: string; value: IncomingAnswer["value"]; sort_order: number }[];
  /** Best-effort school name from a School-labelled answer (plan §5.3). */
  schoolName: string | null;
}

/** `submission_adhoc_fields.label` is `NVARCHAR(200)`. */
const MAX_LABEL_LENGTH = 200;

/** Trim + case-fold, so `" Student Name "` and `"student name"` are one label. */
export function normalizeLabel(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Is this answer blank?
 *
 * ★ `false` and `0` are NOT blank. They are real answers a parent gave, and this
 * matches the rule the client's `FieldValue.isEmpty` already applies — an
 * unchecked checkbox or a zero must never vanish from the record.
 */
export function isEmptyAnswer(v: IncomingAnswer["value"]): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * Flatten an answer for a captured (text) field.
 *
 * ★ A captured field is stored as `text`. `parseSubmissionValue` decodes JSON
 * only for the collection types (`checkbox` / `multiselect` / `google_doc`), so
 * an array stored raw would read back as the literal string `["a","b"]`. Joining
 * it is the only choice that leaves a `text` field reading like text; the
 * alternative — teaching the read path to JSON-decode `text` — would corrupt
 * genuine text that happens to look like JSON. (plan §8 case 13, option A)
 */
function flattenForCapture(v: IncomingAnswer["value"]): IncomingAnswer["value"] {
  return Array.isArray(v) ? v.join(", ") : v;
}

/**
 * Decide what to write where. Pure: same input, same output, no I/O.
 *
 * @param formFields  the form's fields, from `listFormFields(form.id)`
 * @param answers     the parsed webhook answers, in payload order
 * @param schoolLabels lowercase labels that mean "this answer names a school"
 */
export function planSubmissionFields(
  formFields: MatchedField[],
  answers: IncomingAnswer[],
  schoolLabels: readonly string[]
): FieldPlan {
  const byId = new Map<number, MatchedField>();
  const byLabel = new Map<string, MatchedField>();
  for (const raw of formFields) {
    const id = Number(raw.id);
    if (!Number.isFinite(id)) continue;
    // Normalise the id onto the stored copy, so `values[].field_id` is a real
    // number even when the caller passed the driver's string.
    const field: MatchedField = { id, label: raw.label, type: raw.type };
    byId.set(id, field);
    // First field wins on a duplicate label: the designer's own order decides,
    // rather than whichever row the database happens to return last.
    const key = normalizeLabel(field.label);
    if (!byLabel.has(key)) byLabel.set(key, field);
  }

  const values: FieldPlan["values"] = [];
  const captured: FieldPlan["captured"] = [];
  const seen = new Set<string>();
  let schoolName: string | null = null;

  answers.forEach((a, index) => {
    // A blank optional question creates nothing. (plan §8 case 6)
    if (isEmptyAnswer(a.value)) return;

    // `field_id` wins when it resolves (case 3). When it is present but not on
    // THIS form it is not an identity at all, so fall through to the title
    // (case 4) instead of dropping the answer or writing a value the FK on
    // `submission_values.field_id` would reject.
    let field: MatchedField | undefined;
    if (a.field_id != null) field = byId.get(Number(a.field_id));
    if (!field && a.label) field = byLabel.get(normalizeLabel(a.label));

    if (field) {
      values.push({ field_id: field.id, value: a.value });
    } else {
      // Defensive fallback: the webhook schema already refuses an answer with
      // neither identity (plan §8 case 9), so this only ever names a positional
      // placeholder.
      const label = (a.label && a.label.trim() ? a.label : `Field ${index + 1}`)
        .trim()
        .slice(0, MAX_LABEL_LENGTH);
      const key = normalizeLabel(label);
      // One captured field per title, first non-empty wins. (case 5)
      if (!seen.has(key)) {
        seen.add(key);
        captured.push({
          label,
          value: flattenForCapture(a.value),
          sort_order: captured.length,
        });
      }
    }

    // School routing: first match wins, and only from a non-empty text answer.
    if (schoolName === null) {
      const source = field ? field.label : a.label;
      if (source && schoolLabels.includes(normalizeLabel(source)) && typeof a.value === "string") {
        const name = a.value.trim();
        if (name !== "") schoolName = name;
      }
    }
  });

  return { values, captured, schoolName };
}

