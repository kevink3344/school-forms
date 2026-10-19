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
// An inbound answer can identify itself three ways: by `field_id` (how the
// webhook has always worked), by the Google Form question title in `label` (the
// only identity available when a form was never defined in this app's designer),
// or by `item_id` (Google's own id for the question). A title that matches a
// defined field is stored against that field exactly as before; a title that
// matches nothing becomes a per-submission `text` field, so an answer is never
// dropped.
//
// ★ WHY THERE ARE THREE, AND WHY `item_id` IS LAST
// `field_id` is NOT a Google identifier: it is `form_fields.id`, this app's own
// counter, and the Apps Script can only obtain it by matching the question's
// TITLE against `GET /api/forms/:id/public`. So retitling a question in Google
// removes `field_id` from the payload entirely — the very identity that was
// supposed to make the mapping robust disappears precisely when it is needed.
//
// `item_id` is Google's own (`item.getId()`), stable across retitling, and is
// therefore the one identity a rename cannot destroy. It is tried LAST, after
// `field_id` and `label`, so that every payload the webhook accepts today
// resolves to exactly the field it resolves to today; `item_id` only ever
// decides answers that would otherwise have been CAPTURED. Adding it as the
// last resort is what makes this change additive rather than a remapping.
//
// A field learns its `item_id` from the first answer that arrives while the
// title still matches (`FieldPlan.learned`), so no backfill is needed: raw
// traffic builds the association, and once it exists a rename is a non-event.
// -----------------------------------------------------------------------------

export interface IncomingAnswer {
  /** Server-side form field id, when the caller could resolve one. */
  field_id?: number | null;
  /** The Google Form question title — always sent by the current Apps Script. */
  label?: string | null;
  /**
   * Google's own id for the question (`item.getId()`), when the caller sent one.
   *
   * Both a string and a number are accepted because the shape is Google's, not
   * this app's: the Apps Script forwards `item.getId()` verbatim and a
   * spreadsheet round-trip can turn it into a number. `normalizeItemId` folds
   * both onto one string so a later `"123"` and `123` are one identity.
   */
  item_id?: string | number | null;
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
  /**
   * Google's own id for the question this field mirrors, or null/absent when it
   * has none yet. Declared optional so a caller that has no Google form behind
   * it (a DB-free test, the in-app parent path) need not invent a value.
   */
  source_item_id?: string | null;
}

export interface FieldPlan {
  /** → `submission_values` (resolved against a field this form defines). */
  values: { field_id: number; value: IncomingAnswer["value"] }[];
  /** → `submission_adhoc_fields`, always written with `type: "text"`. */
  captured: { label: string; value: IncomingAnswer["value"]; sort_order: number }[];
  /** Best-effort school name from a School-labelled answer (plan §5.3). */
  schoolName: string | null;
  /**
   * `item_id`s this payload proved for a field that did not have one yet —
   * `→ form_fields.source_item_id`, written by `createSubmission`.
   *
   * ★ This is the whole migration. Rather than a backfill nobody can run (it
   * needs a Google API scope this app does not have), a field learns its
   * question's id from ordinary traffic: while the title still matches, every
   * submission re-supplies the pairing, and the first one to arrive persists it.
   * After that the title is optional and a retitle no longer disconnects
   * anything.
   *
   * Computed HERE, purely, so the "is this binding safe to write?" decision is
   * unit-testable without a database — it needs to know every field on the form,
   * which is exactly what this function is already handed.
   */
  learned: { field_id: number; item_id: string }[];
}

/** `submission_adhoc_fields.label` is `NVARCHAR(200)`. */
const MAX_LABEL_LENGTH = 200;

/** `form_fields.source_item_id` is `NVARCHAR(64)`. */
export const MAX_ITEM_ID_LENGTH = 64;

/** Trim + case-fold, so `" Student Name "` and `"student name"` are one label. */
export function normalizeLabel(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Fold a wire `item_id` onto the one string form stored in
 * `form_fields.source_item_id`, or null when there is no usable value.
 *
 * ★ The trailing slice is the same call the capture path makes for an over-long
 * title, and for the same reason: a value that does not fit the column is
 * TRUNCATED, never rejected. An item id that overran `NVARCHAR(64)` would
 * otherwise turn a parent's submission into a 400 or a 500, which is a far worse
 * outcome than a shortened lookup key that simply never matches.
 *
 * Accepts `number` as well as `string` because `item.getId()` reaches us through
 * a spreadsheet-apps payload and a round-trip can coerce it; `String(123)` and
 * `"123"` must be the SAME identity or a field would acquire two.
 */
export function normalizeItemId(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = (typeof v === "number" ? String(v) : v).trim();
  return s === "" ? null : s.slice(0, MAX_ITEM_ID_LENGTH);
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
  // Google's item id → the field that has claimed it. Empty for every form whose
  // fields have never been matched against a payload, which is why relying on it
  // alone would change nothing today; it earns its keep on later submissions.
  const byItemId = new Map<string, MatchedField>();
  for (const raw of formFields) {
    const id = Number(raw.id);
    if (!Number.isFinite(id)) continue;
    // Normalise the id onto the stored copy, so `values[].field_id` is a real
    // number even when the caller passed the driver's string.
    const field: MatchedField = { id, label: raw.label, type: raw.type, source_item_id: raw.source_item_id ?? null };
    byId.set(id, field);
    // First field wins on a duplicate label: the designer's own order decides,
    // rather than whichever row the database happens to return last.
    const key = normalizeLabel(field.label);
    if (!byLabel.has(key)) byLabel.set(key, field);
    // Same first-wins rule for a duplicate item id, so a form that somehow holds
    // two fields claiming one Google question stays deterministic rather than
    // resolving differently on different runs.
    const itemKey = normalizeItemId(field.source_item_id);
    if (itemKey && !byItemId.has(itemKey)) byItemId.set(itemKey, field);
  }

  const values: FieldPlan["values"] = [];
  const captured: FieldPlan["captured"] = [];
  const seen = new Set<string>();
  // Keyed by item id, so at most one field is ever bound to a given Google
  // question and a payload repeating an answer cannot bind twice.
  const learned = new Map<string, number>();
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
    // ★ LAST, and deliberately so. `item_id` is the strongest identity Google
    // offers — it survives a retitle — but it is consulted only once `field_id`
    // and `label` have both failed, because anything that resolves today must go
    // on resolving exactly as it does today. The answers that reach this line are
    // the ones that would otherwise have been CAPTURED, and diverting those is
    // the entire point of the column.
    const itemId = normalizeItemId(a.item_id);
    if (!field && itemId) field = byItemId.get(itemId);

    if (field) {
      values.push({ field_id: field.id, value: a.value });
      // Learn the pairing while a title still vouches for it, so a LATER retitle
      // has something to fall back on. `!field.source_item_id` means this field
      // has no id yet; `!byItemId.has(itemId)` means no sibling already owns this
      // question — binding both would give one Google question two owners.
      if (itemId && !field.source_item_id && !byItemId.has(itemId) && !learned.has(itemId)) {
        learned.set(itemId, field.id);
      }
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

  return {
    values,
    captured,
    schoolName,
    learned: [...learned].map(([item_id, field_id]) => ({ field_id, item_id })),
  };
}

/**
 * The ad-hoc rows a promotion should migrate into a new form field.
 *
 * ★ This exists so that PROMOTION and CAPTURE cannot disagree. Capture matches a
 * question title to a field with `normalizeLabel`; promoting a captured title
 * must select exactly the rows a `form_fields` row with that label would have
 * matched — otherwise an admin doing the "right" thing would strand the answer on
 * some submissions and not others. Two case-folding implementations would drift;
 * one shared function cannot.
 *
 * Generic over the row shape because the caller passes a database row, not the
 * `FieldPlan` shape this module otherwise deals in.
 */
export function adhocRowsMatchingLabel<T extends { label: string }>(
  rows: T[],
  label: string
): T[] {
  const target = normalizeLabel(label);
  return rows.filter((r) => normalizeLabel(r.label) === target);
}


