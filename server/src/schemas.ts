import { z } from "zod";
import { ROLES, FORM_STATUS, SUBMISSION_STATUS, FIELD_TYPES } from "./db/schema.js";

// -----------------------------------------------------------------------------
// Auth
// -----------------------------------------------------------------------------
export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(100),
  display_name: z.string().min(1).max(120),
  school_id: z.number().int().positive(),
  role: z.enum(ROLES).default("staff"),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
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
});

export const updateUserSchema = z
  .object({
    display_name: z.string().min(1).max(120).optional(),
    email: z.string().email().optional(),
    active: z.boolean().optional(),
    role: z.enum(ROLES).optional(),
    school_id: z.number().int().positive().optional().nullable(),
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
});

export const createFormSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional().nullable(),
  school_id: z.number().int().positive().optional().nullable(),
  fields: z.array(fieldSchema).min(1),
});

export const updateFormSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().optional().nullable(),
  status: z.enum(FORM_STATUS).optional(),
  fields: z.array(fieldSchema).optional(),
});

// -----------------------------------------------------------------------------
// Submissions (Parent answers — fully anonymous)
// -----------------------------------------------------------------------------
const answerValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).nullable();

export const submissionAnswerSchema = z.object({
  field_id: z.number().int().positive(),
  value: answerValue,
});

export const createSubmissionSchema = z.object({
  form_id: z.number().int().positive(),
  answers: z.array(submissionAnswerSchema).min(1),
});

export const updateSubmissionStatusSchema = z.object({
  status: z.enum(SUBMISSION_STATUS),
});

// Editing a submission's answers (staff/admin correcting parent input).
export const updateSubmissionValuesSchema = z.object({
  answers: z.array(submissionAnswerSchema).min(1),
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
// Comments (Staff-only)
// -----------------------------------------------------------------------------
export const createCommentSchema = z.object({
  body: z.string().min(1).max(5000),
  visibility: z.enum(["internal"]).default("internal"),
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
export type CreateCommentInput = z.infer<typeof createCommentSchema>;
