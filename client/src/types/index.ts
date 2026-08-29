// Shared types mirroring the backend API contract (server/src/db/schema.ts)

export type Role = "admin" | "staff";
export type FormStatus = "draft" | "published" | "archived";
export type SubmissionStatus = "submitted" | "in_review" | "flagged" | "resolved";
export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "date"
  | "select"
  | "checkbox"
  | "radio"
  | "email";

export interface School {
  id: number;
  source_id: number | null;
  name: string;
  grade_level: string | null;
  calendar: string | null;
  district: string | null;
  created_at: string;
}

export interface Organization {
  id: number;
  slug: string;
  name: string;
  created_at: string;
}

// Organizations list row returned by /api/organizations — includes member count.
export interface OrganizationWithMembers extends Organization {
  member_count: number;
}

export interface SchoolPage {
  rows: School[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface User {
  id: number;
  email: string;
  role: Role;
  school_id: number | null;
  school_name: string | null;
  organization_id: number | null;
  organization_slug: string | null;
  display_name: string;
}

// Login modes selectable in Settings → Login Mode (and stored in app_settings).
export type LoginMode = "select" | "password" | "maintenance";

// App setting keys the client can read/write. `documents_link` stores a JSON
// role array; `login_mode` / `maintenance_message` back the Login Mode feature.
export type AppSettingKey = "login_mode" | "maintenance_message" | "documents_link";

// A user row for the select-mode login dropdown (no password hash, no school).
export interface LoginUser {
  id: number;
  display_name: string;
  email: string;
  role: Role;
}

// User row as returned by the admin /api/users endpoints — enriched with the
// school's display name (null for admins with no school) and the active flag.
export interface AdminUser extends User {
  school_name: string | null;
  organization_name: string | null;
  organization_slug: string | null;
  active: boolean;
  created_at: string;
}

export interface FormField {
  id: number;
  form_id: number;
  label: string;
  type: FieldType;
  options: string[] | null;
  required: boolean;
  staff_only: boolean;
  // Roles that may access a staff-only field. null for public fields. Absent or
  // empty on a staff-only field means "all current roles".
  roles: string[] | null;
  sort_order: number;
  placeholder: string | null;
}

export interface Form {
  id: number;
  title: string;
  description: string | null;
  school_id: number | null;
  designer_id: number | null;
  organization_id: number | null;
  status: FormStatus;
  code: string | null;
  submission_seq: number;
  created_at: string;
  updated_at: string;
}

export interface FormWithFields extends Form {
  fields: FormField[];
}

// Parent-facing: a published form with staff-only fields stripped.
export interface PublicForm extends Form {
  fields: FormField[];
}

export interface Submission {
  id: number;
  public_id: string;
  form_id: number;
  school_id: number | null;
  organization_id: number | null;
  status: SubmissionStatus;
  submission_seq: number | null;
  submitted_at: string;
  updated_at: string;
  // Staff-only fields audit trail (null until a staff-only save happens).
  staff_fields_updated_by: number | null;
  staff_fields_updated_at: string | null;
}

export interface SubmissionValue {
  id: number;
  submission_id: number;
  field_id: number;
  value: string | number | boolean | string[] | null;
}

// Value enriched with the field's label/type/staff_only/options (from the detail endpoint).
export interface SubmissionValueRow extends SubmissionValue {
  field_label: string;
  field_type: string;
  staff_only: boolean;
  options: string[] | null;
}

export interface Comment {
  id: number;
  submission_id: number;
  staff_id: number;
  body: string;
  visibility: "internal";
  created_at: string;
  staff_name?: string;
}

export interface SubmissionRow extends Submission {
  form_name: string;
  school_name: string | null;
  student_name: string | null;
}

export interface SubmissionAnswer {
  field_id: number;
  value: string | number | boolean | string[] | null;
}

// A staff-only field added ad-hoc to a specific submission (not part of the fixed form).
export interface AdhocField {
  id: number;
  submission_id: number;
  label: string;
  type: FieldType;
  options: string[] | null;
  value: string | number | boolean | string[] | null;
  sort_order: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export type DocumentStatus = "Pending" | "Completed" | "Failed";

// A generated Google Doc record for a submission.
export interface Document {
  id: number;
  submission_id: number;
  document_id: string | null;
  status: DocumentStatus;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  error: string | null;
}

// Enriched document row returned by /api/documents — joins the submission and
// its school + the label fields used to name/fill the doc.
export interface DocumentRow extends Document {
  public_id: string;
  school_id: number | null;
  school_name: string | null;
  student_name: string | null;
  course_title: string | null;
  phase1_result: string | null;
}

export interface SubmissionDetail extends Submission {
  form_name: string;
  student_name: string | null;
  values: SubmissionValueRow[];
  comments: Comment[];
  adhocFields: AdhocField[];
  // Display name of the staff member who last saved the staff-only fields.
  staff_fields_updated_by_name: string | null;
  // The form's own staff-only field definitions (always shown on the detail page).
  staffOnlyFields: FormField[];
  // The form's non-staff-only field definitions (always shown so unanswered
  // optional fields render + are editable even without a stored value).
  parentFields: FormField[];
  // Generated Google Docs for this submission (idempotent: at most one active).
  documents: DocumentRow[];
}

export interface AuthResponse {
  access_token: string;
  token_type: "bearer";
  user: User;
}

export interface ExportColumn {
  key: string;
  label: string;
  staff_only: boolean;
  roles: string[] | null;
}

export interface ExportPreview {
  columns: ExportColumn[];
  rows: Record<string, unknown>[];
  total: number;
}

// Per-form config returned by GET/PUT /api/forms/:id/columns — which subset of
// columns the admin Submissions grid shows. `viewKeys` defaults to all keys when
// the form has no saved config. Export is separate and always shows all columns.
export interface ViewColumnsConfig {
  columns: ExportColumn[];
  viewKeys: string[];
}
