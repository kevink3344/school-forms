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
  Organization,
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
// Organizations
// -----------------------------------------------------------------------------
export async function listOrganizations(): Promise<Organization[]> {
  return execute<Organization>(
    "SELECT id, slug, name, created_at FROM dbo.organizations ORDER BY name"
  );
}

// Resolve an org by its URL slug (used for the public `/:slug` form routes).
export async function getOrganizationBySlug(slug: string): Promise<Organization | null> {
  const rows = await execute<Organization>(
    "SELECT id, slug, name, created_at FROM dbo.organizations WHERE slug = @slug",
    { slug }
  );
  return rows[0] ?? null;
}

export async function getOrganizationById(id: number): Promise<Organization | null> {
  const rows = await execute<Organization>(
    "SELECT id, slug, name, created_at FROM dbo.organizations WHERE id = @id",
    { id }
  );
  return rows[0] ?? null;
}

// The default tenant that self-registered users land in. The plan defines
// `academics` as the canonical default org (seeded in DDL).
export async function getDefaultOrganization(): Promise<Organization> {
  const org = await getOrganizationBySlug("academics");
  if (!org) throw new Error("Default organization 'academics' not found — run initDb first");
  return org;
}

// -----------------------------------------------------------------------------
// App settings (generic key/value store — public read, admin write)
// -----------------------------------------------------------------------------
interface SettingRow {
  key: string;
  value: string;
}

export async function getSetting(key: string): Promise<string | null> {
  const rows = await execute<SettingRow>(
    "SELECT [key], [value] FROM dbo.app_settings WHERE [key] = @key",
    { key }
  );
  return rows[0]?.value ?? null;
}

// Upsert a setting. SQL Server has no ON CONFLICT, so use MERGE. Returns the
// stored value (the string, normalized) so callers can echo it back.
export async function setSetting(key: string, value: string): Promise<string> {
  await execute(
    `MERGE dbo.app_settings AS target
     USING (SELECT @key AS [key], @value AS [value]) AS source
     ON target.[key] = source.[key]
     WHEN MATCHED THEN UPDATE SET target.[value] = source.[value],
                                  target.updated_at = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN INSERT ([key], [value], updated_at)
       VALUES (source.[key], source.[value], SYSUTCDATETIME());`,
    { key, value }
  );
  return value;
}

// Minimal user rows for the select-mode login dropdown. Never returns a
// password hash — only the fields the dropdown label needs.
export async function listUsersForSelect(organizationId?: number | null): Promise<
  { id: number; display_name: string; email: string; role: Role }[]
> {
  const params: Record<string, unknown> = {};
  const where = organizationId !== undefined && organizationId !== null
    ? "WHERE organization_id = @organizationId"
    : "";
  if (where) params.organizationId = organizationId;
  return execute<{ id: number; display_name: string; email: string; role: Role }>(
    `SELECT id, display_name, email, role
     FROM dbo.users
     ${where}
     ORDER BY display_name, email`,
    params
  );
}

// -----------------------------------------------------------------------------
// Schools
// -----------------------------------------------------------------------------
export async function listSchools(schoolId?: number | null): Promise<School[]> {
  if (schoolId !== undefined && schoolId !== null) {
    return execute<School>(
      "SELECT id, source_id, name, grade_level, calendar, district, created_at FROM dbo.schools WHERE id = @schoolId ORDER BY name",
      { schoolId }
    );
  }
  return execute<School>(
    "SELECT id, source_id, name, grade_level, calendar, district, created_at FROM dbo.schools ORDER BY name"
  );
}

export async function getSchool(id: number): Promise<School | null> {
  const rows = await execute<School>(
    "SELECT id, source_id, name, grade_level, calendar, district, created_at FROM dbo.schools WHERE id = @id",
    { id }
  );
  return rows[0] ?? null;
}

export async function createSchool(name: string, district: string | null): Promise<School> {
  const rows = await execute<School>(
    `INSERT INTO dbo.schools (name, district)
     OUTPUT INSERTED.id, INSERTED.source_id, INSERTED.name, INSERTED.grade_level,
            INSERTED.calendar, INSERTED.district, INSERTED.created_at
     VALUES (@name, @district)`,
    { name, district }
  );
  return rows[0];
}

// Paginated listing for the admin Schools page.
export async function listSchoolsPage(params: {
  page: number;
  pageSize: number;
}): Promise<{ rows: School[]; total: number }> {
  const { page, pageSize } = params;
  const offset = (page - 1) * pageSize;
  const countRows = await execute<{ total: number }>(
    "SELECT COUNT(*) AS total FROM dbo.schools"
  );
  const total = countRows[0]?.total ?? 0;
  const rows = await execute<School>(
    `SELECT id, source_id, name, grade_level, calendar, district, created_at
     FROM dbo.schools
     ORDER BY name
     OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
    { offset, pageSize }
  );
  return { rows, total };
}

// Upsert a school from the imported feed, keyed on the stable source_id (FID).
export async function upsertSchoolFromSource(s: {
  sourceId: number;
  name: string;
  gradeLevel: string | null;
  calendar: string | null;
  district: string | null;
}): Promise<School> {
  const rows = await execute<School>(
    `MERGE dbo.schools AS tgt
     USING (SELECT @sourceId AS source_id) AS src
       ON tgt.source_id = src.source_id
     WHEN MATCHED THEN
       UPDATE SET tgt.name = @name, tgt.grade_level = @gradeLevel,
                  tgt.calendar = @calendar,
                  tgt.district = COALESCE(@district, tgt.district)
     WHEN NOT MATCHED THEN
       INSERT (source_id, name, grade_level, calendar, district)
       VALUES (@sourceId, @name, @gradeLevel, @calendar, @district)
     OUTPUT INSERTED.id, INSERTED.source_id, INSERTED.name, INSERTED.grade_level,
            INSERTED.calendar, INSERTED.district, INSERTED.created_at;`,
    { sourceId: s.sourceId, name: s.name, gradeLevel: s.gradeLevel, calendar: s.calendar, district: s.district }
  );
  return rows[0];
}

// -----------------------------------------------------------------------------
// School import: parse helpers (pure — no DB)
// -----------------------------------------------------------------------------
export function normalizeSchoolLabel(label: string): string {
  return label.replace(/\s+/g, "").toUpperCase();
}

export function featureToSchool(
  feature: Record<string, unknown>,
  columns: string[]
): { sourceId: number; name: string; gradeLevel: string | null; calendar: string | null; district: string | null } {
  // GeoJSON Feature: { id, geometry, properties: { ... } }
  const props = (feature?.properties ?? {}) as Record<string, unknown>;
  const get = (label: string): string | null => {
    const key = normalizeSchoolLabel(label);
    const v = props[key];
    if (v === undefined || v === null || String(v).trim() === "") return null;
    return String(v).trim();
  };
  // "Name" is the primary display name; fall back to NAME_SHORT.
  const name = get("Name") || get("NameShort") || `School ${feature.id ?? ""}`;
  return {
    sourceId: Number(feature.id ?? props["FID"] ?? 0),
    name,
    gradeLevel: get("GradeLevel") ?? get("Grade"),
    calendar: get("Calendar"),
    district: get("District"),
  };
}

// -----------------------------------------------------------------------------
// Users
// -----------------------------------------------------------------------------
export async function getUserByEmail(email: string): Promise<User | null> {
  const rows = await execute<User>(
    `SELECT id, email, password_hash, role, school_id, organization_id, display_name, active, created_at
     FROM dbo.users WHERE email = @email`,
    { email }
  );
  return rows[0] ?? null;
}

export async function getUserById(id: number): Promise<User | null> {
  const rows = await execute<User>(
    `SELECT id, email, password_hash, role, school_id, organization_id, display_name, active, created_at
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
  displayName: string,
  active = true,
  organizationId: number | null = null
): Promise<User> {
  const rows = await execute<User>(
    `INSERT INTO dbo.users (email, password_hash, role, school_id, display_name, active, organization_id)
     OUTPUT INSERTED.id, INSERTED.email, INSERTED.password_hash, INSERTED.role,
            INSERTED.school_id, INSERTED.organization_id, INSERTED.display_name,
            INSERTED.active, INSERTED.created_at
     VALUES (@email, @passwordHash, @role, @schoolId, @displayName, @active, @organizationId)`,
    { email, passwordHash, role, schoolId, displayName, active, organizationId }
  );
  return rows[0];
}

// A user row enriched with their school's display name (LEFT JOIN so admins with
// no school still appear). Used by the admin Settings → Users panel.
export interface AdminUserRow extends User {
  school_name: string | null;
  organization_name: string | null;
  organization_slug: string | null;
}

// Optional org filter. When provided, only users in that org are returned.
export async function listUsers(organizationId?: number | null): Promise<AdminUserRow[]> {
  const params: Record<string, unknown> = {};
  const where = organizationId !== undefined && organizationId !== null
    ? "WHERE u.organization_id = @organizationId"
    : "";
  if (where) params.organizationId = organizationId;
  return execute<AdminUserRow>(
    `SELECT u.id, u.email, u.password_hash, u.role, u.school_id, u.organization_id,
            u.display_name, u.active, u.created_at,
            s.name AS school_name,
            o.name AS organization_name,
            o.slug AS organization_slug
     FROM dbo.users u
     LEFT JOIN dbo.schools s ON s.id = u.school_id
     LEFT JOIN dbo.organizations o ON o.id = u.organization_id
     ${where}
     ORDER BY u.role, u.display_name, u.email`,
    params
  );
}

export async function updateUser(
  id: number,
  data: { display_name?: string; email?: string; active?: boolean; school_id?: number | null; role?: Role; organization_id?: number | null }
): Promise<User | null> {
  const existing = await getUserById(id);
  if (!existing) return null;

  const displayName = data.display_name ?? existing.display_name;
  const email = data.email ?? existing.email;
  const active = data.active ?? existing.active;
  const schoolId = data.school_id === undefined ? existing.school_id : data.school_id;
  const role = data.role ?? existing.role;
  const organizationId = data.organization_id === undefined ? existing.organization_id : data.organization_id;

  const rows = await execute<User>(
    `UPDATE dbo.users
     SET display_name = @displayName, email = @email, active = @active,
         school_id = @schoolId, role = @role, organization_id = @organizationId
     OUTPUT INSERTED.id, INSERTED.email, INSERTED.password_hash, INSERTED.role,
            INSERTED.school_id, INSERTED.organization_id, INSERTED.display_name,
            INSERTED.active, INSERTED.created_at
     WHERE id = @id`,
    { id, displayName, email, active, schoolId, role, organizationId }
  );
  return rows[0] ?? null;
}

// -----------------------------------------------------------------------------
// Forms
// -----------------------------------------------------------------------------
export interface FormWithFields extends Form {
  fields: FormField[];
}

// Optional school + org filters. When provided, forms are narrowed to that org
// (and optionally a single school). Omit both to return all forms (admin).
export async function listForms(schoolId?: number | null, organizationId?: number | null): Promise<Form[]> {
  const params: Record<string, unknown> = {};
  const clauses: string[] = [];
  if (organizationId !== undefined && organizationId !== null) {
    clauses.push("f.organization_id = @organizationId");
    params.organizationId = organizationId;
  }
  if (schoolId !== undefined && schoolId !== null) {
    clauses.push("f.school_id = @schoolId");
    params.schoolId = schoolId;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return execute<Form>(
    `SELECT f.id, f.title, f.description, f.school_id, f.designer_id, f.organization_id,
            f.status, f.created_at, f.updated_at
     FROM dbo.forms f ${where} ORDER BY f.updated_at DESC`,
    params
  );
}

// Fetch a form that belongs to the provided organization (used for org-scoped
// public routes and admin actions). Returns null when the form exists but does
// NOT belong to that org, preventing cross-org leakage.
export async function getForm(id: number, organizationId?: number | null): Promise<Form | null> {
  const clauses: string[] = ["id = @id"];
  const params: Record<string, unknown> = { id };
  if (organizationId !== undefined && organizationId !== null) {
    clauses.push("organization_id = @organizationId");
    params.organizationId = organizationId;
  }
  const rows = await execute<Form>(
    `SELECT id, title, description, school_id, designer_id, organization_id, status, created_at, updated_at
     FROM dbo.forms WHERE ${clauses.join(" AND ")}`,
    params
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

export async function getFormWithFields(id: number, organizationId?: number | null): Promise<FormWithFields | null> {
  const form = await getForm(id, organizationId);
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
    organizationId,
  }: {
    title: string;
    description: string | null;
    schoolId: number | null;
    designerId: number | null;
    organizationId: number;
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
    `INSERT INTO dbo.forms (title, description, school_id, designer_id, organization_id, status)
     OUTPUT INSERTED.id, INSERTED.title, INSERTED.description, INSERTED.school_id,
            INSERTED.designer_id, INSERTED.organization_id, INSERTED.status,
            INSERTED.created_at, INSERTED.updated_at
     VALUES (@title, @description, @schoolId, @designerId, @organizationId, 'draft')`,
    { title, description, schoolId: schoolId ?? null, designerId: designerId ?? null, organizationId }
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
        { id, formId }
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
  // The form's own staff-only field definitions — these are always shown on the
  // detail page so staff can fill them in one by one (even before a value exists).
  staffOnlyFields: FormField[];
}

export async function listSubmissions(params: {
  organizationId?: number | null;
  schoolId?: number | null;
  formId?: number | null;
  status?: string | null;
  from?: string | null;
  to?: string | null;
}): Promise<SubmissionRow[]> {
  const p: Record<string, unknown> = {};
  const clauses: string[] = [];
  if (params.organizationId !== undefined && params.organizationId !== null) {
    clauses.push("s.organization_id = @organizationId");
    p.organizationId = params.organizationId;
  }
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
    `SELECT s.id, s.public_id, s.form_id, s.school_id, s.organization_id, s.status, s.submitted_at, s.updated_at,
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

// Fetch a submission by its public id. When an organizationId is provided, the
// submission must belong to that org — used to keep public submission readback
// and detail views scoped to the org that owns the form.
export async function getSubmissionByPublicId(publicId: string, organizationId?: number | null): Promise<SubmissionRow | null> {
  const clauses: string[] = ["s.public_id = @publicId"];
  const params: Record<string, unknown> = { publicId };
  if (organizationId !== undefined && organizationId !== null) {
    clauses.push("s.organization_id = @organizationId");
    params.organizationId = organizationId;
  }
  const rows = await execute<SubmissionRow>(
    `SELECT s.id, s.public_id, s.form_id, s.school_id, s.organization_id, s.status, s.submitted_at, s.updated_at,
            f.title AS form_name, f.organization_id AS form_organization_id,
            (SELECT TOP 1 sv.value
             FROM dbo.submission_values sv
             JOIN dbo.form_fields ff ON ff.id = sv.field_id
             WHERE sv.submission_id = s.id AND ff.staff_only = 0 AND sv.value IS NOT NULL
             ORDER BY ff.sort_order) AS student_name
     FROM dbo.submissions s
     JOIN dbo.forms f ON f.id = s.form_id
     WHERE ${clauses.join(" AND ")}`,
    params
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

export async function getSubmissionDetail(publicId: string, organizationId?: number | null): Promise<SubmissionDetail | null> {
  const submission = await getSubmissionByPublicId(publicId, organizationId);
  if (!submission) return null;
  const values = await listSubmissionValues(submission.id);
  const comments = await listComments(submission.id);
  const adhocFields = await listAdhocFields(submission.id);
  // The form's staff-only field definitions, so the detail page can render every
  // staff-only field (including ones not yet answered) for one-by-one filling.
  const formFields = await listFormFields(submission.form_id);
  const staffOnlyFields = formFields.filter((f) => f.staff_only);
  return { ...submission, values, comments, adhocFields, staffOnlyFields };
}

// Resolve which school a submission belongs to. District-wide forms (e.g. CDM)
// collect a parent-typed "School" answer rather than being tied to a single
// school. When the form has a "School"-labeled field and the parent's answer
// matches a school name exactly (case-insensitive), the submission is scoped to
// that school so the matching staff can see it. Falls back to form.school_id.
export async function resolveSubmissionSchoolId(
  form: Pick<Form, "id" | "school_id">,
  answers: { field_id: number; value: string | number | boolean | string[] | null }[]
): Promise<number | null> {
  const fallback = form.school_id ?? null;

  // Identify "school" answer fields by their label — the CDM Google Form uses a
  // plain-text field labeled "School" (also tolerate "School Name").
  const fields = await listFormFields(form.id);
  const schoolFieldIds = new Set<number>();
  for (const f of fields) {
    const label = f.label.trim().toLowerCase();
    if (label === "school" || label === "school name") schoolFieldIds.add(f.id);
  }
  if (schoolFieldIds.size === 0) return fallback;

  for (const a of answers) {
    if (!schoolFieldIds.has(a.field_id)) continue;
    if (typeof a.value !== "string" || !a.value.trim()) continue;
    const name = a.value.trim();
    // Exact match against schools.name (Azure SQL default collation is
    // case-insensitive, so "broughton high school" matches "Broughton High School").
    const rows = await execute<Pick<School, "id">>(
      "SELECT id FROM dbo.schools WHERE name = @name",
      { name }
    );
    if (rows[0]?.id) return rows[0].id;
  }
  return fallback;
}

export async function createSubmission(
  form: Form,
  publicId: string,
  answers: { field_id: number; value: string | number | boolean | string[] | null }[]
): Promise<SubmissionDetail> {
  const schoolId = await resolveSubmissionSchoolId(form, answers);
  const subs = await execute<Submission>(
    `INSERT INTO dbo.submissions (public_id, form_id, school_id, organization_id, status)
     OUTPUT INSERTED.id, INSERTED.public_id, INSERTED.form_id, INSERTED.school_id,
            INSERTED.organization_id, INSERTED.status, INSERTED.submitted_at, INSERTED.updated_at
     VALUES (@publicId, @formId, @schoolId, @organizationId, 'submitted')`,
    { publicId, formId: form.id, schoolId, organizationId: form.organization_id }
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
  const detail = await getSubmissionDetail(publicId, form.organization_id);
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
