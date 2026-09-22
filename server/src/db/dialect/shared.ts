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

// -----------------------------------------------------------------------------
// Archive visibility.
//
// A submission is archived when `submissions.archived_at` is stamped; NULL means
// it is in the views. Every statement that LISTS submissions, COUNTS them for a
// view, or exports them must therefore say which side it means — and the honest
// way to do that is a single named predicate that a reader (and a test) can
// recognise, rather than a hand-typed `archived_at IS NULL` per query that can
// be forgotten in one place and silently leak archived rows in another.
//
// `db/submissions-archive.test.ts` scans every read site for one of these two
// calls and fails on any that carries neither (unless it is on the explicit
// allowlist of statements that legitimately read every row — the delete guard,
// the migrations, and the by-id lookups behind the detail page's "this is
// archived" banner).
//
// Lookups BY IDENTITY are deliberately NOT filtered: the point of archiving is
// to hide a submission from views, not to make its own URL 404. See the route
// notes in routes/submissions.ts.
// -----------------------------------------------------------------------------

/** Restricts a statement to submissions that are NOT archived — the default view. */
export function notArchived(alias: string): string {
  return `${alias}.archived_at IS NULL`;
}

/** Restricts a statement to archived submissions only — the "Archived" filter. */
export function archivedOnly(alias: string): string {
  return `${alias}.archived_at IS NOT NULL`;
}

