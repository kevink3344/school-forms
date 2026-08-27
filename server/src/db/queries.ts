import { getPool } from "./pool.js";
import type {
  School,
  User,
  Form,
  FormField,
  Submission,
  SubmissionValue,
  Comment,
  AdhocField,
  Role,
} from "./schema.js";

// -----------------------------------------------------------------------------
// Generic query helper
// -----------------------------------------------------------------------------
export async function execute<T = unknown>(
  query: string,
  params: Record<string, unknown> = {}
): Promise<T[]> {
  const pool = await getPool();
  const request = pool.request();
  for (const [name, value] of Object.entries(params)) {
    request.input(name, value as never);
  }
  const result = await request.query(query);
  return (result.recordset ?? []) as T[];
}

// -----------------------------------------------------------------------------
// Schools
// -----------------------------------------------------------------------------
export async function listSchools(): Promise<School[]> {
  return execute<School>(
    "SELECT id, name, district, created_at FROM dbo.schools ORDER BY name"
  );
}

export async function getSchool(id: number): Promise<School | null> {
  const rows = await execute<School>(
    "SELECT id, name, district, created_at FROM dbo.schools WHERE id = @id",
    { id }
  );
  return rows[0] ?? null;
}

export async function createSchool(name: string, district: string | null): Promise<School> {
  const rows = await execute<School>(
    `INSERT INTO dbo.schools (name, district)
     OUTPUT INSERTED.id, INSERTED.name, INSERTED.district, INSERTED.created_at
     VALUES (@name, @district)`,
    { name, district }
  );
  return rows[0];
}

// -----------------------------------------------------------------------------
// Users
// -----------------------------------------------------------------------------
export async function getUserByEmail(email: string): Promise<User | null> {
  const rows = await execute<User>(
    `SELECT id, email, password_hash, role, school_id, display_name, created_at
     FROM dbo.users WHERE email = @email`,
    { email }
  );
  return rows[0] ?? null;
}

export async function getUserById(id: number): Promise<User | null> {
  const rows = await execute<User>(
    `SELECT id, email, password_hash, role, school_id, display_name, created_at
     FROM dbo.users WHERE id = @id`,
    { id }
  );
  return rows[0] ?? null;
}

export async function createUser(
  email: string,
  passwordHash: string,
  role: Role,
  schoolId: number | null,
  displayName: string
): Promise<User> {
  const rows = await execute<User>(
    `INSERT INTO dbo.users (email, password_hash, role, school_id, display_name)
     OUTPUT INSERTED.id, INSERTED.email, INSERTED.password_hash, INSERTED.role,
            INSERTED.school_id, INSERTED.display_name, INSERTED.created_at
     VALUES (@email, @passwordHash, @role, @schoolId, @displayName)`,
    { email, passwordHash, role, schoolId, displayName }
  );
  return rows[0];
}

// -----------------------------------------------------------------------------
// Forms
// -----------------------------------------------------------------------------
export interface FormWithFields extends Form {
  fields: FormField[];
}

export async function listForms(schoolId?: number | null): Promise<Form[]> {
  const params: Record<string, unknown> = {};
  let where = "1=1";
  if (schoolId !== undefined && schoolId !== null) {
    where = "f.school_id = @schoolId";
    params.schoolId = schoolId;
  }
  return execute<Form>(
    `SELECT f.id, f.title, f.description, f.school_id, f.designer_id, f.status,
            f.created_at, f.updated_at
     FROM dbo.forms f WHERE ${where} ORDER BY f.updated_at DESC`,
    params
  );
}

export async function getForm(id: number): Promise<Form | null> {
  const rows = await execute<Form>(
    `SELECT id, title, description, school_id, designer_id, status, created_at, updated_at
     FROM dbo.forms WHERE id = @id`,
    { id }
  );
  return rows[0] ?? null;
}

export async function listFormFields(formId: number): Promise<FormField[]> {
  const rows = await execute<FormField>(
    `SELECT id, form_id, label, type, options, required, staff_only, sort_order, placeholder
     FROM dbo.form_fields WHERE form_id = @formId ORDER BY sort_order`,
    { formId }
  );
  // `options` is stored as a JSON string (NVARCHAR) but the API contract exposes
  // an array. Parse it back so every consumer (admin designer, parent submit,
  // public form) receives `string[] | null` and can safely call .join()/.map().
  return rows.map((f) => ({
    ...f,
    options: parseFormFieldOptions(f.options),
  }));
}

// Parse the stored JSON-string options into an array. Accepts a JSON string or
// an already-array value (the runtime DB returns a string, but the FormField type
// declares an array). Returns null for empty, invalid, or non-array payloads so
// callers never crash on a malformed value.
function parseFormFieldOptions(raw: string[] | string | null | undefined): string[] | null {
  if (raw == null) return null;
  // Already an array (defensive against callers that pass a typed-array value).
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

export async function getFormWithFields(id: number): Promise<FormWithFields | null> {
  const form = await getForm(id);
  if (!form) return null;
  const fields = await listFormFields(id);
  return { ...form, fields };
}

export async function createForm(
  {
    title,
    description,
    schoolId,
    designerId,
  }: {
    title: string;
    description: string | null;
    schoolId: number | null;
    designerId: number | null;
  },
  fields: {
    label: string;
    type: string;
    options?: string[] | null;
    required?: boolean;
    staff_only?: boolean;
    sort_order?: number;
    placeholder?: string | null;
  }[]
): Promise<FormWithFields> {
  // Insert form
  const forms = await execute<Form>(
    `INSERT INTO dbo.forms (title, description, school_id, designer_id, status)
     OUTPUT INSERTED.id, INSERTED.title, INSERTED.description, INSERTED.school_id,
            INSERTED.designer_id, INSERTED.status, INSERTED.created_at, INSERTED.updated_at
     VALUES (@title, @description, @schoolId, @designerId, 'draft')`,
    { title, description, schoolId: schoolId ?? null, designerId: designerId ?? null }
  );
  const form = forms[0];
  for (const f of fields) {
    await execute(
      `INSERT INTO dbo.form_fields (form_id, label, type, options, required, staff_only, sort_order, placeholder)
       VALUES (@formId, @label, @type, @options, @required, @staffOnly, @sortOrder, @placeholder)`,
      {
        formId: form.id,
        label: f.label,
        type: f.type,
        options: f.options ? JSON.stringify(f.options) : null,
        required: f.required ?? false,
        staffOnly: f.staff_only ?? false,
        sortOrder: f.sort_order ?? 0,
        placeholder: f.placeholder ?? null,
      }
    );
  }
  return getFormWithFields(form.id) as Promise<FormWithFields>;
}

export async function updateForm(
  formId: number,
  data: {
    title?: string;
    description?: string | null;
    status?: string;
    fields?: {
      id?: number;
      label: string;
      type: string;
      options?: string[] | null;
      required?: boolean;
      staff_only?: boolean;
      sort_order?: number;
      placeholder?: string | null;
    }[];
  }
): Promise<FormWithFields | null> {
  const existing = await getForm(formId);
  if (!existing) return null;

  const title = data.title ?? existing.title;
  const description = data.description === undefined ? existing.description : data.description;
  const status = data.status ?? existing.status;

  await execute(
    `UPDATE dbo.forms SET title=@title, description=@description, status=@status, updated_at=SYSUTCDATETIME() WHERE id=@id`,
    { id: formId, title, description, status }
  );

  if (data.fields) {
    await reconcileFormFields(formId, data.fields);
  }

  return getFormWithFields(formId);
}

// Replace the form's fields in place. Existing fields (matched by id) are updated,
// new fields (no id / id=0) are inserted, and removed fields are deleted — but only
// if they have no submission values, since submission_values.field_id has an
// ON DELETE NO ACTION foreign key. This keeps edits to draft forms safe while not
// crashing on forms that already collected responses.
async function reconcileFormFields(
  formId: number,
  fields: {
    id?: number;
    label: string;
    type: string;
    options?: string[] | null;
    required?: boolean;
    staff_only?: boolean;
    sort_order?: number;
    placeholder?: string | null;
  }[]
): Promise<void> {
  const existingRows = await execute<FormField>(
    `SELECT id FROM dbo.form_fields WHERE form_id = @formId`,
    { formId }
  );
  const existingIds = new Set(existingRows.map((r) => r.id));
  const incomingIds = new Set<number>();

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const sortOrder = f.sort_order ?? i;
    const options = f.options && f.options.length ? JSON.stringify(f.options) : null;
    if (f.id && existingIds.has(f.id)) {
      incomingIds.add(f.id);
      await execute(
        `UPDATE dbo.form_fields
         SET label=@label, type=@type, options=@options, required=@required,
             staff_only=@staffOnly, sort_order=@sortOrder, placeholder=@placeholder
         WHERE id=@id AND form_id=@formId`,
        {
          id: f.id,
          label: f.label,
          type: f.type,
          options,
          required: f.required ?? false,
          staffOnly: f.staff_only ?? false,
          sortOrder,
          placeholder: f.placeholder ?? null,
        }
      );
    } else {
      await execute(
        `INSERT INTO dbo.form_fields (form_id, label, type, options, required, staff_only, sort_order, placeholder)
         VALUES (@formId, @label, @type, @options, @required, @staffOnly, @sortOrder, @placeholder)`,
        {
          formId,
          label: f.label,
          type: f.type,
          options,
          required: f.required ?? false,
          staffOnly: f.staff_only ?? false,
          sortOrder,
          placeholder: f.placeholder ?? null,
        }
      );
    }
  }

  // Delete removed fields only when they have no submission values (FK NO ACTION).
  for (const id of existingIds) {
    if (!incomingIds.has(id)) {
      await execute(
        `DELETE FROM dbo.form_fields
         WHERE id=@id AND form_id=@formId
           AND NOT EXISTS (SELECT 1 FROM dbo.submission_values sv WHERE sv.field_id = dbo.form_fields.id)`,
        { id }
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Submissions
// -----------------------------------------------------------------------------
export interface SubmissionRow extends Submission {
  form_name: string;
  // The first non-staff-only field value (conventionally the Student Name), used
  // to render a clickable name in the staff queue. Falls back to a placeholder.
  student_name: string | null;
}

export interface SubmissionValueRow extends SubmissionValue {
  field_label: string;
  field_type: string;
  staff_only: boolean;
  options: string[] | null;
}

export interface CommentRow extends Comment {
  staff_name: string;
}

export interface SubmissionDetail extends SubmissionRow {
  values: SubmissionValueRow[];
  comments: CommentRow[];
  // Staff-only fields added ad-hoc to this submission (not part of the fixed form).
  adhocFields: AdhocFieldRow[];
}

export async function listSubmissions(params: {
  schoolId?: number | null;
  formId?: number | null;
  status?: string | null;
  from?: string | null;
  to?: string | null;
}): Promise<SubmissionRow[]> {
  const p: Record<string, unknown> = {};
  const clauses: string[] = [];
  if (params.schoolId !== undefined && params.schoolId !== null) {
    clauses.push("s.school_id = @schoolId");
    p.schoolId = params.schoolId;
  }
  if (params.formId !== undefined && params.formId !== null) {
    clauses.push("s.form_id = @formId");
    p.formId = params.formId;
  }
  if (params.status) {
    clauses.push("s.status = @status");
    p.status = params.status;
  }
  if (params.from) {
    clauses.push("s.submitted_at >= @from");
    p.from = params.from;
  }
  if (params.to) {
    clauses.push("s.submitted_at <= @to");
    p.to = params.to;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return execute<SubmissionRow>(
    `SELECT s.id, s.public_id, s.form_id, s.school_id, s.status, s.submitted_at, s.updated_at,
            f.title AS form_name,
            (SELECT TOP 1 sv.value
             FROM dbo.submission_values sv
             JOIN dbo.form_fields ff ON ff.id = sv.field_id
             WHERE sv.submission_id = s.id AND ff.staff_only = 0 AND sv.value IS NOT NULL
             ORDER BY ff.sort_order) AS student_name
     FROM dbo.submissions s
     JOIN dbo.forms f ON f.id = s.form_id
     ${where}
     ORDER BY s.submitted_at DESC`,
    p
  );
}

export async function getSubmissionByPublicId(publicId: string): Promise<SubmissionRow | null> {
  const rows = await execute<SubmissionRow>(
    `SELECT s.id, s.public_id, s.form_id, s.school_id, s.status, s.submitted_at, s.updated_at,
            f.title AS form_name,
            (SELECT TOP 1 sv.value
             FROM dbo.submission_values sv
             JOIN dbo.form_fields ff ON ff.id = sv.field_id
             WHERE sv.submission_id = s.id AND ff.staff_only = 0 AND sv.value IS NOT NULL
             ORDER BY ff.sort_order) AS student_name
     FROM dbo.submissions s
     JOIN dbo.forms f ON f.id = s.form_id
     WHERE s.public_id = @publicId`,
    { publicId }
  );
  return rows[0] ?? null;
}

export async function listSubmissionValues(submissionId: number): Promise<SubmissionValueRow[]> {
  interface RawValueRow extends Omit<SubmissionValueRow, "options"> {
    rawOptions: string | null;
  }
  const rows = await execute<RawValueRow>(
    `SELECT sv.id, sv.submission_id, sv.field_id, sv.value,
            ff.label AS field_label, ff.type AS field_type, ff.staff_only AS staff_only,
            ff.options AS rawOptions
     FROM dbo.submission_values sv
     JOIN dbo.form_fields ff ON ff.id = sv.field_id
     WHERE sv.submission_id = @submissionId
     ORDER BY ff.sort_order`,
    { submissionId }
  );
  // Convert the stored JSON-string options (rawOptions) into a parsed array.
  return rows.map((r) => ({
    id: r.id,
    submission_id: r.submission_id,
    field_id: r.field_id,
    value: r.value,
    field_label: r.field_label,
    field_type: r.field_type,
    staff_only: r.staff_only,
    options: parseFormFieldOptions(r.rawOptions),
  }));
}

export async function listComments(submissionId: number): Promise<CommentRow[]> {
  return execute<CommentRow>(
    `SELECT c.id, c.submission_id, c.staff_id, c.body, c.visibility, c.created_at,
            u.display_name AS staff_name
     FROM dbo.comments c
     JOIN dbo.users u ON u.id = c.staff_id
     WHERE c.submission_id = @submissionId
     ORDER BY c.created_at ASC`,
    { submissionId }
  );
}

export async function getSubmissionDetail(publicId: string): Promise<SubmissionDetail | null> {
  const submission = await getSubmissionByPublicId(publicId);
  if (!submission) return null;
  const values = await listSubmissionValues(submission.id);
  const comments = await listComments(submission.id);
  const adhocFields = await listAdhocFields(submission.id);
  return { ...submission, values, comments, adhocFields };
}

export async function createSubmission(
  formId: number,
  schoolId: number | null,
  publicId: string,
  answers: { field_id: number; value: string | number | boolean | string[] | null }[]
): Promise<SubmissionDetail> {
  const subs = await execute<Submission>(
    `INSERT INTO dbo.submissions (public_id, form_id, school_id, status)
     OUTPUT INSERTED.id, INSERTED.public_id, INSERTED.form_id, INSERTED.school_id,
            INSERTED.status, INSERTED.submitted_at, INSERTED.updated_at
     VALUES (@publicId, @formId, @schoolId, 'submitted')`,
    { publicId, formId, schoolId: schoolId ?? null }
  );
  const submission = subs[0];
  for (const a of answers) {
    await execute(
      `INSERT INTO dbo.submission_values (submission_id, field_id, value)
       VALUES (@submissionId, @fieldId, @value)`,
      {
        submissionId: submission.id,
        fieldId: a.field_id,
        value: a.value === null ? null :
          typeof a.value === "string" ? a.value :
          typeof a.value === "number" ? String(a.value) :
          typeof a.value === "boolean" ? (a.value ? "1" : "0") :
          JSON.stringify(a.value),
      }
    );
  }
  const detail = await getSubmissionDetail(publicId);
  if (!detail) throw new Error("Failed to read back created submission");
  return detail;
}

export async function updateSubmissionStatus(id: number, status: string): Promise<void> {
  await execute(
    `UPDATE dbo.submissions SET status = @status, updated_at = SYSUTCDATETIME() WHERE id = @id`,
    { id, status }
  );
}

// -----------------------------------------------------------------------------
// Submission value editing (staff/admin)
// -----------------------------------------------------------------------------
// Upsert the supplied answers against the submission. Existing rows (matched by
// submission_id + field_id) are updated; new fields are inserted; fields present
// in the DB but absent from the incoming payload are left untouched.
export async function updateSubmissionValues(
  submissionId: number,
  answers: { field_id: number; value: string | number | boolean | string[] | null }[]
): Promise<void> {
  for (const a of answers) {
    const serialized =
      a.value === null ? null :
      typeof a.value === "string" ? a.value :
      typeof a.value === "number" ? String(a.value) :
      typeof a.value === "boolean" ? (a.value ? "1" : "0") :
      JSON.stringify(a.value);

    await execute(
      `IF EXISTS (SELECT 1 FROM dbo.submission_values WHERE submission_id = @submissionId AND field_id = @fieldId)
         UPDATE dbo.submission_values SET value = @value
         WHERE submission_id = @submissionId AND field_id = @fieldId
       ELSE
         INSERT INTO dbo.submission_values (submission_id, field_id, value)
         VALUES (@submissionId, @fieldId, @value);`,
      { submissionId, fieldId: a.field_id, value: serialized }
    );
  }

  // Touch the submission's updated_at so the list orders reflect the change.
  await execute(
    `UPDATE dbo.submissions SET updated_at = SYSUTCDATETIME() WHERE id = @id`,
    { id: submissionId }
  );
}

// -----------------------------------------------------------------------------
// Comments
// -----------------------------------------------------------------------------
export async function createComment(
  submissionId: number,
  staffId: number,
  body: string,
  visibility: "internal"
): Promise<CommentRow> {
  const rows = await execute<CommentRow>(
    `INSERT INTO dbo.comments (submission_id, staff_id, body, visibility)
     OUTPUT INSERTED.id, INSERTED.submission_id, INSERTED.staff_id, INSERTED.body,
            INSERTED.visibility, INSERTED.created_at
     VALUES (@submissionId, @staffId, @body, @visibility)`,
    { submissionId, staffId, body, visibility }
  );
  return rows[0];
}

// -----------------------------------------------------------------------------
// Submission ad-hoc staff-only fields
// -----------------------------------------------------------------------------
export interface AdhocFieldRow {
  id: number;
  submission_id: number;
  label: string;
  type: string;
  options: string[] | null;
  value: string | number | boolean | string[] | null;
  sort_order: number;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

interface RawAdhocRow {
  id: number;
  submission_id: number;
  label: string;
  type: string;
  options: string | null;
  value: string | null;
  sort_order: number;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

// Parse stored JSON-string options (same rule as form_fields.options).
function parseAdhocOptions(raw: string | null): string[] | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

// Serialize a scalar/array value into the storage format (same as submission values).
function serializeValue(value: string | number | boolean | string[] | null): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return JSON.stringify(value);
}

export async function listAdhocFields(submissionId: number): Promise<AdhocFieldRow[]> {
  const rows = await execute<RawAdhocRow>(`
    SELECT id, submission_id, label, type, options, value, sort_order, created_by, created_at, updated_at
    FROM dbo.submission_adhoc_fields
    WHERE submission_id = @submissionId
    ORDER BY sort_order, id`, { submissionId });

  return rows.map((r) => ({ ...r, options: parseAdhocOptions(r.options) }));
}

export async function getAdhocField(id: number): Promise<AdhocFieldRow | null> {
  const rows = await execute<RawAdhocRow>(`
    SELECT id, submission_id, label, type, options, value, sort_order, created_by, created_at, updated_at
    FROM dbo.submission_adhoc_fields
    WHERE id = @id`, { id });
  return rows[0] ? { ...rows[0], options: parseAdhocOptions(rows[0].options) } : null;
}

export async function createAdhocField(input: {
  submissionId: number;
  label: string;
  type: string;
  options: string[] | null;
  value: string | number | boolean | string[] | null;
  sortOrder: number;
  createdBy: number | null;
}): Promise<AdhocFieldRow> {
  const rows = await execute<RawAdhocRow>(`
    INSERT INTO dbo.submission_adhoc_fields (submission_id, label, type, options, value, sort_order, created_by)
    OUTPUT INSERTED.id, INSERTED.submission_id, INSERTED.label, INSERTED.type, INSERTED.options,
           INSERTED.value, INSERTED.sort_order, INSERTED.created_by, INSERTED.created_at, INSERTED.updated_at
    VALUES (@submissionId, @label, @type, @options, @value, @sortOrder, @createdBy)`,
    {
      submissionId: input.submissionId,
      label: input.label,
      type: input.type,
      options: input.options && input.options.length ? JSON.stringify(input.options) : null,
      value: serializeValue(input.value),
      sortOrder: input.sortOrder,
      createdBy: input.createdBy,
    });
  const created = rows[0];
  const detailed = await getAdhocField(created.id);
  if (!detailed) throw new Error("Failed to read back created ad-hoc field");
  return detailed;
}

export async function updateAdhocField(
  id: number,
  input: {
    label: string;
    type: string;
    options: string[] | null;
    value: string | number | boolean | string[] | null;
  }
): Promise<AdhocFieldRow | null> {
  await execute(`
    UPDATE dbo.submission_adhoc_fields
    SET label = @label, type = @type, options = @options, value = @value,
        updated_at = SYSUTCDATETIME()
    WHERE id = @id`,
    {
      id,
      label: input.label,
      type: input.type,
      options: input.options && input.options.length ? JSON.stringify(input.options) : null,
      value: serializeValue(input.value),
    });
  return getAdhocField(id);
}

export async function deleteAdhocField(id: number): Promise<void> {
  await execute(`DELETE FROM dbo.submission_adhoc_fields WHERE id = @id`, { id });
}

// -----------------------------------------------------------------------------
// Export helpers
// -----------------------------------------------------------------------------
export interface ExportColumn {
  key: string;
  label: string;
  staff_only: boolean;
}

export async function getExportColumns(formId: number): Promise<ExportColumn[]> {
  const rows = await execute<{ id: number; label: string; staff_only: boolean }>(
    `SELECT id, label, staff_only FROM dbo.form_fields WHERE form_id = @formId ORDER BY sort_order`,
    { formId }
  );
  return rows.map((r) => ({
    key: `field_${r.id}`,
    label: r.label,
    staff_only: Boolean(r.staff_only),
  }));
}
