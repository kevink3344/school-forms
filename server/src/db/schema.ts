// -----------------------------------------------------------------------------
// Enum values (kept in TS; validated at the app layer)
// -----------------------------------------------------------------------------
export const ROLES = ["admin", "staff", "cdm_contact"] as const;
export const FORM_STATUS = ["draft", "published", "archived"] as const;
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
] as const;

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
  role: Role;
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
  // When NULL/empty on a staff_only field, it defaults to all current roles
  // (admin + staff) so existing rows behave as they did before. Future roles are
  // expressed by simply adding them to this array — no schema change needed.
  roles: string[] | null;
}

// Resolve the roles that may access an internal (staff_only) field.
//
// NULL/undefined roles means "unset" and defaults to every current role, which
// keeps legacy rows (created before per-field access existed) behaving as they
// always did. An explicitly EMPTY array means the admin deliberately granted no
// role access, so it must resolve to [] — NOT back to all roles. Conflating the
// two is what made removing the last role in the designer snap every access
// button back on. Parent-facing fields (staff_only=0) always return null.
export function fieldAccessRoles(field: Pick<FormField, "staff_only" | "roles">): string[] | null {
  if (!field.staff_only) return null;
  if (field.roles === null || field.roles === undefined) return [...ROLES];
  return field.roles.filter(Boolean);
}

// Decide whether a given viewer can see a field. `viewer` is a role string, or
// "parent" for anonymous submissions. Admins are superusers and see every field.
// Staff see internal fields only when "staff" is in the field's access roles.
// Parents never see any internal (staff_only) field.
export function canSeeField(
  field: Pick<FormField, "staff_only" | "roles">,
  viewer: Role | "parent"
): boolean {
  if (viewer === "admin") return true;
  if (!field.staff_only) return true;
  if (viewer === "parent") return false;
  return (fieldAccessRoles(field) ?? []).includes(viewer);
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
   );
   ${indexGuard("UX_schools_name", "schools", ["name"])}
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
  // before execution, so the columns must already exist when this runs.
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_schools_source_id')
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

  `IF OBJECT_ID('dbo.users', 'U') IS NULL
   CREATE TABLE dbo.users (
     id            INT IDENTITY(1,1) PRIMARY KEY,
     email         NVARCHAR(320) NOT NULL,
     password_hash NVARCHAR(255) NOT NULL,
     role          NVARCHAR(20) NOT NULL CHECK (role IN ('admin','staff','cdm_contact')),
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
     type        NVARCHAR(20) NOT NULL CHECK (type IN ('text','textarea','number','date','select','checkbox','radio','email')),
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
     type          NVARCHAR(20) NOT NULL CHECK (type IN ('text','textarea','number','date','select','checkbox','radio','email')),
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
