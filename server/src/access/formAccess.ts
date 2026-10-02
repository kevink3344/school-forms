// -----------------------------------------------------------------------------
// Form visibility — the ONE place "may this person read this form?" is written.
//
// Docs: docs/plans/public-private-forms.md (§7.1).
//
// The rule is a ROLE CARVE-OUT, not a general permission system:
//
//   • `admin` and `staff` read every form in their organization, always, and
//     never consult dbo.form_access. They are unrestricted BY RULE — not by a
//     grant row — so the rule cannot be broken by registering a new account.
//   • `cdm_contact` (and any future role) reads a PRIVATE form only with an
//     approved row in dbo.form_access. A PUBLIC form is readable by everyone.
//
// ★ The role is named HERE and nowhere else. That is what keeps "hide this form
// from staff as well" a one-line change if it is ever asked for — and a second
// copy of the test elsewhere is the "two overlapping gates" failure this repo has
// already produced twice.
//
// ★ The predicate NARROWS. It is AND-ed onto the organization filter, never
// substituted for it. A grant must never be able to widen a query — that is the
// hazard that leaks another tenant's rows, and it looks like it works because the
// caller's own rows are in there too.
// -----------------------------------------------------------------------------
import { execute } from "../db/queries.js";

/** The roles exempt from the private-form restriction. */
const UNRESTRICTED_ROLES: ReadonlySet<string> = new Set(["admin", "staff"]);

/** The minimum a viewer needs. `JwtUser` satisfies this. */
export interface FormViewer {
  role: string;
  /** Present on a JWT; the predicate uses it only for the grant lookup. */
  id?: number;
  userId?: number;
}

/**
 * The viewer's user id, whichever spelling the caller has.
 *
 * The JWT carries `sub` -> `id` while some call sites hold a `{ userId }` shape.
 * Resolving it in one place keeps every caller from inventing its own fallback —
 * and a missing id must NOT silently become 0, which would look up a nonexistent
 * user and (correctly but confusingly) deny access.
 */
export function viewerId(viewer: FormViewer): number | null {
  const raw = viewer.userId ?? viewer.id;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/**
 * True when the role reads every form in its organization regardless of the
 * private flag.
 *
 * Exported so the backfill's grant set can be written as the COMPLEMENT of this
 * test (`role = 'cdm_contact'`) rather than as an independent rule. The two are
 * one rule written twice, so they must change together — see the plan's trap 12.
 */
export function isUnrestrictedRole(role: string): boolean {
  return UNRESTRICTED_ROLES.has(role);
}

/**
 * The SQL fragment that narrows a form query to what `viewer` may read.
 *
 * Returns a clause to be AND-ed onto the caller's WHERE. It references the form
 * table by alias (default `f`) and binds exactly one parameter, `@__viewerId`.
 *
 * ★ The role test is the FIRST disjunct on purpose: for an admin or a `staff`
 * account it is a constant true, so the grant subquery is never evaluated and the
 * common case costs nothing. For a `cdm_contact` it is a constant false and the
 * expression reduces to exactly public-or-granted.
 *
 * ★ A viewer with no resolvable id gets `f.visibility = 'public'` and no grant
 * lookup — the honest reading of "we cannot identify you", and it fails CLOSED.
 */
export function formVisibilityClause(
  viewer: FormViewer,
  formAlias = "f"
): { sql: string; params: Record<string, unknown> } {
  if (isUnrestrictedRole(viewer.role)) {
    // No parameter at all: an unrestricted viewer adds no clause. Returning a
    // literal `1 = 1` rather than an empty string keeps every caller's
    // `AND ${clause}` interpolation valid without a special case.
    return { sql: "1 = 1", params: {} };
  }
  const id = viewerId(viewer);
  if (id === null) {
    return { sql: `${formAlias}.visibility = 'public'`, params: {} };
  }
  return {
    sql:
      `(${formAlias}.visibility = 'public'` +
      ` OR EXISTS (SELECT 1 FROM dbo.form_access fa` +
      ` WHERE fa.user_id = @__viewerId AND fa.form_id = ${formAlias}.id` +
      ` AND fa.status = 'approved'))`,
    params: { __viewerId: id },
  };
}

/**
 * May this viewer read this one form?
 *
 * ★ Written as the predicate applied to ONE id, not as an independent query.
 * `auth.ts` documents the same rule for `canAccessSchool`: "a row that appears in
 * the list can never 403 on open." If the list and this function are ever written
 * separately they will disagree, and the symptom is a form the picker offers and
 * the page then refuses.
 *
 * Returns false for a form that does not exist, so a caller can 403 without
 * leaking existence.
 */
export async function canAccessForm(viewer: FormViewer, formId: number): Promise<boolean> {
  if (!Number.isFinite(formId)) return false;
  const { sql, params } = formVisibilityClause(viewer, "f");
  const rows = await execute<{ n: number }>(
    `SELECT COUNT(*) AS n FROM dbo.forms f WHERE f.id = @formId AND ${sql}`,
    { ...params, formId }
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * The same predicate as a correlated EXISTS, for a query that joins a form.
 *
 * Used by the paths that reach a form through a submission or a document
 * (`routes/documents.ts`, `routes/submissions.ts`) where the form alias is not
 * the driving table. Kept here so those sites cannot write their own version.
 */
export function formVisibilityExists(
  viewer: FormViewer,
  formIdExpression: string
): { sql: string; params: Record<string, unknown> } {
  const { sql, params } = formVisibilityClause(viewer, "fv");
  return {
    sql: `EXISTS (SELECT 1 FROM dbo.forms fv WHERE fv.id = ${formIdExpression} AND ${sql})`,
    params,
  };
}
