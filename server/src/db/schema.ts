// -----------------------------------------------------------------------------
// Enum values (kept in TS; validated at the app layer)
// -----------------------------------------------------------------------------
// The BUILT-IN roles — the four rows the boot seed guarantees exist in
// `dbo.roles` (see docs/plans/roles-settings.md §3.3). This is NO LONGER the
// complete set of roles: an admin can create more, and they live only in the
// database.
//
// ⚠️ Anything that expands `ROLES` into an access list is therefore making a
// claim about "the roles that exist today" that will silently become false the
// moment a fifth role is created. `fieldAccessRoles` and `messageAudienceRoles`
// below used to do exactly that; they now return a `null` SENTINEL meaning
// "unrestricted" instead, and the sentinel is resolved where the viewer's role
// is known (see the long note above `messageAudienceRoles`).
//
// Legitimate remaining uses of `ROLES`: seeding the catalog, naming the
// built-ins in a UI, and defaulting a brand-new installation. NOT: deciding who
// may see something.
//
// ★ This array must list every built-in the boot seed inserts. It had drifted a
// row behind — `reviewer` was seeded (see both dialects' seed ladder) while this
// still named three, so `knownRoleKeys()`' cold-cache fallback rejected the
// newest role until the catalog finished loading. A hand-kept copy of a
// machine-maintained set is only ever as good as the gate that compares them.
export const ROLES = ["admin", "staff", "cdm_contact", "reviewer"] as const;
export const FORM_STATUS = ["draft", "published", "archived"] as const;
// Who may READ a form's results (docs/plans/public-private-forms.md).
//
// ★ `public` is the DEFAULT and the value of every row that predates the column,
// which is what makes shipping it a behaviour-preserving change: nothing narrows
// until an administrator deliberately marks one form private.
//
// ★ This is about READING, not submitting. The parent path is untouched — a
// private form still serves its questions publicly and still accepts answers.
export const FORM_VISIBILITY = ["public", "private"] as const;
export type FormVisibility = (typeof FORM_VISIBILITY)[number];
// The status a form_access row may hold. One row per (user, form); the PK is the
// idempotency mechanism.
//
// ★ `denied` covers BOTH "declined" and "revoked" — the requester's experience is
// identical (no access, no self-service way back) and dbo.form_access_events is
// what tells the two apart afterwards. Do not add a fourth state for a revoke.
export const FORM_ACCESS_STATUS = ["pending", "approved", "denied"] as const;
export type FormAccessStatus = (typeof FORM_ACCESS_STATUS)[number];
// HOW a row came to exist — never what the person wants. `backfill` is the
// grandfathered grant written when a form is switched to private, and it must
// stay distinguishable from a grant an administrator made deliberately, or "why
// does this person have access?" has no answer that comes from the data.
//
// ★ `backfill` must NEVER be read as consent. A future "notify everyone with a
// grant" feature that treats it as an opt-in would message people who never asked.
export const FORM_ACCESS_SOURCE = ["request", "backfill", "direct"] as const;
export type FormAccessSource = (typeof FORM_ACCESS_SOURCE)[number];
// The append-only audit event. Written by the server, never accepted from a
// request body — a caller must not be able to label their own action in the log.
export const FORM_ACCESS_EVENT = [
  "requested",
  "withdrawn",
  "approved",
  "declined",
  "revoked",
  "backfilled",
] as const;
export type FormAccessEvent = (typeof FORM_ACCESS_EVENT)[number];
export const SUBMISSION_STATUS = [
  "submitted",
  "in_review",
  "flagged",
  "completed",
] as const;
export const FIELD_TYPES = [
  "text",
  "textarea",
  "number",
  "date",
  "select",
  "checkbox",
  "radio",
  "email",
  "google_doc",
] as const;

// Field types whose stored value is a JSON-encoded ARRAY.
//
// ★ This is the ONE place that decides whether a stored answer string is decoded
// as JSON. `parseSubmissionValue` (db/queries.ts) reads it, and it is keyed on the
// field TYPE rather than on the shape of the string, because a plain string is
// not valid JSON and a JSON string that parses to a non-array must survive.
//
// `google_doc` belongs here because a Google Forms file-upload question answers
// with an ARRAY of Drive file ids, and the write path JSON.stringify's any array.
// Omit it and the raw text '["1qcUzz…"]' is served to every renderer and printed
// with its brackets and quotes — which is exactly what the submission detail page
// showed before this type existed.
//
// `multiselect` is listed even though it is not in FIELD_TYPES: it was a
// historical spelling that may still appear in stored rows, and dropping it would
// silently stop decoding those.
export const COLLECTION_FIELD_TYPES: ReadonlySet<string> = new Set([
  "checkbox",
  "multiselect",
  "google_doc",
]);

export type Role = (typeof ROLES)[number];
export type FormStatus = (typeof FORM_STATUS)[number];
export type SubmissionStatus = (typeof SUBMISSION_STATUS)[number];
export type FieldType = (typeof FIELD_TYPES)[number];

// -----------------------------------------------------------------------------
// Typed row shapes (mirror the SQL Server tables below)
// -----------------------------------------------------------------------------
export interface Organization {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  // Per-org Google Drive parent folder where generated documents are saved.
  // NULL falls back to the global env.google.docFolderId (see google/docs.ts).
  doc_folder_id: string | null;
  active: boolean;
  created_at: Date;
}

// A row of the admin-managed role catalog (`dbo.roles`, Settings → Roles).
//
// `role_key` is the value stored in `users.role` and in the four JSON stores
// (`form_fields.roles`, `system_messages.audience`, `menu_items`,
// `documents_link`), so it is IMMUTABLE once created — renaming it would orphan
// every one of those references with no error anywhere. The label is the part
// an admin edits.
//
// The seven flags are deliberately flat booleans rather than a JSON blob: the
// capability guard reads them on every request, and a JSON column would have to
// be parsed (and could be malformed) on that path.
export interface RoleRow {
  id: number;
  role_key: string;
  label: string;
  description: string | null;
  badge: string | null;
  /** May read submissions, forms, documents and the ad-hoc read routes. */
  can_view: boolean;
  /** May write: status changes, archive/restore, field values, retries. */
  can_edit: boolean;
  /** May take the deliberately binary exports (/export/csv, a document PDF). */
  can_export: boolean;
  /** May reach /api/reports. */
  can_report: boolean;
  /** Narrowed to their own school, exactly as `cdm_contact` is today. */
  school_scoped: boolean;
  /** Full access, including users, schools, form authoring and settings. */
  is_admin: boolean;
  /**
   * Seeded by the boot ladder and therefore never deletable and never
   * capability-editable. Guards the `admin` role in an installation with zero
   * admin users, which the foreign key alone cannot.
   */
  built_in: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface School {
  id: number;
  source_id: number | null;
  name: string;
  grade_level: string | null;
  calendar: string | null;
  district: string | null;
  created_at: Date;
}

export interface User {
  id: number;
  email: string;
  password_hash: string;
  // A key into `dbo.roles`, enforced by FK_users_role.
  //
  // ⚠️ Deliberately `string`, not the `Role` union. Roles are admin-managed rows
  // now, so an account can hold a key that did not exist when this file was
  // written. Typing it as the union would not have made the value safe — it would
  // only have made every custom role a compile error at the first boundary that
  // mentioned `Role`, which is a build failure where a permission decision is
  // wanted. The FK is the real validator; the capability guards refuse an unknown
  // key. `Role` still names the BUILT-INS, which is what the boot seed and the
  // UI labels are written against.
  role: string;
  school_id: number | null;
  organization_id: number;
  display_name: string;
  active: boolean;
  // Whether this account is offered in the select-mode ("Test") login dropdown.
  // Defaults to OFF: only accounts an admin has explicitly opted in appear there,
  // so a production-shaped user list never leaks into the test screen. This is a
  // curation control, not a security boundary — see docs/plans/login-mode.md.
  show_on_test_screen: boolean;
  // Set when an administrator has reset this account's password and handed over
  // a temporary one. While true, the account can still sign in (it must, in order
  // to change the password) but the client refuses to render anything until the
  // password has been replaced. The password reset leaves this true; the user's
  // own POST /api/auth/change-password clears it. Without this flag an admin who
  // reset a password would know a working credential for that account forever —
  // see docs/plans/password-recovery.md.
  must_change_password: boolean;
  created_at: Date;
}

export interface Form {
  id: number;
  title: string;
  description: string | null;
  school_id: number | null;
  designer_id: number | null;
  organization_id: number;
  status: FormStatus;
  // The status this form held immediately before it was archived, so Restore
  // returns it to exactly what it was (a published form comes back published,
  // a draft comes back a draft) instead of guessing. NULL whenever the form is
  // not currently archived. See archiveForm / restoreForm in queries.ts.
  pre_archive_status: FormStatus | null;
  view_columns: string | null;
  // Short, human-readable, globally-unique code used as the prefix of submission
  // ids (e.g. `CDM`). Nullable — forms without a code fall back to `SUB`.
  code: string | null;
  // Per-form, monotonic counter used to allocate incremental submission ids
  // (`CDM-1001`, `CDM-1002`, ...). Incremented under a row lock in `createSubmission`.
  submission_seq: number;
  created_at: Date;
  updated_at: Date;
  // Per-form Google Drive parent folder where generated documents are saved for
  // this form. NULL falls back to the global env.google.docFolderId (see docs.ts).
  // Per-form so different admins can route their forms' documents to different
  // Drive locations.
  doc_folder_id: string | null;
  // Optional link to the source Google Form this form mirrors. Purely
  // informational — shown to staff so they can open it. No API integration.
  google_form_url: string | null;
  // Who may READ this form's results (docs/plans/public-private-forms.md).
  //
  // `public` (the default, and what every existing form is) means every internal
  // member of the organization sees it, exactly as before this column existed.
  // `private` means the organization's School Contacts (`cdm_contact`) do not see
  // it unless they hold an approved row in dbo.form_access. **Administrators and
  // `staff` are unaffected either way** — the predicate's first disjunct exempts
  // them — which is what keeps this a role carve-out rather than a general
  // permission system.
  //
  // ★ This narrows READING only. The parent submission path is untouched: a
  // private form still serves its questions publicly and still accepts answers
  // (see docs/plans/public-private-forms.md §3.2).
  visibility: FormVisibility;
  // Number of submissions attached to this form. Populated by listForms (computed
  // subquery) so the admin Forms list can gate the Delete action. A form with any
  // submissions is NOT deletable (submissions.form_id cascades on delete).
  submission_count?: number;
}

export interface FormField {
  id: number;
  form_id: number;
  label: string;
  type: FieldType;
  options: string[] | null;
  required: boolean;
  staff_only: boolean;
  sort_order: number;
  placeholder: string | null;
  // Roles that can access this field when it is internal (staff_only). Stored as
  // a JSON string array (e.g. '["admin","staff"]'); NULL for parent-facing fields.
  // When NULL on a staff_only field it means UNRESTRICTED — every role, including
  // ones created later — so existing rows keep behaving as they always did. An
  // empty array is the distinct "granted to nobody" state. See fieldAccessRoles.
  roles: string[] | null;
}

// Resolve the roles that may access an internal (staff_only) field.
//
// ★ `null` means UNRESTRICTED — every role, including roles created later.
// This used to return `[...ROLES]`, which was the same thing only while `ROLES`
// was the complete set of roles. It is not any more (an admin can add roles in
// Settings → Roles), so expanding the list would have FROZEN every unset field
// at the roles that happened to exist when the row was written — silently
// excluding every role created afterwards, with nothing failing anywhere.
// Returning the sentinel keeps the promise this function always documented.
//
// The three states, kept deliberately distinct:
//   null  -> unset, meaning "every current role and every future one"
//   []    -> the admin granted nobody access (do NOT fall back to all roles)
//   [..]  -> exactly those roles
//
// Parent-facing fields (staff_only=0) always return null.
export function fieldAccessRoles(field: Pick<FormField, "staff_only" | "roles">): string[] | null {
  if (!field.staff_only) return null;
  if (field.roles === null || field.roles === undefined) return null;
  return field.roles.filter(Boolean);
}

// Decide whether a given viewer can see a field. `viewer` is a role key, or
// "parent" for anonymous submissions. Admins are superusers and see every field.
// A viewer sees an internal field when the field's access list is unrestricted
// (null — see above) or explicitly names their role. Parents never see any
// internal (staff_only) field.
export function canSeeField(
  field: Pick<FormField, "staff_only" | "roles">,
  viewer: string
): boolean {
  if (viewer === "admin") return true;
  if (!field.staff_only) return true;
  if (viewer === "parent") return false;
  const allowed = fieldAccessRoles(field);
  return allowed === null || allowed.includes(viewer);
}

// Entry that composes a field with its resolved access roles for API payloads.
export function toFieldAccessRoles(
  field: Pick<FormField, "staff_only" | "roles">
): string[] | null {
  return fieldAccessRoles(field);
}

export interface Submission {
  id: number;
  public_id: string;
  form_id: number;
  school_id: number | null;
  organization_id: number;
  status: SubmissionStatus;
  submission_seq: number;
  submitted_at: Date;
  updated_at: Date;
  // School year the submission belongs to (e.g. "2026-2027"). A stable snapshot
  // captured from submitted_at at insert + backfill time; NOT recomputed on read.
  school_year: string | null;
  // Staff-only fields audit trail — which staff last saved the submission's
  // staff-only fields, and when. NULL until a staff-only save happens.
  staff_fields_updated_by: number | null;
  staff_fields_updated_at: Date | null;
  // Archive state. `archived_at` NULL means "in the views"; non-NULL means the
  // submission is hidden from every list, count, export and report, and is only
  // reachable by its own URL (which says so). `archived_by` is who archived it.
  // Orthogonal to `status` on purpose — see the DDL note in this file.
  archived_at: Date | null;
  archived_by: number | null;
}

export interface SubmissionValue {
  id: number;
  submission_id: number;
  field_id: number;
  value: string | number | boolean | string[] | null;
}

// A staff-only field that has been added ad-hoc to a *specific* submission.
// Deliberately lives in its own table so the published form definition
// (dbo.form_fields) stays completely fixed — staff can extend a submission
// without mutating the parent template.
export interface AdhocField {
  id: number;
  submission_id: number;
  label: string;
  type: FieldType;
  options: string[] | null;
  value: string | number | boolean | string[] | null;
  sort_order: number;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

// -----------------------------------------------------------------------------
// Generated Google Documents (staff "Generate document" feature).
// A row is created Pending when staff check the field on save, then updated to
// Completed (with the Google Doc id) or Failed (with an error message) after the
// Google call resolves. Lives in its own table so a submission can have multiple
// attempts over time (original + retries) without mutating the submission.
// -----------------------------------------------------------------------------
export const DOCUMENT_STATUS = ["Pending", "Completed", "Failed"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUS)[number];

export interface Document {
  id: number;
  submission_id: number;
  document_id: string | null;
  status: DocumentStatus;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
  error: string | null;
}

// A document row enriched with the labels shown on the Documents list page.
// The non-column fields are derived from the submission's answers (or school).
export interface ListDocumentRow extends Document {
  public_id: string; // submission public id (link through)
  school_id: number | null;
  school_name: string | null;
  student_name: string | null;
  course_title: string | null;
  phase1_result: string | null;
}

// -----------------------------------------------------------------------------
// Inbound webhook intake log (docs/plans/webhook-log.md).
//
// ONE ROW PER ATTEMPT. The row is written for every inbound POST — success or
// failure — and the FAILURE rows are what make the feature worth having: before
// this table the webhook route returned 401/400/404 *before writing anything*,
// so a Google Form response that arrived while its form was unpublished left no
// trace at all. The row is therefore recorded before the outcome is decided.
//
// NO FOREIGN KEYS, deliberately:
//   - form_id -> forms with CASCADE would DELETE the evidence the moment someone
//     deleted the form, which is precisely the situation you want a record of.
//     With NO ACTION, `DELETE /api/forms/:id` would start failing on an FK error
//     and break an existing feature. So: plain INT, and the UI renders
//     "(deleted)" when the join misses.
//   - submission_id and replayed_by have the same problem in miniature.
//   - A pleasant side effect: with no FK constraints there is no new cascade
//     path, so SQL Server error 1785 ("multiple cascade paths") cannot occur.
//
// `payload_raw` holds the request body verbatim (captured from the raw bytes in
// the express.json `verify` hook, capped at 64 KB) so a failed attempt can be
// replayed. It is NULL for a failed secret check — that body is attacker-supplied
// and storing it would turn the log into free storage for anyone who can guess
// the URL. The row is still written, so you can see THAT someone probed.
//
// `auth_result` is a string rather than a BIT so that "missing" and "invalid" are
// distinguishable (a misconfigured Apps Script versus a rotated secret) and so
// no new column needs registering in BOOLEAN_COLUMNS.
// -----------------------------------------------------------------------------
export const WEBHOOK_EVENT_STATUS = ["succeeded", "failed"] as const;
export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUS)[number];

export const WEBHOOK_AUTH_RESULTS = ["ok", "invalid", "missing"] as const;
export type WebhookAuthResult = (typeof WEBHOOK_AUTH_RESULTS)[number];

// Why an attempt failed. Kept separate from the HTTP status so the UI can say
// "7 responses arrived while this form was unpublished" instead of the opaque
// "Form is not accepting submissions".
//
// Deliberately no code for "the payload was too large to store" — that is a
// property of the ROW (`payload_bytes` set, `payload_raw` NULL), not a reason the
// attempt failed, and overwriting the real reason with it would hide exactly the
// information the log exists to surface.
export const WEBHOOK_ERROR_CODES = [
  "unauthorized",
  "invalid_body",
  "form_not_found",
  "form_not_published",
  "internal_error",
] as const;
export type WebhookErrorCode = (typeof WEBHOOK_ERROR_CODES)[number];

export interface WebhookEvent {
  id: number;
  source: string;
  received_at: Date;
  remote_ip: string | null;
  user_agent: string | null;
  auth_result: WebhookAuthResult;
  status: WebhookEventStatus;
  http_status: number;
  error_code: WebhookErrorCode | null;
  error: string | null;
  form_id: number | null;
  /**
   * The resolved form's organization, captured at intake.
   *
   * Recorded as a COLUMN rather than derived from the `form_id` join, because
   * `form_id` is best-effort (a `form_not_found` attempt has a payload-supplied
   * id that may match nothing) and because a deleted form would leave the join
   * NULL — which would make the row invisible to every organization, including
   * the one that received it. NULL means "could not be attributed".
   */
  organization_id: number | null;
  submission_id: number | null;
  public_id: string | null;
  payload_raw: string | null;
  payload_bytes: number | null;
  payload_hash: string | null;
  replay_of: number | null;
  replayed_by: number | null;
}

// A list row: the event plus the labels the grid needs, with `payload_raw`
// omitted so a page of 100 failures doesn't ship 100 payloads to the browser.
export interface ListWebhookEventRow extends Omit<WebhookEvent, "payload_raw"> {
  form_title: string | null;
  form_code: string | null;
  replayed_by_name: string | null;
  /**
   * Whether a payload is actually stored for this row. Derived in SQL so the
   * grid can grey out Replay without fetching 100 payloads, and so a row that is
   * over the storage cap (payload_bytes set, payload_raw NULL) is visibly
   * different from one with an empty body.
   */
  payload_present: boolean;
  /**
   * Whether a *succeeding* replay already exists for this row. Replay is
   * one-shot (Q5), so the button is disabled on the strength of this flag rather
   * than on the caller being told to try and see.
   */
  has_replay: boolean;
}

// Detail: the list row plus the payload, fetched only when the drawer opens.
export interface WebhookEventDetail extends ListWebhookEventRow {
  payload_raw: string | null;
}

// -----------------------------------------------------------------------------
// SQL Server DDL — a cumulative migration ladder, executed once at startup.
//
// Deliberately SQL Server only: it is consumed by `dialect/sqlserver.ts`. The
// libSQL/Turso dialect (`dialect/turso.ts`) creates the FINAL schema directly
// with plain `CREATE TABLE IF NOT EXISTS` statements and does not port any of
// this — there is nothing to migrate from on a fresh database
// (docs/plans/dual-db.md §5.3).
//
// Most statements are idempotent guards (COL_LENGTH / sys.indexes /
// sys.foreign_keys). A few are one-time data backfills. Batches are split on
// purpose: SQL Server compiles each batch before executing it, so a statement
// referencing a column ADDed in the same batch fails with error 207.
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// Guard helpers for the migration ladder.
//
// These exist because the ladder is ALSO run against a database this app did not
// create. On such a database the string columns are `nvarchar(max)` — which SQL
// Server refuses as an index key — and the foreign keys carry different names
// (a `_id` suffix). A guard keyed only on an object's NAME therefore "misses" an
// object that is already there and tries to create it again, with two different
// outcomes:
//
//   * a `CREATE INDEX` on an `nvarchar(max)` column FAILS, and because the driver
//     runs the ladder batch by batch and stops at the first failure, that single
//     statement aborts every batch after it and `dbReady` is never set — the app
//     cannot start at all;
//   * a `CREATE ... FOREIGN KEY` guarded by name SUCCEEDS, adding a duplicate
//     constraint to a live production database.
//
// So the guards below test the preconditions that actually matter instead. None
// of them changes behaviour on a database this app created itself: there the
// types are already indexable, the FK is already absent and the column is a
// nullable INT, so each guard evaluates exactly as the name-only guard did.
// -----------------------------------------------------------------------------

// `max_length` on sys.columns is in BYTES: -1 means `(MAX)`, which can never be a
// key, and more than 1700 exceeds the nonclustered key-size limit. `text`,
// `ntext`, `image` and `xml` are not indexable at any length.
function isIndexable(table: string, column: string): string {
  return (
    `EXISTS (SELECT 1 FROM sys.columns c\n` +
    `               JOIN sys.types t ON t.user_type_id = c.user_type_id\n` +
    `              WHERE c.object_id = OBJECT_ID('dbo.${table}')\n` +
    `                AND c.name = '${column}'\n` +
    `                AND t.name NOT IN ('text','ntext','image','xml')\n` +
    `                AND c.max_length BETWEEN 1 AND 1700)`
  );
}

// `IF NOT EXISTS(<index name>) AND <every key column is indexable as it stands>`.
function indexGuard(name: string, table: string, keyColumns: string[]): string {
  return (
    `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='${name}')` +
    keyColumns.map((column) => `\n   AND ${isIndexable(table, column)}`).join("")
  );
}

// True only when the column is a NULLABLE `int` — i.e. when the `ALTER COLUMN …
// INT NOT NULL` that follows is both needed and safe. That is exactly the state
// the ladder leaves the column in on the app's own database; on a copied one the
// column is `bigint` (and already NOT NULL), and narrowing it fails with error
// 5074 as soon as an index or foreign key references it.
function isNullableInt(table: string, column: string): string {
  return (
    `EXISTS (SELECT 1 FROM sys.columns c\n` +
    `               JOIN sys.types t ON t.user_type_id = c.user_type_id\n` +
    `              WHERE c.object_id = OBJECT_ID('dbo.${table}')\n` +
    `                AND c.name = '${column}'\n` +
    `                AND t.name = 'int' AND c.is_nullable = 1)`
  );
}

// `IF NOT EXISTS(<an FK on THIS relationship>)` — keyed on the parent table, the
// parent column and the referenced table, never on the constraint's name.
function fkGuard(table: string, column: string, referenced: string): string {
  return (
    `IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys fk\n` +
    `                JOIN sys.foreign_key_columns fkc\n` +
    `                  ON fkc.constraint_object_id = fk.object_id\n` +
    `               WHERE fk.parent_object_id = OBJECT_ID('dbo.${table}')\n` +
    `                 AND COL_NAME(fk.parent_object_id, fkc.parent_column_id) = '${column}'\n` +
    `                 AND fk.referenced_object_id = OBJECT_ID('dbo.${referenced}'))`
  );
}

/**
 * Every index name a ladder declares, parsed out of its statements.
 *
 * Used to report the declarations the guards above had to skip. Deriving the list
 * from the DDL keeps it correct by construction — a hand-copied list of the same
 * names drifts the moment an index is added, and nothing reminds the author the
 * copy exists. The optional `IF NOT EXISTS` is there because the Turso ladder
 * spells the same declaration that way, so one parser reads both.
 */
export function expectedIndexNames(statements: string[]): string[] {
  const names = new Set<string>();
  const declared = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const statement of statements) {
    for (const match of statement.matchAll(declared)) names.add(match[1]);
  }
  return [...names].sort();
}

export const SQLSERVER_DDL_STATEMENTS: string[] = [
  `IF OBJECT_ID('dbo.schools', 'U') IS NULL
   CREATE TABLE dbo.schools (
     id          INT IDENTITY(1,1) PRIMARY KEY,
     name        NVARCHAR(200) NOT NULL,
     district    NVARCHAR(200) NULL,
     created_at  DATETIME2 NOT NULL CONSTRAINT DF_schools_created_at DEFAULT SYSUTCDATETIME()
   );`,

  // UX_schools_name is its OWN batch, deliberately not part of the CREATE TABLE
  // above.
  //
  // It used to ride that batch, and `IF OBJECT_ID('dbo.schools','U') IS NULL`
  // skips the batch WHOLE — so on a database that already had the table the index
  // was declared and never created. Moving it out is a genuine fix and this batch
  // is what makes the declaration reachable on such a database.
  //
  // ★ MEASURED, and it corrects an earlier version of this comment: on the
  //   tenant this app actually runs against the index is STILL absent, and the
  //   operative cause is the COLUMN, not the batch.
  //
  //   `schools.name` there is `nvarchar(max)` — `sys.columns` reports
  //   `max_length = -1, indexable = 0` — and a nonclustered key is capped at 1700
  //   bytes, so no index can be built on it as it stands. `indexGuard`'s second
  //   half (`isIndexable()`) therefore answers FALSE, the whole `IF` is false, and
  //   this batch RUNS and creates nothing, raising no error at all. That is the
  //   designed behaviour of the guard, working correctly.
  //
  //   `reportSkippedIndexes()` names this index at every boot and attributes it to
  //   column indexability — and on this database that attribution is RIGHT. Do not
  //   read that warning as a guard bug and do not go looking for a skipped batch:
  //   the warning is the whole story.
  //
  //   Consequence while it stands: schools.name uniqueness is NOT enforced by the
  //   database — including the protection against two schools sharing a name, and
  //   so of one school's students resolving to another school's contact. The
  //   route's read-then-write pre-check is the only guard, and two concurrent
  //   creates can both pass it.
  //
  //   Fixing it is a DATA-SIDE step — narrow `schools.name` to the NVARCHAR(200)
  //   declared in the CREATE TABLE above, after checking the existing rows fit —
  //   and it is deliberately NOT done here: 72 columns across 14 tables on that
  //   tenant are `nvarchar(max)` where this DDL declares a sized type, which also
  //   means that database predates this DDL and the `IF OBJECT_ID(...) IS NULL`
  //   guards can never correct it. The column must be narrowed before this batch
  //   can do anything; there is no code change that substitutes for that.
  //
  // ★ MEASURED, second pass: the narrowing is SAFE — the data already fits. The
  //   longest `schools.name` is 69 chars against the declared 200 (and the same
  //   holds for every other blocking column: `users.email` 35/320,
  //   `submissions.public_id` 10/64, `forms.code` 8/20), no column holds a NULL,
  //   and none of the 6 UNIQUE indexes has a single duplicate value — so the 7
  //   `ALTER COLUMN` statements plus a re-run of this DDL would create 7 of the
  //   10 missing indexes with no data cleanup. Nothing depends on those columns
  //   either (no FK, computed column or full-text index), so the ALTER is not
  //   blocked by the schema.
  //
  //   Still do NOT "fix" this by relaxing `isIndexable()`: forcing the CREATE
  //   would create nothing and would fail less honestly. The fix is on the data.
  `${indexGuard("UX_schools_name", "schools", ["name"])}
     CREATE UNIQUE INDEX UX_schools_name ON dbo.schools(name);`,

  // Idempotent migration for the school import feature — adds columns to the
  // already-existing dbo.schools table (safe to re-run). Kept as its OWN batch
  // so SQL Server binds the ALTERs before any index references the new column.
  `IF COL_LENGTH('dbo.schools', 'source_id') IS NULL
     ALTER TABLE dbo.schools ADD source_id INT NULL;
   IF COL_LENGTH('dbo.schools', 'grade_level') IS NULL
     ALTER TABLE dbo.schools ADD grade_level NVARCHAR(50) NULL;
   IF COL_LENGTH('dbo.schools', 'calendar') IS NULL
     ALTER TABLE dbo.schools ADD calendar NVARCHAR(50) NULL;`,

  // The filtered unique index is a SEPARATE batch: SQL Server compiles each batch
  // before execution, so the columns must already exist when this runs. It has to
  // be its own batch for a second reason — it originally rode the ALTER batch
  // above, which OPENS with `IF COL_LENGTH('dbo.schools','source_id') IS NULL`, and
  // a batch-level `IF` scopes every statement that follows it. So on a database
  // where `source_id` already existed (the tenant) the index was declared, never
  // created, and no error was raised anywhere.
  //
  // The DROP is a third batch, and it is keyed on the index's SHAPE (`has_filter`)
  // rather than on its name — because a name-keyed guard cannot repair a wrong
  // DEFINITION. The two definitions are not equivalent: an unfiltered unique index
  // over `source_id` permits exactly ONE NULL, and the seed's `Sample School` holds
  // it — so EVERY school added by hand afterwards was refused with error 2601 "The
  // duplicate key value is (<NULL>)". The route then read that 2601 as a duplicate
  // NAME and answered `409 A school named "<the name just typed>" already exists`,
  // a state that did not exist.
  //
  // ★ The unfiltered definition was NOT written by this repository. An earlier
  //   version of this comment claimed "an earlier revision created this index
  //   without the filter", and that is false: `git log -S "UX_schools_source_id"
  //   -- server/src/db/schema.ts` returns exactly one commit (`05d1854`), whose
  //   declaration already read `… (source_id) WHERE source_id IS NOT NULL`. So the
  //   index the tenant carries was created OUTSIDE this app, which is consistent
  //   with that database predating this DDL (see the guard-helper note above).
  //   This changes nothing about the fix — a name-keyed guard cannot repair a wrong
  //   definition no matter who wrote it — but the cause is "an index this app did
  //   not create", not "a bug of ours from an older revision", and whoever reads
  //   this next should not go hunting for a revision that does not exist.
  `IF EXISTS (SELECT 1 FROM sys.indexes
               WHERE object_id = OBJECT_ID('dbo.schools')
                 AND name = 'UX_schools_source_id' AND has_filter = 0)
     DROP INDEX UX_schools_source_id ON dbo.schools;`,

  `IF NOT EXISTS (SELECT 1 FROM sys.indexes
                   WHERE object_id = OBJECT_ID('dbo.schools')
                     AND name = 'UX_schools_source_id')
     CREATE UNIQUE INDEX UX_schools_source_id ON dbo.schools(source_id) WHERE source_id IS NOT NULL;`,

  // ---------------------------------------------------------------------
  // Organizations (multi-tenancy). Created BEFORE users/forms/submissions
  // because they carry an FK back to organizations.
  // ---------------------------------------------------------------------
  `IF OBJECT_ID('dbo.organizations', 'U') IS NULL
   CREATE TABLE dbo.organizations (
     id          INT IDENTITY(1,1) PRIMARY KEY,
     slug        NVARCHAR(60)  NOT NULL,
     name        NVARCHAR(120) NOT NULL,
     description NVARCHAR(MAX) NULL,
     active      BIT NOT NULL CONSTRAINT DF_organizations_active DEFAULT 1,
     created_at  DATETIME2 NOT NULL CONSTRAINT DF_organizations_created_at DEFAULT SYSUTCDATETIME()
   );
   ${indexGuard("UX_organizations_slug", "organizations", ["slug"])}
     CREATE UNIQUE INDEX UX_organizations_slug ON dbo.organizations(slug);
   ${indexGuard("UX_organizations_name", "organizations", ["name"])}
     CREATE UNIQUE INDEX UX_organizations_name ON dbo.organizations(name);
   IF COL_LENGTH('dbo.organizations', 'active') IS NULL
     ALTER TABLE dbo.organizations ADD active BIT NOT NULL
       CONSTRAINT DF_organizations_active DEFAULT 1;
   IF COL_LENGTH('dbo.organizations', 'description') IS NULL
     ALTER TABLE dbo.organizations ADD description NVARCHAR(MAX) NULL;
   IF COL_LENGTH('dbo.organizations', 'doc_folder_id') IS NULL
     ALTER TABLE dbo.organizations ADD doc_folder_id NVARCHAR(255) NULL;`,

  // Seed the two known organizations (idempotent). Technology Services is a
  // placeholder org with NO users — only the org row is created here.
  `IF NOT EXISTS (SELECT 1 FROM dbo.organizations WHERE slug = N'academics')
     INSERT INTO dbo.organizations (slug, name) VALUES (N'academics', N'Academics');
   IF NOT EXISTS (SELECT 1 FROM dbo.organizations WHERE slug = N'technology-services')
     INSERT INTO dbo.organizations (slug, name) VALUES (N'technology-services', N'Technology Services');`,

  // ---------------------------------------------------------------------
  // Role catalog — the mutable list of roles behind Settings → Roles.
  //
  // Roles used to be a compile-time constant (`ROLES`, top of this file). They
  // are now a TABLE, because an admin has to be able to add one at runtime while
  // the route guards, the designer's per-field access, the system-message
  // audience and the menu/doc-link settings all keep working.
  //
  // `role_key` is what `users.role` stores AND what every existing JSON-array
  // store already holds (`form_fields.roles`, `system_messages.audience`,
  // `menu_items`, `documents_link`) — so none of those four needed a schema
  // change: storage was never the obstacle, ENUMERATION was.
  //
  // Its UNIQUE index is load-bearing, not decoration: the foreign key on
  // `users.role` (added below) is what turns "a role that has been assigned
  // cannot be deleted" into a DATABASE rule instead of a convention the next
  // write path can forget. A key needs a unique index to be an FK target.
  //
  // `built_in` marks the four roles the code itself depends on. Their SECURITY
  // flags (the four capabilities, `school_scoped`, `is_admin`) are re-derived
  // from code on EVERY boot — see the re-derivation batch below — so a hand-run
  // `UPDATE dbo.roles SET can_edit = 1 WHERE role_key = 'staff'` cannot survive a
  // restart. `label`, `description` and `badge` are deliberately NOT re-derived:
  // they are display-only, carry no authority, and an admin may rename one.
  //
  // Declared in its OWN batch, before dbo.users. SQL Server compiles a batch
  // before running it, so an INSERT naming dbo.roles in the same batch that
  // creates it fails with "Invalid object name" — the same reason
  // UX_schools_name is split out of the schools CREATE above. The index rides
  // this batch because it is a SIBLING statement, not part of the CREATE TABLE's
  // `IF` body: on a database that already has the table the CREATE is skipped and
  // the index statement still runs.
  // ---------------------------------------------------------------------
  `IF OBJECT_ID('dbo.roles', 'U') IS NULL
   CREATE TABLE dbo.roles (
     id            INT IDENTITY(1,1) PRIMARY KEY,
     role_key      NVARCHAR(40) NOT NULL,
     label         NVARCHAR(80) NOT NULL,
     description   NVARCHAR(200) NULL,
     badge         NVARCHAR(30) NULL,
     can_view      BIT NOT NULL CONSTRAINT DF_roles_can_view DEFAULT 1,
     can_edit      BIT NOT NULL CONSTRAINT DF_roles_can_edit DEFAULT 0,
     can_export    BIT NOT NULL CONSTRAINT DF_roles_can_export DEFAULT 0,
     can_report    BIT NOT NULL CONSTRAINT DF_roles_can_report DEFAULT 0,
     school_scoped BIT NOT NULL CONSTRAINT DF_roles_school_scoped DEFAULT 0,
     is_admin      BIT NOT NULL CONSTRAINT DF_roles_is_admin DEFAULT 0,
     built_in      BIT NOT NULL CONSTRAINT DF_roles_built_in DEFAULT 0,
     created_at    DATETIME2 NOT NULL CONSTRAINT DF_roles_created_at DEFAULT SYSUTCDATETIME(),
     updated_at    DATETIME2 NOT NULL CONSTRAINT DF_roles_updated_at DEFAULT SYSUTCDATETIME()
   );
   ${indexGuard("UX_roles_key", "roles", ["role_key"])}
     CREATE UNIQUE INDEX UX_roles_key ON dbo.roles(role_key);`,

  // Seed the four built-in roles, one row at a time and only when absent.
  //
  // Separate batch from the CREATE for the compile-order reason above. `reviewer`
  // is seeded rather than left for an admin to create, and that is a deliberate
  // architectural choice, not a convenience: capabilities only ever ADD (a role
  // is checked with `is_admin || can_x`, and nothing subtracts), so a restrictive
  // role cannot be expressed by granting one alongside `staff` — the union wins.
  // A role whose whole purpose is to see LESS therefore has to be a first-class
  // row in the mutually exclusive `users.role` channel, reviewed in code once.
  //
  // `can_report = 1` on all four because `routes/reports.ts` already holds
  // `REPORT_ROLES = ["staff", "cdm_contact", "admin"] as const` — every current
  // role has report access, so seeding anything less would be a behaviour change.
  `IF NOT EXISTS (SELECT 1 FROM dbo.roles WHERE role_key = N'admin')
     INSERT INTO dbo.roles (role_key, label, description, can_view, can_edit, can_export, can_report, school_scoped, is_admin, built_in)
     VALUES (N'admin', N'Administrator', N'Full access, including users, schools and system settings.', 1, 1, 1, 1, 0, 1, 1);
   IF NOT EXISTS (SELECT 1 FROM dbo.roles WHERE role_key = N'staff')
     INSERT INTO dbo.roles (role_key, label, description, can_view, can_edit, can_export, can_report, school_scoped, is_admin, built_in)
     VALUES (N'staff', N'Staff', N'Day-to-day form work: read, edit and export submissions.', 1, 1, 1, 1, 0, 0, 1);
   IF NOT EXISTS (SELECT 1 FROM dbo.roles WHERE role_key = N'cdm_contact')
     INSERT INTO dbo.roles (role_key, label, description, can_view, can_edit, can_export, can_report, school_scoped, is_admin, built_in)
     VALUES (N'cdm_contact', N'School Contact', N'Staff access, limited to their own school.', 1, 1, 1, 1, 1, 0, 1);
   IF NOT EXISTS (SELECT 1 FROM dbo.roles WHERE role_key = N'reviewer')
     INSERT INTO dbo.roles (role_key, label, description, can_view, can_edit, can_export, can_report, school_scoped, is_admin, built_in)
     VALUES (N'reviewer', N'Reviewer', N'Read, export and report. Cannot change submissions.', 1, 0, 1, 1, 0, 0, 1);`,

  // Re-derive the built-ins' SECURITY flags from code, every boot.
  //
  // This is the whole reason `built_in` exists. Without it the seed above would
  // only ever run once, and a direct `UPDATE dbo.roles SET can_edit = 1 WHERE
  // role_key = 'staff'` — or a bug in the Roles panel — would permanently grant
  // write access to a role the guards trust. Re-deriving means the worst case is
  // "reverts at the next restart" rather than "escalated forever".
  //
  // `updated_at` is deliberately NOT touched: these values are derived, so a
  // timestamp on them would only record when the app last booted, which is noise
  // in a column an admin reads to answer "when did this role change".
  `UPDATE dbo.roles SET can_view = 1, can_edit = 1, can_export = 1, can_report = 1, school_scoped = 0, is_admin = 1, built_in = 1 WHERE role_key = N'admin';
   UPDATE dbo.roles SET can_view = 1, can_edit = 1, can_export = 1, can_report = 1, school_scoped = 0, is_admin = 0, built_in = 1 WHERE role_key = N'staff';
   UPDATE dbo.roles SET can_view = 1, can_edit = 1, can_export = 1, can_report = 1, school_scoped = 1, is_admin = 0, built_in = 1 WHERE role_key = N'cdm_contact';
   UPDATE dbo.roles SET can_view = 1, can_edit = 0, can_export = 1, can_report = 1, school_scoped = 0, is_admin = 0, built_in = 1 WHERE role_key = N'reviewer';`,

  `IF OBJECT_ID('dbo.users', 'U') IS NULL
   CREATE TABLE dbo.users (
     id            INT IDENTITY(1,1) PRIMARY KEY,
     email         NVARCHAR(320) NOT NULL,
     password_hash NVARCHAR(255) NOT NULL,
     role          NVARCHAR(40) NOT NULL,
     school_id     INT NULL,
     display_name  NVARCHAR(120) NOT NULL,
     active        BIT NOT NULL CONSTRAINT DF_users_active DEFAULT 1,
     show_on_test_screen BIT NOT NULL CONSTRAINT DF_users_show_on_test_screen DEFAULT 0,
     must_change_password BIT NOT NULL CONSTRAINT DF_users_must_change_password DEFAULT 0,
     created_at    DATETIME2 NOT NULL CONSTRAINT DF_users_created_at DEFAULT SYSUTCDATETIME(),
     CONSTRAINT FK_users_school FOREIGN KEY (school_id) REFERENCES dbo.schools(id) ON DELETE SET NULL
   );
   ${indexGuard("UX_users_email", "users", ["email"])}
     CREATE UNIQUE INDEX UX_users_email ON dbo.users(email);
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_users_school')
     CREATE INDEX IX_users_school ON dbo.users(school_id);`,

  // Idempotent migration for the admin Settings → Users feature — adds the
  // active flag to an ALREADY-EXISTING dbo.users table (safe to re-run).
  `IF COL_LENGTH('dbo.users', 'active') IS NULL
     ALTER TABLE dbo.users ADD active BIT NOT NULL CONSTRAINT DF_users_active DEFAULT 1;`,

  // Idempotent migration for the "Show user on Test screen" toggle — adds the
  // flag to an ALREADY-EXISTING dbo.users table (safe to re-run). The default is
  // 0/OFF, so on an existing deployment the column lands false for every account
  // and nothing changes until an admin opts a user in. That is deliberate: the
  // test-mode dropdown must not silently start listing production accounts.
  `IF COL_LENGTH('dbo.users', 'show_on_test_screen') IS NULL
     ALTER TABLE dbo.users ADD show_on_test_screen BIT NOT NULL
       CONSTRAINT DF_users_show_on_test_screen DEFAULT 0;`,

  // Idempotent migration for the admin password reset — adds the "must change
  // password" flag to an ALREADY-EXISTING dbo.users table (safe to re-run). The
  // default is 0/OFF, so on an existing deployment every account keeps working
  // unchanged: nobody is retroactively forced to change a password. See the
  // `User.must_change_password` note above.
  `IF COL_LENGTH('dbo.users', 'must_change_password') IS NULL
     ALTER TABLE dbo.users ADD must_change_password BIT NOT NULL
       CONSTRAINT DF_users_must_change_password DEFAULT 0;`,

  // Idempotent migration for the School Contact role — widens the role CHECK
  // constraint to accept 'cdm_contact'. The original CREATE TABLE only runs when
  // the table is brand new, so existing deployments need their role CHECK
  // constraint replaced. Constraint names are auto-generated, so drop any CHECK
  // that constrains the role column to NOT include the new role, and re-add it
  // with the full role set. Guarded so it no-ops once 'cdm_contact' is allowed.
  `IF EXISTS (SELECT 1 FROM sys.check_constraints
               WHERE parent_object_id = OBJECT_ID('dbo.users')
                 AND definition LIKE '%role%'
                 AND definition LIKE '%admin%'
                 AND definition NOT LIKE '%cdm_contact%')
   BEGIN
     DECLARE @ck nvarchar(128) = (SELECT TOP 1 name FROM sys.check_constraints
       WHERE parent_object_id = OBJECT_ID('dbo.users')
         AND definition LIKE '%role%'
         AND definition LIKE '%admin%'
         AND definition NOT LIKE '%cdm_contact%');
     IF @ck IS NOT NULL
       EXEC(N'ALTER TABLE dbo.users DROP CONSTRAINT ' + @ck);
     ALTER TABLE dbo.users ADD CONSTRAINT CK_users_role
       CHECK (role IN ('admin','staff','cdm_contact'));
   END;`,

  // ★ Remove the role CHECK constraint.
  //
  // The constraint above WIDENED a fixed three-role list into a fixed four-role
  // list, and that is now the wrong shape: the set of valid roles is data. So the
  // constraint is DROPPED rather than widened a third time, and the referential
  // integrity that replaces it is the FK further down, which is strictly
  // stronger — a CHECK can only test membership in a list written into the DDL,
  // while an FK tests membership in the actual table an admin edits.
  //
  // This sits AFTER the widening block above on purpose. On a database still
  // carrying the original three-role constraint, the widening block replaces it
  // and this drops the replacement; on one already carrying the four-role
  // version the widening block's guard (which looks for a constraint that does
  // NOT mention cdm_contact) does not fire and this drops it directly. Either
  // order would work, but this one keeps the older, more specific migration
  // first, so the batch that is being made redundant is visibly still intact.
  //
  // Found by WHAT IT CONSTRAINS, never by name: the original was declared inline
  // on the column and the replacement was added as CK_users_role, so both
  // spellings have to be caught — and every match is dropped, not the first,
  // because a database that has been through both revisions can carry either.
  // The `role` word in the predicate is the same one the widening block uses.
  `DECLARE @drop_role_checks nvarchar(max) = N'';
   SELECT @drop_role_checks = @drop_role_checks
        + N'ALTER TABLE dbo.users DROP CONSTRAINT ' + QUOTENAME(name) + N';' + CHAR(10)
     FROM sys.check_constraints
    WHERE parent_object_id = OBJECT_ID('dbo.users')
      AND definition LIKE '%role%';
   IF @drop_role_checks <> N'' EXEC sp_executesql @drop_role_checks;`,

  // Widen `users.role` from NVARCHAR(20) to NVARCHAR(40) so it can be a foreign
  // key target against dbo.roles.role_key — an FK requires the two columns to
  // agree on type AND length.
  //
  // Guarded on the ACTUAL width (40 nvarchar characters = 80 bytes) rather than
  // on "has this migration run", so it is a no-op both on a fresh database (where
  // the CREATE TABLE already declares 40) and on every boot after the first. It
  // must run AFTER the batch above: a CHECK constraint on the column blocks
  // ALTER COLUMN, which is why these are three separate batches rather than one.
  //
  // Widening nvarchar is a metadata-only change in SQL Server — it does not
  // rewrite the table — so this is safe against a live table. The `>= 1700`
  // case (a column copied from a foreign database as nvarchar(max)) narrows
  // instead, which DOES move data, but every value here is a role key well
  // under 40 characters or the foreign key below could not be satisfied anyway.
  `IF COL_LENGTH('dbo.users', 'role') IS NOT NULL
     AND EXISTS (SELECT 1 FROM sys.columns
                  WHERE object_id = OBJECT_ID('dbo.users')
                    AND name = 'role'
                    AND max_length <> 80)
     ALTER TABLE dbo.users ALTER COLUMN role NVARCHAR(40) NOT NULL;`,

  // The foreign key that makes "a role that has been assigned cannot be deleted"
  // a rule the DATABASE enforces, rather than a check `routes/roles.ts` performs
  // and some future write path forgets to.
  //
  // No `ON DELETE` clause, deliberately — the default NO ACTION is the mechanism,
  // not an omission. Deleting an assigned role raises SQL Server error 547, which
  // the DELETE handler catches and answers as a 409 naming how many users hold
  // the role. A `ON DELETE SET NULL` would silently unassign every holder, and a
  // `CASCADE` would delete the accounts.
  //
  // Note what this does NOT cover: `users.role` is the only reference the
  // database knows about. `form_fields.roles`, `system_messages.audience`,
  // `menu_items` and `documents_link` all store role keys inside JSON, where no
  // FK can reach them — so the delete guard ALSO runs a census over those four,
  // and `routes/roles.ts` is the only place that knows both halves exist.
  `${fkGuard("users", "role", "roles")}
     ALTER TABLE dbo.users ADD CONSTRAINT FK_users_role
       FOREIGN KEY (role) REFERENCES dbo.roles(role_key) ON DELETE NO ACTION;`,

  // ---------------------------------------------------------------------
  // Organizations — users.organization_id (1:1 tenant boundary).
  // Nullable → backfill to Academics → NOT NULL. FK and index.
  //
  // These are SPLIT into separate batches because SQL Server compiles each
  // `request.batch()` before executing it. A statement that references
  // organization_id cannot be compiled in the same batch that only ADDS the
  // column via ALTER TABLE — that yields error 207 "Invalid column name".
  // ---------------------------------------------------------------------
  `IF COL_LENGTH('dbo.users', 'organization_id') IS NULL
     ALTER TABLE dbo.users ADD organization_id INT NULL;`,

  `IF EXISTS (SELECT 1 FROM dbo.users WHERE organization_id IS NULL)
     UPDATE u SET u.organization_id = o.id
     FROM dbo.users u CROSS JOIN dbo.organizations o
     WHERE o.slug = N'academics' AND u.organization_id IS NULL;
   IF NOT EXISTS (SELECT 1 FROM dbo.users WHERE organization_id IS NULL)
     AND ${isNullableInt("users", "organization_id")}
     ALTER TABLE dbo.users ALTER COLUMN organization_id INT NOT NULL;`,

  `${fkGuard("users", "organization_id", "organizations")}
     ALTER TABLE dbo.users ADD CONSTRAINT FK_users_organization
       FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION;
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_users_organization')
     CREATE INDEX IX_users_organization ON dbo.users(organization_id);`,

  `IF OBJECT_ID('dbo.forms', 'U') IS NULL
   CREATE TABLE dbo.forms (
     id          INT IDENTITY(1,1) PRIMARY KEY,
     title       NVARCHAR(200) NOT NULL,
     description NVARCHAR(MAX) NULL,
     school_id   INT NULL,
     designer_id INT NULL,
     status      NVARCHAR(20) NOT NULL CONSTRAINT DF_forms_status DEFAULT 'draft'
                 CHECK (status IN ('draft','published','archived')),
     pre_archive_status NVARCHAR(20) NULL,
     created_at  DATETIME2 NOT NULL CONSTRAINT DF_forms_created_at DEFAULT SYSUTCDATETIME(),
     updated_at  DATETIME2 NOT NULL CONSTRAINT DF_forms_updated_at DEFAULT SYSUTCDATETIME(),
     CONSTRAINT FK_forms_school FOREIGN KEY (school_id) REFERENCES dbo.schools(id) ON DELETE CASCADE,
     CONSTRAINT FK_forms_designer FOREIGN KEY (designer_id) REFERENCES dbo.users(id) ON DELETE SET NULL
   );
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_forms_school')
     CREATE INDEX IX_forms_school ON dbo.forms(school_id);
   ${indexGuard("IX_forms_status", "forms", ["status"])}
     CREATE INDEX IX_forms_status ON dbo.forms(status);`,

  // ---------------------------------------------------------------------
  // Organizations — forms.organization_id (tenant owner of the form).
  // Nullable → backfill to Academics → NOT NULL. FK and index.
  // (Split into separate batches to avoid error 207 — see users note above.)
  // ---------------------------------------------------------------------
  `IF COL_LENGTH('dbo.forms', 'organization_id') IS NULL
     ALTER TABLE dbo.forms ADD organization_id INT NULL;`,

  `IF EXISTS (SELECT 1 FROM dbo.forms WHERE organization_id IS NULL)
     UPDATE f SET f.organization_id = o.id
     FROM dbo.forms f CROSS JOIN dbo.organizations o
     WHERE o.slug = N'academics' AND f.organization_id IS NULL;
   IF NOT EXISTS (SELECT 1 FROM dbo.forms WHERE organization_id IS NULL)
     AND ${isNullableInt("forms", "organization_id")}
     ALTER TABLE dbo.forms ALTER COLUMN organization_id INT NOT NULL;`,

  `${fkGuard("forms", "organization_id", "organizations")}
     ALTER TABLE dbo.forms ADD CONSTRAINT FK_forms_organization
       FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION;
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_forms_organization')
     CREATE INDEX IX_forms_organization ON dbo.forms(organization_id);`,

  // Form-level Google Drive folder override. NULL → fall back to the global
  // env.google.docFolderId when generating documents for this form.
  `IF COL_LENGTH('dbo.forms', 'doc_folder_id') IS NULL
     ALTER TABLE dbo.forms ADD doc_folder_id NVARCHAR(255) NULL;`,

  // Optional link to the source Google Form this form mirrors. When set, staff
  // can open the Google Form directly (e.g. to fill it in manually). Purely
  // informational — no API integration; the admin pastes the URL by hand.
  `IF COL_LENGTH('dbo.forms', 'google_form_url') IS NULL
     ALTER TABLE dbo.forms ADD google_form_url NVARCHAR(1000) NULL;`,

  // View Columns feature — per-form configuration of which columns the admin
  // Submissions grid displays. NULL/empty => show all columns (backward
  // compatible); non-empty => JSON array of field ids, e.g. [1,3,4].
  // This is a separate batch so SQL Server binds the ALTER before any index.
  `IF COL_LENGTH('dbo.forms', 'view_columns') IS NULL
     ALTER TABLE dbo.forms ADD view_columns NVARCHAR(MAX) NULL;`,

  // ---------------------------------------------------------------------
  // Incremental Submission IDs — forms.code (short, globally-unique prefix,
  // e.g. "CDM"). Nullable; forms without a code fall back to `SUB` and the
  // unique index ignores NULLs (filtered) so multiple uncoded forms coexist.
  // Separate batch so the ALTER bounds before the index is created.
  // ---------------------------------------------------------------------
  `IF COL_LENGTH('dbo.forms', 'code') IS NULL
     ALTER TABLE dbo.forms ADD code NVARCHAR(20) NULL;`,

  `${indexGuard("UX_forms_code", "forms", ["code"])}
     CREATE UNIQUE INDEX UX_forms_code ON dbo.forms(code) WHERE code IS NOT NULL;`,

  // Per-form monotonic counter used to allocate incremental submission ids.
  `IF COL_LENGTH('dbo.forms', 'submission_seq') IS NULL
     ALTER TABLE dbo.forms ADD submission_seq INT NOT NULL
       CONSTRAINT DF_forms_submission_seq DEFAULT 0;`,

  // ---------------------------------------------------------------------
  // Archive & Restore — forms.pre_archive_status. A form that is retired is
  // archived rather than deleted, so its submissions survive. The status it
  // held at the moment it was archived is remembered here so Restore can put
  // it back exactly as it was instead of always landing on `draft`.
  //
  // Deliberately NOT constrained by a CHECK: this is a historical record, not
  // an active state, and the only writer is `archiveForm`, which copies the
  // current `status` — itself already CHECK-constrained.
  // ---------------------------------------------------------------------
  `IF COL_LENGTH('dbo.forms', 'pre_archive_status') IS NULL
     ALTER TABLE dbo.forms ADD pre_archive_status NVARCHAR(20) NULL;`,

  // ---------------------------------------------------------------------
  // Incremental Submission IDs — submissions.submission_seq. Stored so the
  // numeric portion is queryable without parsing public_id. Nullable: it is
  // only populated by the new-format insert and the one-time backfill, so
  // legacy hex rows retain NULL here until backfilled.
  // ---------------------------------------------------------------------
  `IF COL_LENGTH('dbo.submissions', 'submission_seq') IS NULL
     ALTER TABLE dbo.submissions ADD submission_seq INT NULL;`,

  // ---------------------------------------------------------------------
  // School Year — denormalized on submissions so it's a stable snapshot and
  // queryable/filterable. Populated on insert (createSubmission) and by the
  // one-time backfill below. The school year runs Aug 1 -> Jul 31, so a date
  // in Aug-Dec belongs to YYYY-YYYY+1 and a date in Jan-Jul belongs to the
  // prior year. Nullable so the migration is additive/backward-compatible.
  // ---------------------------------------------------------------------
  `IF COL_LENGTH('dbo.submissions', 'school_year') IS NULL
     ALTER TABLE dbo.submissions ADD school_year NVARCHAR(9) NULL;`,

  // One-time backfill for rows created before the column existed. Derives each
  // row's year from ITS OWN submitted_at (not the current date), so a June 2026
  // submission correctly gets '2025-2026'. Idempotent: only fills NULL/empty.
  // `TRY_CONVERT` rather than a bare `MONTH(...)`: on a database whose
  // `submitted_at` is TEXT (the app's own is DATETIME2, where TRY_CONVERT is the
  // identity) the implicit conversion is what is being relied on, and a single
  // unparseable value would throw and abort the rest of the ladder. Rows that do
  // not convert are left as they are instead — visibly NULL — rather than taking
  // the schema down with them.
  `UPDATE dbo.submissions
     SET school_year =
       CASE
         WHEN MONTH(TRY_CONVERT(datetime2, submitted_at)) >= 8
           THEN CAST(YEAR(TRY_CONVERT(datetime2, submitted_at)) AS nvarchar(4)) + '-' + CAST(YEAR(TRY_CONVERT(datetime2, submitted_at)) + 1 AS nvarchar(4))
         ELSE CAST(YEAR(TRY_CONVERT(datetime2, submitted_at)) - 1 AS nvarchar(4)) + '-' + CAST(YEAR(TRY_CONVERT(datetime2, submitted_at)) AS nvarchar(4))
       END
   WHERE (school_year IS NULL OR school_year = '')
     AND TRY_CONVERT(datetime2, submitted_at) IS NOT NULL;`,

  `IF OBJECT_ID('dbo.form_fields', 'U') IS NULL
   CREATE TABLE dbo.form_fields (
     id          INT IDENTITY(1,1) PRIMARY KEY,
     form_id     INT NOT NULL,
     label       NVARCHAR(200) NOT NULL,
     type        NVARCHAR(20) NOT NULL CHECK (type IN ('text','textarea','number','date','select','checkbox','radio','email','google_doc')),
     options     NVARCHAR(MAX) NULL,
     required    BIT NOT NULL CONSTRAINT DF_form_fields_required DEFAULT 0,
     staff_only  BIT NOT NULL CONSTRAINT DF_form_fields_staff_only DEFAULT 0,
     sort_order  INT NOT NULL CONSTRAINT DF_form_fields_sort_order DEFAULT 0,
     placeholder NVARCHAR(200) NULL,
     CONSTRAINT FK_form_fields_form FOREIGN KEY (form_id) REFERENCES dbo.forms(id) ON DELETE CASCADE
   );
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_form_fields_form')
     CREATE INDEX IX_form_fields_form ON dbo.form_fields(form_id);`,

  // Role-based field visibility — which roles can access an internal (staff_only)
  // field. Stored as a JSON array of role strings (e.g. '["admin","staff"]');
  // NULL for parent-facing fields. A staff_only field with NULL/empty roles is
  // treated as visible to all current roles (admin + staff).
  `IF COL_LENGTH('dbo.form_fields', 'roles') IS NULL
     ALTER TABLE dbo.form_fields ADD roles NVARCHAR(MAX) NULL;`,

  // One-time backfill: existing staff-only fields default to admin + staff, the
  // two roles that existed before this feature. Explicitly stored so the value is
  // queryable and future role additions don't silently grant old fields access.
  `UPDATE dbo.form_fields
     SET roles = N'["admin","staff"]'
   WHERE staff_only = 1 AND (roles IS NULL OR roles = '');`,

  `IF OBJECT_ID('dbo.submissions', 'U') IS NULL
   CREATE TABLE dbo.submissions (
     id           INT IDENTITY(1,1) PRIMARY KEY,
     public_id    NVARCHAR(64) NOT NULL,
     form_id      INT NOT NULL,
     school_id    INT NULL,
     status       NVARCHAR(20) NOT NULL CONSTRAINT DF_submissions_status DEFAULT 'submitted'
                  CONSTRAINT CK_submissions_status
                  CHECK (status IN ('submitted','in_review','flagged','completed')),
     submitted_at DATETIME2 NOT NULL CONSTRAINT DF_submissions_submitted_at DEFAULT SYSUTCDATETIME(),
     updated_at   DATETIME2 NOT NULL CONSTRAINT DF_submissions_updated_at DEFAULT SYSUTCDATETIME(),
     archived_at  DATETIME2 NULL,
     archived_by  INT NULL,
     CONSTRAINT FK_submissions_form FOREIGN KEY (form_id) REFERENCES dbo.forms(id) ON DELETE CASCADE,
     CONSTRAINT FK_submissions_school FOREIGN KEY (school_id) REFERENCES dbo.schools(id) ON DELETE NO ACTION
   );
   ${indexGuard("UX_submissions_public_id", "submissions", ["public_id"])}
     CREATE UNIQUE INDEX UX_submissions_public_id ON dbo.submissions(public_id);
   ${indexGuard("IX_submissions_submitted_at", "submissions", ["submitted_at"])}
     CREATE INDEX IX_submissions_submitted_at ON dbo.submissions(submitted_at);`,

  // ---------------------------------------------------------------------
  // Organizations — submissions.organization_id (denormalized from its form
  // for fast org scoping, mirroring school_id). Backfill from forms.
  // (Split into separate batches to avoid error 207 — see users note above.)
  // ---------------------------------------------------------------------
  `IF COL_LENGTH('dbo.submissions', 'organization_id') IS NULL
     ALTER TABLE dbo.submissions ADD organization_id INT NULL;`,

  `IF EXISTS (SELECT 1 FROM dbo.submissions WHERE organization_id IS NULL)
     UPDATE s SET s.organization_id = f.organization_id
     FROM dbo.submissions s JOIN dbo.forms f ON f.id = s.form_id
     WHERE s.organization_id IS NULL;
   IF NOT EXISTS (SELECT 1 FROM dbo.submissions WHERE organization_id IS NULL AND form_id IS NOT NULL)
     AND ${isNullableInt("submissions", "organization_id")}
     ALTER TABLE dbo.submissions ALTER COLUMN organization_id INT NOT NULL;`,

  `${fkGuard("submissions", "organization_id", "organizations")}
     ALTER TABLE dbo.submissions ADD CONSTRAINT FK_submissions_organization
       FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION;
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_submissions_org_school_form')
     CREATE INDEX IX_submissions_org_school_form ON dbo.submissions(organization_id, school_id, form_id);`,

  // ---------------------------------------------------------------------
  // Staff-only fields audit trail — which staff last saved the submission's
  // staff-only fields, and when. Populated by PUT /values when staff_only=true.
  // (Separate batch: the submissions table must already exist for COL_LENGTH.)
  // ---------------------------------------------------------------------
  `IF COL_LENGTH('dbo.submissions', 'staff_fields_updated_by') IS NULL
     ALTER TABLE dbo.submissions ADD staff_fields_updated_by INT NULL;
   IF COL_LENGTH('dbo.submissions', 'staff_fields_updated_at') IS NULL
     ALTER TABLE dbo.submissions ADD staff_fields_updated_at DATETIME2 NULL;`,

  // ---------------------------------------------------------------------
  // Archive ("hidden from every view").
  //
  // A submission is archived by stamping `archived_at`; NULL means "in the
  // views". Two reasons this is a timestamp rather than another value of
  // `status` (which is how forms are archived):
  //
  //   1. `status` is the WORKFLOW state, and it is carried into grid filters,
  //      saved report views' `filters` JSON and every export. Folding archive
  //      into it would mean every status filter and every saved view has to
  //      learn a value that means "not work", and PATCH /status would become an
  //      archive endpoint by accident.
  //   2. Restore is then exactly "clear the column". No `pre_archive_status`
  //      twin to keep in step and no invariant to enforce — the workflow state
  //      was never touched, so there is nothing to remember.
  //
  // Deliberately NOT part of CK_submissions_status: archiving does not change
  // what work state a submission is in.
  //
  // `archived_by` is the audit trail (who put it away). No FK, matching the
  // other actor columns on this ladder: an INT rather than a reference keeps a
  // user delete from touching submission history.
  // ---------------------------------------------------------------------
  `IF COL_LENGTH('dbo.submissions', 'archived_at') IS NULL
     ALTER TABLE dbo.submissions ADD archived_at DATETIME2 NULL;
   IF COL_LENGTH('dbo.submissions', 'archived_by') IS NULL
     ALTER TABLE dbo.submissions ADD archived_by INT NULL;`,

  `IF OBJECT_ID('dbo.submission_values', 'U') IS NULL
   CREATE TABLE dbo.submission_values (
     id            INT IDENTITY(1,1) PRIMARY KEY,
     submission_id INT NOT NULL,
     field_id      INT NOT NULL,
     value         NVARCHAR(MAX) NULL,
     CONSTRAINT FK_submission_values_submission FOREIGN KEY (submission_id) REFERENCES dbo.submissions(id) ON DELETE CASCADE,
     CONSTRAINT FK_submission_values_field FOREIGN KEY (field_id) REFERENCES dbo.form_fields(id) ON DELETE NO ACTION
   );
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_submission_values_submission')
     CREATE INDEX IX_submission_values_submission ON dbo.submission_values(submission_id);
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_submission_values_field')
     CREATE INDEX IX_submission_values_field ON dbo.submission_values(field_id);`,

  // Staff-only ad-hoc fields on a specific submission. Kept out of form_fields
  // so the published template stays fixed while staff extend individual records.
  `IF OBJECT_ID('dbo.submission_adhoc_fields', 'U') IS NULL
   CREATE TABLE dbo.submission_adhoc_fields (
     id            INT IDENTITY(1,1) PRIMARY KEY,
     submission_id INT NOT NULL,
     label         NVARCHAR(200) NOT NULL,
     type          NVARCHAR(20) NOT NULL CHECK (type IN ('text','textarea','number','date','select','checkbox','radio','email','google_doc')),
     options       NVARCHAR(MAX) NULL,
     value         NVARCHAR(MAX) NULL,
     sort_order    INT NOT NULL CONSTRAINT DF_adhoc_fields_sort_order DEFAULT 0,
     created_by    INT NULL,
     created_at    DATETIME2 NOT NULL CONSTRAINT DF_adhoc_fields_created_at DEFAULT SYSUTCDATETIME(),
     updated_at    DATETIME2 NOT NULL CONSTRAINT DF_adhoc_fields_updated_at DEFAULT SYSUTCDATETIME(),
     CONSTRAINT FK_adhoc_fields_submission FOREIGN KEY (submission_id) REFERENCES dbo.submissions(id) ON DELETE CASCADE,
     CONSTRAINT FK_adhoc_fields_creator FOREIGN KEY (created_by) REFERENCES dbo.users(id) ON DELETE SET NULL
   );
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_adhoc_fields_submission')
     CREATE INDEX IX_adhoc_fields_submission ON dbo.submission_adhoc_fields(submission_id);`,

  // Widen the `type` CHECK on BOTH field tables to accept 'google_doc'.
  //
  // ★ The CREATE TABLE above only runs when the table is brand new, so an existing
  // deployment keeps its original eight-value constraint and REFUSES the new type
  // at the INSERT — SQL Server error 547, which this app does not translate (it
  // inspects no DB error codes), so it surfaces as a 500 naming a generated
  // constraint name. The declaration is not the fix; this batch is.
  //
  // ★ Both constraints are declared INLINE and therefore auto-named, so the drop
  // is found by WHAT IT CONSTRAINS, never by name — the same technique the
  // CK_users_role migration above uses. `definition LIKE '%textarea%'` identifies
  // a type-list constraint (textarea is in the list and in no other CHECK on these
  // tables), and `NOT LIKE '%google_doc%'` is the guard that makes the batch
  // idempotent: after the first run the replacement contains google_doc, so it is
  // not selected and nothing is dropped.
  //
  // ★ TWO tables, and both matter: `submission_adhoc_fields` holds the per-
  // submission staff-only fields, which are created from the same designer type
  // list, so a google_doc ad-hoc field would 547 on exactly the same INSERT.
  //
  // ★ WITH CHECK (not NOCHECK) on the re-add. NOCHECK would add the constraint
  // WITHOUT validating existing rows, so a table that had somehow acquired a bad
  // value would keep it while the constraint claimed otherwise. Every existing row
  // is in the old list by construction, so the validating add cannot fail.
  //
  // The re-added constraint is given an EXPLICIT name so a future widening has a
  // stable thing to look for — and so this batch's own guard keeps working.
  `IF EXISTS (SELECT 1 FROM sys.check_constraints
               WHERE parent_object_id = OBJECT_ID('dbo.form_fields')
                 AND definition LIKE '%textarea%'
                 AND definition NOT LIKE '%google_doc%')
   BEGIN
     DECLARE @ck_ff nvarchar(128) = (SELECT TOP 1 name FROM sys.check_constraints
       WHERE parent_object_id = OBJECT_ID('dbo.form_fields')
         AND definition LIKE '%textarea%'
         AND definition NOT LIKE '%google_doc%');
     IF @ck_ff IS NOT NULL
       EXEC(N'ALTER TABLE dbo.form_fields DROP CONSTRAINT ' + @ck_ff);
     ALTER TABLE dbo.form_fields ADD CONSTRAINT CK_form_fields_type
       CHECK (type IN ('text','textarea','number','date','select','checkbox','radio','email','google_doc'));
   END;`,

  `IF EXISTS (SELECT 1 FROM sys.check_constraints
               WHERE parent_object_id = OBJECT_ID('dbo.submission_adhoc_fields')
                 AND definition LIKE '%textarea%'
                 AND definition NOT LIKE '%google_doc%')
   BEGIN
     DECLARE @ck_ah nvarchar(128) = (SELECT TOP 1 name FROM sys.check_constraints
       WHERE parent_object_id = OBJECT_ID('dbo.submission_adhoc_fields')
         AND definition LIKE '%textarea%'
         AND definition NOT LIKE '%google_doc%');
     IF @ck_ah IS NOT NULL
       EXEC(N'ALTER TABLE dbo.submission_adhoc_fields DROP CONSTRAINT ' + @ck_ah);
     ALTER TABLE dbo.submission_adhoc_fields ADD CONSTRAINT CK_submission_adhoc_fields_type
       CHECK (type IN ('text','textarea','number','date','select','checkbox','radio','email','google_doc'));
   END;`,

  // Generic app-wide key/value settings (login_mode, maintenance_message, ...).
  // This is the storage for the Login Mode feature (Settings → Login Mode).
  // The column is added in the same batch here since it's a fresh CREATE TABLE.
  `IF OBJECT_ID('dbo.app_settings', 'U') IS NULL
   CREATE TABLE dbo.app_settings (
     [key]      NVARCHAR(100) NOT NULL PRIMARY KEY,
     [value]    NVARCHAR(MAX) NOT NULL,
     updated_at DATETIME2 NOT NULL CONSTRAINT DF_app_settings_updated_at DEFAULT SYSUTCDATETIME()
   );`,

  // Generated Google Documents. `submission_id` has a single cascade path to
  // schools (via submissions->forms->schools) so NO ACTION/other FK rules are
  // chosen here; the only child FK out of submissions is to documents with
  // ON DELETE CASCADE, plus created_by->users ON DELETE SET NULL (users is an
  // ancestor of nothing on this path, so no 1785 risk).
  `IF OBJECT_ID('dbo.documents', 'U') IS NULL
   CREATE TABLE dbo.documents (
     id            INT IDENTITY(1,1) PRIMARY KEY,
     submission_id INT NOT NULL,
     document_id   NVARCHAR(100) NULL,
     status        NVARCHAR(20) NOT NULL CONSTRAINT DF_documents_status DEFAULT 'Pending'
                   CHECK (status IN ('Pending','Completed','Failed')),
     created_by    INT NULL,
     created_at    DATETIME2 NOT NULL CONSTRAINT DF_documents_created_at DEFAULT SYSUTCDATETIME(),
     updated_at    DATETIME2 NOT NULL CONSTRAINT DF_documents_updated_at DEFAULT SYSUTCDATETIME(),
     error         NVARCHAR(MAX) NULL,
     CONSTRAINT FK_documents_submission FOREIGN KEY (submission_id) REFERENCES dbo.submissions(id) ON DELETE CASCADE,
     CONSTRAINT FK_documents_creator FOREIGN KEY (created_by) REFERENCES dbo.users(id) ON DELETE SET NULL
   );
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_documents_submission')
     CREATE INDEX IX_documents_submission ON dbo.documents(submission_id);`,

  // Saved Reports views — a named, per-user report configuration: which form,
  // which filters, which columns, and which export format. `filters` and
  // `columns` are JSON blobs (same rationale as dbo.forms.view_columns) so the
  // filter contract can grow without a migration. Created last because it
  // references both dbo.users and dbo.forms.
  `IF OBJECT_ID('dbo.report_views', 'U') IS NULL
   CREATE TABLE dbo.report_views (
     id              INT IDENTITY(1,1) PRIMARY KEY,
     user_id         INT NOT NULL,
     organization_id INT NULL,
     name            NVARCHAR(120) NOT NULL,
     form_id         INT NOT NULL,
     filters         NVARCHAR(MAX) NULL,
     columns         NVARCHAR(MAX) NULL,
     format          NVARCHAR(10) NOT NULL CONSTRAINT DF_report_views_format DEFAULT 'csv',
     is_default      BIT NOT NULL CONSTRAINT DF_report_views_is_default DEFAULT 0,
     last_used_at    DATETIME2 NULL,
     created_at      DATETIME2 NOT NULL CONSTRAINT DF_report_views_created_at DEFAULT SYSUTCDATETIME(),
     updated_at      DATETIME2 NOT NULL CONSTRAINT DF_report_views_updated_at DEFAULT SYSUTCDATETIME(),
     CONSTRAINT FK_report_views_user FOREIGN KEY (user_id) REFERENCES dbo.users(id) ON DELETE CASCADE,
     CONSTRAINT FK_report_views_form FOREIGN KEY (form_id) REFERENCES dbo.forms(id) ON DELETE CASCADE
   );
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_report_views_user_name')
     CREATE UNIQUE INDEX UX_report_views_user_name ON dbo.report_views(user_id, name);
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_report_views_user')
     CREATE INDEX IX_report_views_user ON dbo.report_views(user_id);`,

  // ---------------------------------------------------------------------
  // Rename the submission status "resolved" -> "completed".
  //
  // Three things move together: the value stored on existing rows, the CHECK
  // constraint that enumerates the allowed values, and the status captured inside
  // each saved report view's `filters` JSON.
  //
  // Order matters. The legacy constraint is dropped BEFORE the rows are updated,
  // otherwise the UPDATE trips it. The constraint is then re-added under an
  // explicit name (CK_submissions_status) so a future value change can target it
  // without hunting for a server-generated name in sys.check_constraints — the
  // original inline CHECK was unnamed, which is precisely this problem. Fresh
  // databases already get the named constraint from CREATE TABLE above, so every
  // branch here is a no-op for them.
  `DECLARE @legacy_ck sysname;
   SELECT TOP 1 @legacy_ck = name FROM sys.check_constraints
    WHERE parent_object_id = OBJECT_ID('dbo.submissions')
      AND name <> 'CK_submissions_status'
      AND definition LIKE '%status%';
   IF @legacy_ck IS NOT NULL
     EXEC('ALTER TABLE dbo.submissions DROP CONSTRAINT ' + @legacy_ck);

   UPDATE dbo.submissions SET status = N'completed' WHERE status = N'resolved';

   IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_submissions_status')
     ALTER TABLE dbo.submissions
       ADD CONSTRAINT CK_submissions_status
       CHECK (status IN ('submitted','in_review','flagged','completed'));`,

  // The same rename inside saved report views. `filters` is written with
  // JSON.stringify (compact — no spaces), so this literal replace is exact, and
  // the LIKE guard makes it a no-op for any view that never filtered by status.
  // Skipping this would leave those views filtering on a value that no longer
  // exists, silently matching nothing.
  `UPDATE dbo.report_views
      SET filters = REPLACE(filters, N'"status":"resolved"', N'"status":"completed"')
    WHERE filters LIKE N'%"status":"resolved"%';`,

  // ---------------------------------------------------------------------
  // Per-user Submissions grid column selection
  // (dbo.user_form_view_columns).
  //
  // Supersedes dbo.forms.view_columns, which held ONE value per form and was
  // therefore shared by every user who opened that form. That was fine while
  // only admins saw the grid; once staff and School Contacts got the column
  // chooser too, any one of them saving would silently rewrite what the org
  // admin saw. Same per-user shape as dbo.report_views.
  //
  // Created last because it references both dbo.users and dbo.forms. Two
  // cascading paths into one table is exactly what dbo.report_views already
  // does, so this adds no new multiple-cascade-path (error 1785) risk.
  //
  // `columns` is a JSON array of field ids, e.g. [11,9]. NULL means "never
  // chosen" and reads back as "not configured", which is deliberately distinct
  // from '[]' ("the user chose nothing") — see getViewColumnsConfig.
  // ---------------------------------------------------------------------
  `IF OBJECT_ID('dbo.user_form_view_columns', 'U') IS NULL
   CREATE TABLE dbo.user_form_view_columns (
     id         INT IDENTITY(1,1) PRIMARY KEY,
     user_id    INT NOT NULL,
     form_id    INT NOT NULL,
     columns    NVARCHAR(MAX) NULL,
     created_at DATETIME2 NOT NULL CONSTRAINT DF_ufvc_created_at DEFAULT SYSUTCDATETIME(),
     updated_at DATETIME2 NOT NULL CONSTRAINT DF_ufvc_updated_at DEFAULT SYSUTCDATETIME(),
     CONSTRAINT FK_ufvc_user FOREIGN KEY (user_id) REFERENCES dbo.users(id) ON DELETE CASCADE,
     CONSTRAINT FK_ufvc_form FOREIGN KEY (form_id) REFERENCES dbo.forms(id) ON DELETE CASCADE
   );
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_ufvc_user_form')
     CREATE UNIQUE INDEX UX_ufvc_user_form ON dbo.user_form_view_columns(user_id, form_id);`,

  // Carry the one legacy dbo.forms.view_columns value over to the form's
  // designer, who is the person most likely to have set it. Without this an
  // existing selection would silently vanish on upgrade. Idempotent, and
  // deliberately best-effort: a form with no designer_id has no recoverable
  // owner, so it simply starts unconfigured.
  `INSERT INTO dbo.user_form_view_columns (user_id, form_id, columns)
     SELECT f.designer_id, f.id, f.view_columns
       FROM dbo.forms f
      WHERE f.view_columns IS NOT NULL
        AND f.designer_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM dbo.user_form_view_columns u
                         WHERE u.user_id = f.designer_id AND u.form_id = f.id);`,

  // ---------------------------------------------------------------------
  // Public / Private forms — per-form visibility + access requests
  // (docs/plans/public-private-forms.md).
  //
  // ★ THREE batches for the column, and the split is not cosmetic:
  //   - a statement referencing `visibility` needs its OWN batch (error 207),
  //   - and a CHECK cannot be added in the batch that adds its column.
  // ---------------------------------------------------------------------

  // ★ `DEFAULT 'public'` IS THE WHOLE DEPLOY STORY. Every existing form, and
  // every form an admin creates without touching the field, is public — so
  // shipping this changes no behaviour for anyone. The narrowing happens only
  // when an administrator deliberately marks a specific form private.
  `IF COL_LENGTH('dbo.forms', 'visibility') IS NULL
     ALTER TABLE dbo.forms ADD visibility NVARCHAR(10) NOT NULL
       CONSTRAINT DF_forms_visibility DEFAULT 'public';`,

  // Own batch (see above). Guarded on the CONSTRAINT by name, not on the column,
  // so it is a no-op once present and still runs on a database that somehow has
  // the column without the constraint.
  `IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_forms_visibility')
     ALTER TABLE dbo.forms WITH CHECK ADD CONSTRAINT CK_forms_visibility
       CHECK (visibility IN ('public','private'));`,

  // The request AND the grant, in ONE table.
  //
  // ★ PRIMARY KEY (user_id, form_id) IS the idempotency mechanism: "request
  // access" twice is one row, and approve-then-decline is an UPDATE rather than a
  // second row a careless query would double-count. Same shape as
  // dbo.system_message_dismissals, which exists for the same reason.
  //
  // ★ NO FOREIGN KEYS, deliberately — matching system_message_dismissals and
  // webhook_events. A deleted user or form must not be blocked by its access
  // rows (they are removed explicitly when the parent goes), and it avoids SQL
  // Server's one-cascade-path rule (error 1785), which has bitten this schema
  // twice already.
  //
  // ★ No index beyond the PK. The self-lookup seeks the PK in its own column
  // order and the admin queue is a scan of a table holding tens of rows — an
  // index here would be a claim, not a performance fix, AND it would oblige a
  // matching entry in expectedIndexNames() and the Turso DDL (libsql.test.ts
  // asserts the two dialects disagree on nothing).
  `IF OBJECT_ID('dbo.form_access', 'U') IS NULL
   CREATE TABLE dbo.form_access (
     user_id      INT           NOT NULL,
     form_id      INT           NOT NULL,
     status       NVARCHAR(20)  NOT NULL
         CONSTRAINT CK_form_access_status CHECK (status IN ('pending','approved','denied')),
     source       NVARCHAR(20)  NOT NULL
         CONSTRAINT CK_form_access_source CHECK (source IN ('request','backfill','direct')),
     requested_at DATETIME2     NOT NULL CONSTRAINT DF_form_access_requested DEFAULT SYSUTCDATETIME(),
     decided_at   DATETIME2     NULL,
     decided_by   INT           NULL,
     note         NVARCHAR(400) NULL,
     CONSTRAINT PK_form_access PRIMARY KEY (user_id, form_id)
   );`,

  // The append-only audit log.
  //
  // ★ Its own table rather than columns on form_access, and the split is the
  // point: form_access answers "may this person read this form NOW?" and is what
  // the visibility predicate reads (a single-row seek), while this table answers
  // "who changed this, when, and on whose authority?" and is NEVER consulted by
  // the visibility rule. A history cannot be folded into a table whose primary
  // key is "one row per person per form".
  //
  // ★ APPEND-ONLY: no UPDATE, no DELETE anywhere in the code.
  //
  // ★ `actor_id` is NULLABLE on purpose — it is NULL for a self-service request,
  // because nobody DECIDED anything. A NOT NULL would force a fabricated actor
  // onto requests and make "who approved this?" unanswerable in exactly the case
  // where the answer is "the requester asked".
  `IF OBJECT_ID('dbo.form_access_events', 'U') IS NULL
   CREATE TABLE dbo.form_access_events (
     id         INT IDENTITY(1,1) PRIMARY KEY,
     user_id    INT           NOT NULL,
     form_id    INT           NOT NULL,
     event      NVARCHAR(20)  NOT NULL
         CONSTRAINT CK_form_access_events_event
         CHECK (event IN ('requested','withdrawn','approved','declined','revoked','backfilled')),
     actor_id   INT           NULL,
     note       NVARCHAR(400) NULL,
     created_at DATETIME2     NOT NULL CONSTRAINT DF_form_access_events_created DEFAULT SYSUTCDATETIME()
   );`,

  // ---------------------------------------------------------------------
  // Inbound webhook intake log (docs/plans/webhook-log.md).
  //
  // DELIBERATELY HAS NO FOREIGN KEYS. A cascade from dbo.forms would delete the
  // evidence at exactly the moment it is most wanted, and NO ACTION would make
  // an existing feature fail (DELETE /api/forms/:id would trip an FK error).
  // Nothing references this table either, so it introduces no new cascade path
  // and cannot trigger SQL Server error 1785.
  //
  // `received_at` is declared here but must also be added to TIMESTAMP_COLUMNS
  // in db/client.ts — that is what makes the value land as an ISO-8601 string on
  // Turso and a Date on SQL Server without the API layer noticing.
  // ---------------------------------------------------------------------
  `IF OBJECT_ID('dbo.webhook_events', 'U') IS NULL
   CREATE TABLE dbo.webhook_events (
     id            INT IDENTITY(1,1) PRIMARY KEY,
     source        NVARCHAR(30) NOT NULL CONSTRAINT DF_webhook_events_source DEFAULT 'google',
     received_at   DATETIME2 NOT NULL CONSTRAINT DF_webhook_events_received_at DEFAULT SYSUTCDATETIME(),
     remote_ip     NVARCHAR(64) NULL,
     user_agent    NVARCHAR(200) NULL,
     auth_result   NVARCHAR(20) NOT NULL,
     status        NVARCHAR(20) NOT NULL,
     http_status   INT NOT NULL,
     error_code    NVARCHAR(40) NULL,
     error         NVARCHAR(MAX) NULL,
     form_id       INT NULL,
     organization_id INT NULL,
     submission_id INT NULL,
     public_id     NVARCHAR(64) NULL,
     payload_raw   NVARCHAR(MAX) NULL,
     payload_bytes INT NULL,
     payload_hash  NVARCHAR(64) NULL,
     replay_of     INT NULL,
     replayed_by   INT NULL
   );`,

  // Self-healing guard for a table created by an earlier revision of this
  // branch, before `organization_id` existed. The CREATE TABLE above is skipped
  // wholesale once the table is present, so without this the column would be
  // permanently missing in any scratch database and IX_webhook_events_org — the
  // index that carries this column — would fail to create.
  `IF COL_LENGTH('dbo.webhook_events', 'organization_id') IS NULL
     ALTER TABLE dbo.webhook_events ADD organization_id INT NULL;`,

  // Indexes in their own batch — a CREATE INDEX must not share a batch with the
  // CREATE TABLE that defines its columns (error 207: SQL Server compiles a
  // batch before running it).
  `${indexGuard("IX_webhook_events_received", "webhook_events", ["received_at"])}
     CREATE INDEX IX_webhook_events_received ON dbo.webhook_events(received_at DESC);
   ${indexGuard("IX_webhook_events_status", "webhook_events", ["status", "received_at"])}
     CREATE INDEX IX_webhook_events_status ON dbo.webhook_events(status, received_at DESC);
   ${indexGuard("IX_webhook_events_form", "webhook_events", ["form_id", "received_at"])}
     CREATE INDEX IX_webhook_events_form ON dbo.webhook_events(form_id, received_at DESC);
   ${indexGuard("IX_webhook_events_org", "webhook_events", ["organization_id", "received_at"])}
     CREATE INDEX IX_webhook_events_org ON dbo.webhook_events(organization_id, received_at DESC);
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_webhook_events_replay_of')
     CREATE INDEX IX_webhook_events_replay_of ON dbo.webhook_events(replay_of);`,

  // ---------------------------------------------------------------------
  // System Messages — admin-authored notices (docs/plans/system-messages.md)
  //
  // Two new tables, so NO addColumns entries are needed for Turso (§5.3 of the
  // plan): a new column would need three edits, a new table needs one per
  // dialect.
  //
  // DELIBERATELY NO FOREIGN KEYS, for the same reason webhook_events has none:
  // deleting a message must not fail, and a cascade from dbo.organizations would
  // remove an audit trail silently. The one relation that genuinely needs
  // cleaning up (a message's dismissals) is deleted explicitly, in the same
  // transaction, in deleteSystemMessage — visible in the query rather than
  // hidden in DDL.
  //
  // `organization_id` is NOT NULL on purpose: `active = 1` on a row nobody owns
  // would be a notice every admin's prose is shown to every other tenant.
  //
  // `created_at`/`updated_at` are already in TIMESTAMP_COLUMNS (db/client.ts);
  // `dismissed_at` is added there on this same commit — that set is what makes
  // the value land as an ISO-8601 string on Turso and a Date on SQL Server
  // without the API layer noticing.
  // ---------------------------------------------------------------------
  //
  // `audience` is the JSON array of roles that may be SHOWN the message (the
  // "Target Audience" toggles in the admin panel), stored exactly the way
  // form_fields.roles is: a JSON string, NULL meaning "unrestricted". The unset
  // case covers EVERY role — including one an admin creates later — which is the
  // convention fieldAccessRoles() already established for a staff-only field, and
  // which the list query implements directly as `m.audience IS NULL`. An explicit
  // '[]' means nobody and must NOT be collapsed back to NULL — that distinction
  // is the whole reason the column is nullable.
  `IF OBJECT_ID('dbo.system_messages', 'U') IS NULL
   CREATE TABLE dbo.system_messages (
     id              INT IDENTITY(1,1) PRIMARY KEY,
     organization_id INT NOT NULL,
     title           NVARCHAR(200) NOT NULL,
     body            NVARCHAR(MAX) NOT NULL CONSTRAINT DF_system_messages_body DEFAULT (''),
     active          BIT NOT NULL CONSTRAINT DF_system_messages_active DEFAULT (0),
     audience        NVARCHAR(200) NULL,
     created_by      INT NULL,
     created_at      DATETIME2 NOT NULL CONSTRAINT DF_system_messages_created_at DEFAULT SYSUTCDATETIME(),
     updated_at      DATETIME2 NOT NULL CONSTRAINT DF_system_messages_updated_at DEFAULT SYSUTCDATETIME()
   );`,

  // Self-healing add for `audience`, for the same reason webhook_events
  // .organization_id needs one: `initDb()` runs this ladder at every boot, and a
  // database that already ran an earlier revision of THIS branch has the table
  // (so the CREATE above is skipped) but not the column. Without this the
  // audience filter would fail at runtime with "Invalid column name 'audience'"
  // on the developer's own machine and nowhere else.
  //
  // NULL stays the meaning of "every role", so no backfill is needed or wanted:
  // a pre-existing message is deliberately shown to everyone, and writing an
  // explicit role array here would freeze today's role list into old rows.
  `IF COL_LENGTH('dbo.system_messages', 'audience') IS NULL
     ALTER TABLE dbo.system_messages ADD audience NVARCHAR(200) NULL;`,

  // One row per (message, user) that has closed it out. The composite PK is the
  // idempotency mechanism: a double-clicked X cannot write a second row, and the
  // portable `INSERT ... SELECT ... WHERE NOT EXISTS` upsert this repo already
  // uses elsewhere becomes a genuine no-op rather than a duplicate key error.
  //
  // PK (message_id, user_id) also IS the index the active-list query needs — it
  // looks dismissals up by exactly that pair — so no second index is declared.
  `IF OBJECT_ID('dbo.system_message_dismissals', 'U') IS NULL
   CREATE TABLE dbo.system_message_dismissals (
     message_id   INT NOT NULL,
     user_id      INT NOT NULL,
     dismissed_at DATETIME2 NOT NULL CONSTRAINT DF_smd_dismissed_at DEFAULT SYSUTCDATETIME(),
     CONSTRAINT PK_system_message_dismissals PRIMARY KEY (message_id, user_id)
   );`,

  // Indexes in their own batch — a CREATE INDEX must not share a batch with the
  // CREATE TABLE that defines its columns (error 207: SQL Server compiles a
  // batch before running it).
  //
  // Declared through indexGuard so expectedIndexNames() (below) sees it and the
  // boot-time "N indexes MISSING" warning stays honest — a bare name check would
  // be satisfied by an index on the wrong columns, and a CREATE INDEX against a
  // column this foreign database declares as nvarchar(max) would fail and abort
  // every later batch, leaving dbReady false.
  `${indexGuard("IX_system_messages_org_active", "system_messages", ["organization_id", "active", "created_at"])}
     CREATE INDEX IX_system_messages_org_active ON dbo.system_messages(organization_id, active, created_at DESC);`,
];

// A saved report configuration. `filters`/`columns` are JSON strings in the DB
// but are exposed to the API as parsed objects (see queries.listReportViews).
export interface ReportView {
  id: number;
  user_id: number;
  organization_id: number | null;
  name: string;
  form_id: number;
  filters: string | null;
  columns: string | null;
  format: string;
  is_default: boolean;
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export const REPORT_FORMATS = ["csv", "xlsx", "pdf"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

// An admin-authored notice shown to everyone in one organization until each
// person closes it out. `body` is optional in the UI but NOT NULL in the DB, so
// it is always a string here and never `string | null` — the write path
// defaulting it to "" is the only thing keeping that honest.
//
// There is deliberately no `closed_count` / `audience_count` field: the feature
// reports no close-out figures (see docs/plans/system-messages.md §3 decision 11).
//
// `audience` is typed as an array because that is the API contract, but the value
// read straight out of the database is a JSON STRING (NVARCHAR/TEXT), exactly
// like `FormField.roles` above. `toSystemMessage` in queries.ts is the only thing
// that turns one into the other, so every reader that goes through it sees a real
// array and nothing downstream re-parses.
//
// `null` means unrestricted — the same sentinel `fieldAccessRoles` uses, and the
// same one the SQL predicate already implements (`m.audience IS NULL`). See
// `messageAudienceRoles` for why an unset audience is no longer materialised.
export interface SystemMessage {
  id: number;
  organization_id: number;
  title: string;
  body: string;
  active: boolean;
  audience: string[] | null;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

// Resolve the roles that may be SHOWN a system message.
//
// Deliberately the same shape as `fieldAccessRoles`, because the admin picks the
// audience with the same control the form designer uses for a staff-only field's
// access, and two controls that look identical must not mean subtly different
// things.
//
// ★ Returns `null` for "unrestricted" — every role, including ones that do not
// exist yet. This function used to return `[...ROLES]`, which meant an unset
// audience was frozen at the roles that existed when it was written: a message
// authored today would be invisible to a role created tomorrow, and nothing
// would report it. The comment on the old version already promised the opposite
// ("a role added later is included rather than silently excluded") — `[...ROLES]`
// was the line that broke that promise.
//
// The three states:
//   null  -> unset, i.e. everyone including future roles
//   []    -> the admin granted nobody access (never falls back to all roles)
//   [..]  -> exactly those roles; unknown keys are PRESERVED, not filtered, so a
//            role that is temporarily missing from the catalog does not have its
//            audience rewritten out from under it
//
// Exported because the routes need the resolved list, not just the storage layer.
export function messageAudienceRoles(
  raw: string[] | string | null | undefined
): string[] | null {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // A corrupt blob degrades to "everyone" rather than to "nobody": the failure
    // a reader can act on is a notice they did not expect to see, not a notice
    // that silently exists and is shown to no one.
  }
  return null;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
// Build a human-readable, incremental submission id: `{FORM_CODE}-{SEQUENCE}`,
// e.g. `CDM-1001`. The code is uppercased and sanitized to A-Z/0-9 so it is
// always URL/path-safe; forms without a code fall back to `SUB`. The sequence
// is zero-padded to 5 digits to stay readable across large volumes.
export function formatSubmissionPublicId(code: string | null | undefined, seq: number): string {
  const prefix = (code ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || "SUB";
  return `${prefix}-${String(seq).padStart(5, "0")}`;
}

// Derive the school year a date belongs to. The school year runs Aug 1 -> Jul 31,
// so:
//   - Aug-Dec  -> the year starting THIS year, `YYYY-YYYY+1` (e.g. 9/1/2026 -> 2026-2027)
//   - Jan-Jul  -> the year starting LAST year, `YYYY-1-YYYY` (e.g. 1/15/2027 -> 2026-2027)
// Uses UTC accessors to match the SYSUTCDATETIME() value stored in submitted_at.
// `boundaryMonthIdx` is 0-indexed (Jan=0 ... Dec=11); default 7 = August.
export function schoolYearForDate(date: Date, boundaryMonthIdx = 7): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const start = m >= boundaryMonthIdx ? y : y - 1;
  return `${start}-${start + 1}`;
}
