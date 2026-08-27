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
  display_name: string;
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

export interface Form {
  id: number;
  title: string;
  description: string | null;
  school_id: number | null;
  designer_id: number | null;
  status: FormStatus;
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
  status: SubmissionStatus;
  submitted_at: string;
  updated_at: string;
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

export interface SubmissionDetail extends Submission {
  form_name: string;
  student_name: string | null;
  values: SubmissionValueRow[];
  comments: Comment[];
  adhocFields: AdhocField[];
  // The form's own staff-only field definitions (always shown on the detail page).
  staffOnlyFields: FormField[];
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
}

export interface ExportPreview {
  columns: ExportColumn[];
  rows: Record<string, unknown>[];
  total: number;
}
