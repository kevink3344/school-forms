// -----------------------------------------------------------------------------
// Enum values (kept in TS; validated at the app layer)
// -----------------------------------------------------------------------------
export const ROLES = ["admin", "staff"] as const;
export const FORM_STATUS = ["draft", "published", "archived"] as const;
export const SUBMISSION_STATUS = [
  "submitted",
  "in_review",
  "flagged",
  "resolved",
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
export const COMMENT_VISIBILITY = ["internal"] as const;

export type Role = (typeof ROLES)[number];
export type FormStatus = (typeof FORM_STATUS)[number];
export type SubmissionStatus = (typeof SUBMISSION_STATUS)[number];
export type FieldType = (typeof FIELD_TYPES)[number];
export type CommentVisibility = (typeof COMMENT_VISIBILITY)[number];

// -----------------------------------------------------------------------------
// Typed row shapes (mirror the SQL Server tables below)
// -----------------------------------------------------------------------------
export interface Organization {
  id: number;
  slug: string;
  name: string;
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
  view_columns: string | null;
  // Short, human-readable, globally-unique code used as the prefix of submission
  // ids (e.g. `CDM`). Nullable — forms without a code fall back to `SUB`.
  code: string | null;
  // Per-form, monotonic counter used to allocate incremental submission ids
  // (`CDM-1001`, `CDM-1002`, ...). Incremented under a row lock in `createSubmission`.
  submission_seq: number;
  created_at: Date;
  updated_at: Date;
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

// Resolve the roles that may access an internal (staff_only) field. For backward
// compatibility, a staff_only field with NULL/empty roles is treated as visible to
// every current role (admin + staff). Parent-facing fields (staff_only=0) always
// return null to signal "public".
export function fieldAccessRoles(field: Pick<FormField, "staff_only" | "roles">): string[] | null {
  if (!field.staff_only) return null;
  const roles = field.roles?.filter(Boolean);
  if (!roles || roles.length === 0) return [...ROLES];
  return roles;
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

export interface Comment {
  id: number;
  submission_id: number;
  staff_id: number;
  body: string;
  visibility: CommentVisibility;
  created_at: Date;
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
// SQL Server DDL — executed once at startup (idempotent CREATE IF NOT EXISTS)
// -----------------------------------------------------------------------------
export const DDL_STATEMENTS: string[] = [
  `IF OBJECT_ID('dbo.schools', 'U') IS NULL
   CREATE TABLE dbo.schools (
     id          INT IDENTITY(1,1) PRIMARY KEY,
     name        NVARCHAR(200) NOT NULL,
     district    NVARCHAR(200) NULL,
     created_at  DATETIME2 NOT NULL CONSTRAINT DF_schools_created_at DEFAULT SYSUTCDATETIME()
   );
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_schools_name')
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
     id         INT IDENTITY(1,1) PRIMARY KEY,
     slug       NVARCHAR(60)  NOT NULL,
     name       NVARCHAR(120) NOT NULL,
     active     BIT NOT NULL CONSTRAINT DF_organizations_active DEFAULT 1,
     created_at DATETIME2 NOT NULL CONSTRAINT DF_organizations_created_at DEFAULT SYSUTCDATETIME()
   );
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_organizations_slug')
     CREATE UNIQUE INDEX UX_organizations_slug ON dbo.organizations(slug);
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_organizations_name')
     CREATE UNIQUE INDEX UX_organizations_name ON dbo.organizations(name);
   IF COL_LENGTH('dbo.organizations', 'active') IS NULL
     ALTER TABLE dbo.organizations ADD active BIT NOT NULL
       CONSTRAINT DF_organizations_active DEFAULT 1;`,

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
     role          NVARCHAR(20) NOT NULL CHECK (role IN ('admin','staff')),
     school_id     INT NULL,
     display_name  NVARCHAR(120) NOT NULL,
     active        BIT NOT NULL CONSTRAINT DF_users_active DEFAULT 1,
     created_at    DATETIME2 NOT NULL CONSTRAINT DF_users_created_at DEFAULT SYSUTCDATETIME(),
     CONSTRAINT FK_users_school FOREIGN KEY (school_id) REFERENCES dbo.schools(id) ON DELETE SET NULL
   );
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_users_email')
     CREATE UNIQUE INDEX UX_users_email ON dbo.users(email);
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_users_school')
     CREATE INDEX IX_users_school ON dbo.users(school_id);`,

  // Idempotent migration for the admin Settings → Users feature — adds the
  // active flag to an ALREADY-EXISTING dbo.users table (safe to re-run).
  `IF COL_LENGTH('dbo.users', 'active') IS NULL
     ALTER TABLE dbo.users ADD active BIT NOT NULL CONSTRAINT DF_users_active DEFAULT 1;`,

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
     ALTER TABLE dbo.users ALTER COLUMN organization_id INT NOT NULL;`,

  `IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name='FK_users_organization')
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
     created_at  DATETIME2 NOT NULL CONSTRAINT DF_forms_created_at DEFAULT SYSUTCDATETIME(),
     updated_at  DATETIME2 NOT NULL CONSTRAINT DF_forms_updated_at DEFAULT SYSUTCDATETIME(),
     CONSTRAINT FK_forms_school FOREIGN KEY (school_id) REFERENCES dbo.schools(id) ON DELETE CASCADE,
     CONSTRAINT FK_forms_designer FOREIGN KEY (designer_id) REFERENCES dbo.users(id) ON DELETE SET NULL
   );
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_forms_school')
     CREATE INDEX IX_forms_school ON dbo.forms(school_id);
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_forms_status')
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
     ALTER TABLE dbo.forms ALTER COLUMN organization_id INT NOT NULL;`,

  `IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name='FK_forms_organization')
     ALTER TABLE dbo.forms ADD CONSTRAINT FK_forms_organization
       FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION;
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_forms_organization')
     CREATE INDEX IX_forms_organization ON dbo.forms(organization_id);`,

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

  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_forms_code')
     CREATE UNIQUE INDEX UX_forms_code ON dbo.forms(code) WHERE code IS NOT NULL;`,

  // Per-form monotonic counter used to allocate incremental submission ids.
  `IF COL_LENGTH('dbo.forms', 'submission_seq') IS NULL
     ALTER TABLE dbo.forms ADD submission_seq INT NOT NULL
       CONSTRAINT DF_forms_submission_seq DEFAULT 0;`,

  // ---------------------------------------------------------------------
  // Incremental Submission IDs — submissions.submission_seq. Stored so the
  // numeric portion is queryable without parsing public_id. Nullable: it is
  // only populated by the new-format insert and the one-time backfill, so
  // legacy hex rows retain NULL here until backfilled.
  // ---------------------------------------------------------------------
  `IF COL_LENGTH('dbo.submissions', 'submission_seq') IS NULL
     ALTER TABLE dbo.submissions ADD submission_seq INT NULL;`,

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
                  CHECK (status IN ('submitted','in_review','flagged','resolved')),
     submitted_at DATETIME2 NOT NULL CONSTRAINT DF_submissions_submitted_at DEFAULT SYSUTCDATETIME(),
     updated_at   DATETIME2 NOT NULL CONSTRAINT DF_submissions_updated_at DEFAULT SYSUTCDATETIME(),
     CONSTRAINT FK_submissions_form FOREIGN KEY (form_id) REFERENCES dbo.forms(id) ON DELETE CASCADE,
     CONSTRAINT FK_submissions_school FOREIGN KEY (school_id) REFERENCES dbo.schools(id) ON DELETE NO ACTION
   );
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_submissions_public_id')
     CREATE UNIQUE INDEX UX_submissions_public_id ON dbo.submissions(public_id);
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_submissions_school_form')
     CREATE INDEX IX_submissions_school_form ON dbo.submissions(school_id, form_id);
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_submissions_submitted_at')
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
     ALTER TABLE dbo.submissions ALTER COLUMN organization_id INT NOT NULL;`,

  `IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name='FK_submissions_organization')
     ALTER TABLE dbo.submissions ADD CONSTRAINT FK_submissions_organization
       FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION;
   IF EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_submissions_school_form')
     DROP INDEX IX_submissions_school_form ON dbo.submissions;
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

  `IF OBJECT_ID('dbo.comments', 'U') IS NULL
   CREATE TABLE dbo.comments (
     id            INT IDENTITY(1,1) PRIMARY KEY,
     submission_id INT NOT NULL,
     staff_id      INT NOT NULL,
     body          NVARCHAR(MAX) NOT NULL,
     visibility    NVARCHAR(20) NOT NULL CONSTRAINT DF_comments_visibility DEFAULT 'internal'
                   CHECK (visibility IN ('internal')),
     created_at    DATETIME2 NOT NULL CONSTRAINT DF_comments_created_at DEFAULT SYSUTCDATETIME(),
     CONSTRAINT FK_comments_submission FOREIGN KEY (submission_id) REFERENCES dbo.submissions(id) ON DELETE CASCADE,
     CONSTRAINT FK_comments_staff FOREIGN KEY (staff_id) REFERENCES dbo.users(id) ON DELETE CASCADE
   );
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_comments_submission')
     CREATE INDEX IX_comments_submission ON dbo.comments(submission_id);`,

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
];

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
