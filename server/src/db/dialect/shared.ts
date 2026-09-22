// -----------------------------------------------------------------------------
// Bits of SQL text that two or more dialects build identically.
//
// The dialect modules only diverge where the languages genuinely disagree
// (see ./types.ts). Anything they agree on lives here so a fix in one place
// cannot leave the other stale — the `submissionValueSubquery` predicate is the
// current example: SQL Server writes `SELECT TOP 1` and libSQL writes
// `LIMIT 1`, but the correlation and ordering around it are the same text.
// -----------------------------------------------------------------------------

/**
 * Doubles single quotes so a source-constant label can be embedded in a literal.
 *
 * Callers pass labels that are compile-time constants from our own source (e.g.
 * `"student name"`), never user input — this is belt-and-braces, not the
 * injection boundary. User-supplied values always travel as `@param`s.
 */
export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The WHERE predicate of `submissionValueSubquery`, shared by both dialects.
 *
 * `parentheses` are the caller's job (the dialect wraps this in its own
 * `WHERE sv.submission_id = s.id AND (…)`).
 *
 * `label` — match a form field by exact label, compared case-insensitively
 * because SQL Server's default collation is case-insensitive while SQLite's
 * comparison operators are not. Omitting it falls back to the first
 * non-staff-only field, which is the "student name" heuristic the submission
 * list uses when no field is named exactly that.
 */
export function submissionValuePredicate(label?: string): string {
  if (label === undefined) return "ff.staff_only = 0";
  return `LOWER(ff.label) = ${sqlLiteral(label.toLowerCase())}`;
}

/**
 * The labels that identify a form's "which school?" field.
 *
 * A district-wide form (e.g. CDM) collects the school as a parent ANSWER rather
 * than being tied to one school, and `submissions.school_id` is derived from
 * that answer — see `resolveSubmissionSchoolId` in `db/queries.ts`. The set
 * lives here so the SQL subquery and the TypeScript resolver read ONE list; a
 * second hand-copied list is a claim, not a check.
 */
export const SCHOOL_FIELD_LABELS = ["school", "school name"] as const;

/**
 * The WHERE predicate matching a school-labelled field, shared by both dialects
 * (the dialect supplies `TOP 1` vs `LIMIT 1` around it).
 *
 * Trimmed as well as lowercased so it agrees with `resolveSubmissionSchoolId`,
 * which normalises the same way in TypeScript — a label stored as `"School "`
 * would otherwise resolve in one place and not the other.
 */
export function schoolFieldPredicate(): string {
  const labels = SCHOOL_FIELD_LABELS.map(sqlLiteral).join(", ");
  return `LOWER(LTRIM(RTRIM(ff.label))) IN (${labels})`;
}
