import { randomBytes } from "node:crypto";

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
export interface School {
  id: number;
  name: string;
  district: string | null;
  created_at: Date;
}

export interface User {
  id: number;
  email: string;
  password_hash: string;
  role: Role;
  school_id: number | null;
  display_name: string;
  created_at: Date;
}

export interface Form {
  id: number;
  title: string;
  description: string | null;
  school_id: number | null;
  designer_id: number | null;
  status: FormStatus;
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
}

export interface Submission {
  id: number;
  public_id: string;
  form_id: number;
  school_id: number | null;
  status: SubmissionStatus;
  submitted_at: Date;
  updated_at: Date;
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

  `IF OBJECT_ID('dbo.users', 'U') IS NULL
   CREATE TABLE dbo.users (
     id            INT IDENTITY(1,1) PRIMARY KEY,
     email         NVARCHAR(320) NOT NULL,
     password_hash NVARCHAR(255) NOT NULL,
     role          NVARCHAR(20) NOT NULL CHECK (role IN ('admin','staff')),
     school_id     INT NULL,
     display_name  NVARCHAR(120) NOT NULL,
     created_at    DATETIME2 NOT NULL CONSTRAINT DF_users_created_at DEFAULT SYSUTCDATETIME(),
     CONSTRAINT FK_users_school FOREIGN KEY (school_id) REFERENCES dbo.schools(id) ON DELETE SET NULL
   );
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_users_email')
     CREATE UNIQUE INDEX UX_users_email ON dbo.users(email);
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_users_school')
     CREATE INDEX IX_users_school ON dbo.users(school_id);`,

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
];

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
export function newPublicId(): string {
  return randomBytes(16).toString("hex");
}
