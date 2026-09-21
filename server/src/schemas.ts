import { z } from "zod";
import { ROLES, FORM_STATUS, SUBMISSION_STATUS, FIELD_TYPES, REPORT_FORMATS } from "./db/schema.js";

// -----------------------------------------------------------------------------
// Auth
// -----------------------------------------------------------------------------
// Public self-registration. Deliberately narrow: the only thing a caller gets to
// choose is their own identity (email/password/name) and their school. The
// organization comes from `DEFAULT_ORG_REGISTRATION` on the server and the role
// is fixed to `staff` by the route, so an anonymous caller can neither pick a
// tenant nor grant themselves `admin` (see POST /api/auth/seed-admin for the
// deliberate, controlled way to create an administrator).
export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(100),
  display_name: z.string().min(1).max(120),
  school_id: z.number().int().positive(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Self-service password change (any authenticated role). The current password is
// required as re-authentication: the bearer token alone must never be enough to
// set a new password, or a borrowed session could permanently seize an account.
// Same 8-char floor as registration. `confirm` is intentionally absent — matching
// the two new-password fields is a client-side concern only.
export const changePasswordSchema = z
  .object({
    current_password: z.string().min(1).max(100),
    new_password: z.string().min(8).max(100),
  })
  .refine((v) => v.current_password !== v.new_password, {
    message: "New password must be different from the current password",
    path: ["new_password"],
  });

// Select-mode login (test/demo): pick a user by id, optionally constrained to an
// org, with no password. Used by the "Select User (Test)" login form.
export const selectLoginSchema = z.object({
  userId: z.number().int().positive(),
  organizationId: z.number().int().positive().optional().nullable(),
});

// Query params for the select-mode user dropdown.
export const selectUsersQuerySchema = z.object({
  org: z.string().min(1).max(60).optional(),
});

export const refreshSchema = z.object({
  refresh_token: z.string().optional(),
});

// -----------------------------------------------------------------------------
// Users (admin Settings → Users panel)
// -----------------------------------------------------------------------------
export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(100),
  display_name: z.string().min(1).max(120),
  role: z.enum(ROLES).default("staff"),
  school_id: z.number().int().positive().optional().nullable(),
  organization_id: z.number().int().positive().optional().nullable(),
  // Whether the account is offered in the select-mode ("Test") login dropdown.
  // Optional and OFF by default — a new account is never test-visible unless the
  // caller asks for it (see `listUsersForSelect`).
  show_on_test_screen: z.boolean().optional(),
});

export const updateUserSchema = z
  .object({
    display_name: z.string().min(1).max(120).optional(),
    email: z.string().email().optional(),
    active: z.boolean().optional(),
    role: z.enum(ROLES).optional(),
    school_id: z.number().int().positive().optional().nullable(),
    organization_id: z.number().int().positive().optional().nullable(),
    show_on_test_screen: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required" });

// -----------------------------------------------------------------------------
// Schools
// -----------------------------------------------------------------------------
export const createSchoolSchema = z.object({
  name: z.string().min(1).max(200),
  district: z.string().max(200).optional().nullable(),
});

// -----------------------------------------------------------------------------
// Organizations (admin add/edit)
// -----------------------------------------------------------------------------
export const createOrganizationSchema = z.object({
  name: z.string().min(1).max(120),
  // Slug is auto-derived from the name when absent; otherwise must be a valid
  // slug (lowercase alphanumerics + hyphens). Uniqueness enforced at the route.
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: "Slug must be lowercase letters, numbers, and hyphens" })
    .optional(),
  description: z.string().max(2000).nullable().optional(),
  // Per-org Google Drive parent folder for generated documents. Blank clears the
  // override (falls back to the global env folder). Optional.
  doc_folder_id: z.string().max(255).nullable().optional(),
  active: z.boolean().default(true),
});

export const updateOrganizationSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    slug: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: "Slug must be lowercase letters, numbers, and hyphens" })
      .optional(),
    description: z.string().max(2000).nullable().optional(),
    doc_folder_id: z.string().max(255).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required" });

// -----------------------------------------------------------------------------
// Forms
// -----------------------------------------------------------------------------
const fieldTypeEnum = z.enum(FIELD_TYPES);

export const fieldSchema = z.object({
  id: z.number().int().positive().optional(),
  label: z.string().min(1).max(200),
  type: fieldTypeEnum,
  options: z.array(z.string().min(1).max(200)).optional().nullable(),
  required: z.boolean().default(false),
  staff_only: z.boolean().default(false),
  sort_order: z.number().int().min(0).default(0),
  placeholder: z.string().max(200).optional().nullable(),
  // Roles that may access an internal (staff_only) field. Absent for
  // parent-facing fields. Stored as-is; the server resolves defaults.
  roles: z.array(z.enum(ROLES)).optional().nullable(),
});

export const createFormSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional().nullable(),
  school_id: z.number().int().positive().optional().nullable(),
  doc_folder_id: z.string().max(255).optional().nullable(),
  google_form_url: z.string().max(1000).optional().nullable(),
  generate_form_fields: z.boolean().optional(),
  // Optional on create. The New Form modal collects a title and an optional
  // school and nothing else — the admin lands in the designer and adds fields
  // there ("Create & Design"). Requiring a field here made that flow
  // impossible: every attempt died on "Validation failed" before a form row was
  // ever inserted. `updateFormSchema.fields` is already optional, so this only
  // brings creation in line with how forms are actually authored.
  fields: z.array(fieldSchema).default([]),
});

export const updateFormSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().optional().nullable(),
  status: z.enum(FORM_STATUS).optional(),
  doc_folder_id: z.string().max(255).optional().nullable(),
  google_form_url: z.string().max(1000).optional().nullable(),
  generate_form_fields: z.boolean().optional(),
  fields: z.array(fieldSchema).optional(),
});

// -----------------------------------------------------------------------------
// Submissions (Parent answers — fully anonymous)
// -----------------------------------------------------------------------------
const answerValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).nullable();

// `field_id` / `form_id` here are TRANSMITTED ids, not server-minted ones. JSON
// has no integer type, and callers legitimately hold these ids as text: the
// Google Apps Script reads `field.id` back from `GET /forms/:id/public` and
// posts it verbatim, and anything that round-trips an id through a spreadsheet
// cell or `String()` hands it back as a string. `z.number()` rejected those with
// "Expected number, received string" — an API refusing the very ids it serves.
// `z.coerce` is the correct contract for a transmitted id, and it matches how
// exportQuerySchema / reportQuerySchema already read their ids below.
export const submissionAnswerSchema = z.object({
  field_id: z.coerce.number().int().positive(),
  value: answerValue,
});

export const createSubmissionSchema = z.object({
  form_id: z.coerce.number().int().positive(),
  answers: z.array(submissionAnswerSchema).min(1),
});

export const updateSubmissionStatusSchema = z.object({
  status: z.enum(SUBMISSION_STATUS),
});

// Editing a submission's answers (staff/admin correcting parent input).
// `staff_only` marks an explicit save of the staff-only fields, which records
// the auditor (who + when) on the submission.
export const updateSubmissionValuesSchema = z.object({
  answers: z.array(submissionAnswerSchema).min(1),
  staff_only: z.boolean().optional(),
});

// -----------------------------------------------------------------------------
// Submission ad-hoc staff-only fields (staff/extended on a specific submission)
// -----------------------------------------------------------------------------
export const createAdhocFieldSchema = z.object({
  label: z.string().min(1).max(200),
  type: fieldTypeEnum,
  options: z.array(z.string().min(1).max(200)).optional().nullable(),
  value: answerValue,
});

export const updateAdhocFieldSchema = z.object({
  label: z.string().min(1).max(200),
  type: fieldTypeEnum,
  options: z.array(z.string().min(1).max(200)).optional().nullable(),
  value: answerValue,
});

// -----------------------------------------------------------------------------
// Export / query filters
// -----------------------------------------------------------------------------
export const exportQuerySchema = z.object({
  form_id: z.coerce.number().int().positive().optional(),
  school_id: z.coerce.number().int().positive().optional(),
  status: z.enum(SUBMISSION_STATUS).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateFormInput = z.infer<typeof createFormSchema>;
export type CreateSubmissionInput = z.infer<typeof createSubmissionSchema>;

// -----------------------------------------------------------------------------
// Reports
// -----------------------------------------------------------------------------

// The query contract shared by the preview grid and every export format. Both
// endpoints parse the same shape so "what you see is what you export" holds.
export const reportQuerySchema = z.object({
  form_id: z.coerce.number().int().positive({ message: "form_id is required" }),
  school_id: z.coerce.number().int().positive().optional(),
  status: z.enum(SUBMISSION_STATUS).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  // Free-text row filter. Capped so a pathological term can't blow up the LIKE.
  q: z.string().max(200).optional(),
  // Comma-separated `field_N` keys. Unknown/unauthorized keys are dropped at the
  // route, so an admin can't hand-craft a request to leak a staff-only column.
  columns: z.string().max(4000).optional(),
  // Only honored for admins; staff can never opt into staff-only columns.
  include_staff_only: z
    .union([z.literal("1"), z.literal("0"), z.literal("true"), z.literal("false")])
    .optional(),
});

export type ReportQueryInput = z.infer<typeof reportQuerySchema>;

// The filter subset that a Saved View persists (everything except the form).
export const reportFiltersSchema = z.object({
  school_id: z.number().int().positive().nullable().optional(),
  status: z.enum(SUBMISSION_STATUS).nullable().optional(),
  from: z.string().max(40).nullable().optional(),
  to: z.string().max(40).nullable().optional(),
  q: z.string().max(200).nullable().optional(),
  include_staff_only: z.boolean().optional(),
});

const reportColumnKey = z.string().regex(/^field_\d+$/, { message: "Invalid column key" });

export const createReportViewSchema = z.object({
  name: z.string().min(1).max(120),
  form_id: z.number().int().positive(),
  filters: reportFiltersSchema.default({}),
  // null / omitted means "all columns currently visible to me".
  columns: z.array(reportColumnKey).nullable().optional(),
  format: z.enum(REPORT_FORMATS).default("csv"),
  is_default: z.boolean().default(false),
});

export const updateReportViewSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    form_id: z.number().int().positive().optional(),
    filters: reportFiltersSchema.optional(),
    columns: z.array(reportColumnKey).nullable().optional(),
    format: z.enum(REPORT_FORMATS).optional(),
    is_default: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required" });
