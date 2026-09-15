import { getClient, getDbKind } from "./pool.js";
import { getDialect } from "./dialect/index.js";
import { formatSubmissionPublicId, fieldAccessRoles, canSeeField, schoolYearForDate } from "./schema.js";
import { listDocumentsBySubmission } from "./documents.js";
import { env } from "../config/env.js";
import type {
  School,
  User,
  Form,
  FormField,
  Submission,
  SubmissionValue,
  AdhocField,
  Role,
  Organization,
  ListDocumentRow,
} from "./schema.js";

// -----------------------------------------------------------------------------
// Generic query helper — the single seam every query in the app flows through.
//
// It is dialect-neutral by design: named `@param` placeholders in, row array
// out. driver/mssql.ts binds them through `mssql`; driver/libsql.ts binds them
// through libSQL (which also translates `dbo.` / `SYSUTCDATETIME()` and
// normalises SQLite's 0/1 back to booleans).
//
// The handful of statement shapes that genuinely differ between the two dialects
// (OUTPUT / MERGE / OFFSET-FETCH) are produced by `dialect()` below rather than
// being written inline here — see dialect/sqlserver.ts and dialect/turso.ts.
// -----------------------------------------------------------------------------
export async function execute<T = unknown>(
  query: string,
  params: Record<string, unknown> = {}
): Promise<T[]> {
  return getClient().query<T>(query, params);
}

/** The statement builders for the active dialect. */
function dialect() {
  return getDialect(getDbKind());
}

// -----------------------------------------------------------------------------
// Organizations
// -----------------------------------------------------------------------------
export async function listOrganizations(): Promise<Organization[]> {
  return execute<Organization>(
    "SELECT id, slug, name, description, doc_folder_id, active, created_at FROM dbo.organizations ORDER BY name"
  );
}

// Resolve an org by its URL slug (used for the public `/:slug` form routes).
export async function getOrganizationBySlug(slug: string): Promise<Organization | null> {
  const rows = await execute<Organization>(
    "SELECT id, slug, name, description, doc_folder_id, active, created_at FROM dbo.organizations WHERE slug = @slug",
    { slug }
  );
  return rows[0] ?? null;
}

export async function getOrganizationById(id: number): Promise<Organization | null> {
  const rows = await execute<Organization>(
    "SELECT id, slug, name, description, doc_folder_id, active, created_at FROM dbo.organizations WHERE id = @id",
    { id }
  );
  return rows[0] ?? null;
}

export async function createOrganization(
  name: string,
  slug: string,
  description: string | null,
  docFolderId: string | null,
  active: boolean
): Promise<Organization> {
  const rows = await execute<Organization>(
    dialect().insertReturning({
      table: "organizations",
      columns: ["slug", "name", "description", "doc_folder_id", "active"],
      returning: ["id", "slug", "name", "description", "doc_folder_id", "active", "created_at"],
      values: "@slug, @name, @description, @docFolderId, @active",
    }),
    { slug, name, description, docFolderId, active }
  );
  return rows[0];
}

// Partial update: only supplied fields are changed. Returns the updated org, or
// null if the id does not exist. Uses the read-first pattern (like updateUser).
export async function updateOrganization(
  id: number,
  data: {
    name?: string;
    slug?: string;
    description?: string | null;
    doc_folder_id?: string | null;
    active?: boolean;
  }
): Promise<Organization | null> {
  const existing = await getOrganizationById(id);
  if (!existing) return null;

  const name = data.name ?? existing.name;
  const slug = data.slug ?? existing.slug;
  // `description` is nullable: an explicitly-supplied null clears it, an absent
  // key leaves it unchanged. `??` would conflate null with "not provided", so
  // check presence explicitly.
  const description = Object.prototype.hasOwnProperty.call(data, "description")
    ? data.description
    : existing.description;
  // Same nullable/clear semantics as `description` for the Drive folder override.
  const docFolderId = Object.prototype.hasOwnProperty.call(data, "doc_folder_id")
    ? data.doc_folder_id
    : existing.doc_folder_id;
  const active = data.active ?? existing.active;

  const rows = await execute<Organization>(
    dialect().updateReturning({
      table: "organizations",
      set:
        "name = @name, slug = @slug, description = @description,\n" +
        "         doc_folder_id = @docFolderId, active = @active",
      where: "id = @id",
      returning: ["id", "slug", "name", "description", "doc_folder_id", "active", "created_at"],
    }),
    { id, name, slug, description, docFolderId, active }
  );
  return rows[0] ?? null;
}

// The organization that new self-registrations land in, and the default applied
// wherever an endpoint needs "the organization" without being told which one
// (e.g. the login page's stat panel and the test-account seeds).
//
// The slug comes from the DEFAULT_ORG_REGISTRATION environment variable and
// falls back to `academics` when blank or unset. Throwing when the slug does not
// resolve is intentional: a typo'd env var should fail loudly at registration
// rather than quietly file the account under the wrong organization.
export async function getDefaultOrganization(): Promise<Organization> {
  const slug = env.defaultOrgRegistration;
  const org = await getOrganizationBySlug(slug);
  if (!org) {
    throw new Error(
      `DEFAULT_ORG_REGISTRATION organization '${slug}' not found — create the organization or fix the env var`
    );
  }
  return org;
}

// -----------------------------------------------------------------------------
// Login stats (public counts for the login-page brand panel)
// -----------------------------------------------------------------------------
export interface LoginStats {
  users: number;
  schools: number;
  submissions: number;
}

// Org-wide counts for the login page's three stat boxes. Because the login page
// is pre-auth, the caller passes an organization_id so counts are scoped to that
// tenant (NOT the whole DB). Users & submissions carry `organization_id`
// directly and are scoped to the org. Schools are a GLOBAL shared directory with
// NO organization_id column (no school-org mapping table), so every school is
// counted regardless of org — that's the total directory size.
export async function getLoginStats(organizationId: number): Promise<LoginStats> {
  const rows = await execute<LoginStats>(
    `SELECT
       (SELECT COUNT(*) FROM dbo.users                WHERE organization_id = @orgId) AS users,
       (SELECT COUNT(*) FROM dbo.schools)                                              AS schools,
       (SELECT COUNT(*) FROM dbo.submissions          WHERE organization_id = @orgId) AS submissions`,
    { orgId: organizationId }
  );
  return rows[0] ?? { users: 0, schools: 0, submissions: 0 };
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

// Upsert a setting. SQL Server has no ON CONFLICT, so it uses MERGE; libSQL uses
// INSERT ... ON CONFLICT. Both shapes come from the active dialect. Returns the
// stored value (the string, normalized) so callers can echo it back.
export async function setSetting(key: string, value: string): Promise<string> {
  await execute(dialect().upsertSetting(), { key, value });
  return value;
}

// Minimal user rows for the select-mode login dropdown. Never returns a
// password hash — only the fields the dropdown label needs. Only active users in
// active organizations are listed (inactive orgs are excluded from sign-in), and
// only users an admin has opted in via "Show user on Test screen": the flag is
// OFF by default, so the test dropdown stays empty until it is deliberately
// populated rather than mirroring the real user list. That is a curation
// control, not a security boundary — `POST /api/auth/select` is passwordless and
// is intentionally left able to sign in a hidden user (docs/plans/login-mode.md).
export async function listUsersForSelect(organizationId?: number | null): Promise<
  { id: number; display_name: string; email: string; role: Role }[]
> {
  const params: Record<string, unknown> = {};
  const where =
    organizationId !== undefined && organizationId !== null
      ? "WHERE u.organization_id = @organizationId AND u.active = 1 AND o.active = 1 AND u.show_on_test_screen = 1"
      : "WHERE u.active = 1 AND o.active = 1 AND u.show_on_test_screen = 1";
  if (organizationId !== undefined && organizationId !== null) params.organizationId = organizationId;
  return execute<{ id: number; display_name: string; email: string; role: Role }>(
    `SELECT u.id, u.display_name, u.email, u.role
     FROM dbo.users u
     INNER JOIN dbo.organizations o ON o.id = u.organization_id
     ${where}
     ORDER BY u.display_name, u.email`,
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
    dialect().insertReturning({
      table: "schools",
      columns: ["name", "district"],
      returning: ["id", "source_id", "name", "grade_level", "calendar", "district", "created_at"],
      values: "@name, @district",
    }),
    { name, district }
  );
  return rows[0];
}

// Paginated listing for the admin Schools page. Supports an optional search
// term (matched against name/district) and exact-match filters for grade level
// and calendar. The same WHERE clause is applied to both the count and the rows.
export async function listSchoolsPage(params: {
  page: number;
  pageSize: number;
  search?: string;
  gradeLevel?: string;
  calendar?: string;
}): Promise<{ rows: School[]; total: number }> {
  const { page, pageSize, search, gradeLevel, calendar } = params;
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const filterParams: Record<string, unknown> = {};
  if (search) {
    conditions.push("(name LIKE @search OR district LIKE @search)");
    filterParams.search = `%${search}%`;
  }
  if (gradeLevel) {
    conditions.push("grade_level = @gradeLevel");
    filterParams.gradeLevel = gradeLevel;
  }
  if (calendar) {
    conditions.push("calendar = @calendar");
    filterParams.calendar = calendar;
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRows = await execute<{ total: number }>(
    `SELECT COUNT(*) AS total FROM dbo.schools ${where}`,
    filterParams
  );
  const total = countRows[0]?.total ?? 0;
  const rows = await execute<School>(
    dialect().selectSchoolsPage({ where, orderBy: "name" }),
    { ...filterParams, offset, pageSize }
  );
  return { rows, total };
}

// Distinct grade-level and calendar values used to populate the filter dropdowns
// on the admin Schools page. Empty/null values are excluded.
export async function getSchoolFacets(): Promise<{
  gradeLevels: string[];
  calendars: string[];
}> {
  const gradeRows = await execute<{ value: string }>(
    `SELECT DISTINCT grade_level AS value FROM dbo.schools
     WHERE grade_level IS NOT NULL AND grade_level <> ''
     ORDER BY grade_level`
  );
  const calendarRows = await execute<{ value: string }>(
    `SELECT DISTINCT calendar AS value FROM dbo.schools
     WHERE calendar IS NOT NULL AND calendar <> ''
     ORDER BY calendar`
  );
  return {
    gradeLevels: gradeRows.map((r) => r.value),
    calendars: calendarRows.map((r) => r.value),
  };
}

// Upsert a school from the imported feed, keyed on the stable source_id (FID).
export async function upsertSchoolFromSource(s: {
  sourceId: number;
  name: string;
  gradeLevel: string | null;
  calendar: string | null;
  district: string | null;
}): Promise<School> {
  const rows = await execute<School>(dialect().upsertSchoolFromSource(), {
    sourceId: s.sourceId,
    name: s.name,
    gradeLevel: s.gradeLevel,
    calendar: s.calendar,
    district: s.district,
  });
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
    `SELECT id, email, password_hash, role, school_id, organization_id, display_name, active, show_on_test_screen, created_at
     FROM dbo.users WHERE email = @email`,
    { email }
  );
  return rows[0] ?? null;
}

export async function getUserById(id: number): Promise<User | null> {
  const rows = await execute<User>(
    `SELECT id, email, password_hash, role, school_id, organization_id, display_name, active, show_on_test_screen, created_at
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
  organizationId: number | null = null,
  // Defaults to OFF so a new account never appears on the test screen until an
  // admin opts it in — see `listUsersForSelect`.
  showOnTestScreen = false
): Promise<User> {
  const rows = await execute<User>(
    dialect().insertReturning({
      table: "users",
      columns: [
        "email",
        "password_hash",
        "role",
        "school_id",
        "display_name",
        "active",
        "organization_id",
        "show_on_test_screen",
      ],
      returning: [
        "id",
        "email",
        "password_hash",
        "role",
        "school_id",
        "organization_id",
        "display_name",
        "active",
        "show_on_test_screen",
        "created_at",
      ],
      values:
        "@email, @passwordHash, @role, @schoolId, @displayName, @active, @organizationId, @showOnTestScreen",
    }),
    { email, passwordHash, role, schoolId, displayName, active, organizationId, showOnTestScreen }
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
            u.display_name, u.active, u.show_on_test_screen, u.created_at,
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
  data: {
    display_name?: string;
    email?: string;
    active?: boolean;
    school_id?: number | null;
    role?: Role;
    organization_id?: number | null;
    show_on_test_screen?: boolean;
  }
): Promise<User | null> {
  const existing = await getUserById(id);
  if (!existing) return null;

  const displayName = data.display_name ?? existing.display_name;
  const email = data.email ?? existing.email;
  const active = data.active ?? existing.active;
  const schoolId = data.school_id === undefined ? existing.school_id : data.school_id;
  const role = data.role ?? existing.role;
  const organizationId = data.organization_id === undefined ? existing.organization_id : data.organization_id;
  const showOnTestScreen = data.show_on_test_screen ?? existing.show_on_test_screen;

  const rows = await execute<User>(
    dialect().updateReturning({
      table: "users",
      set:
        "display_name = @displayName, email = @email, active = @active,\n" +
        "         school_id = @schoolId, role = @role, organization_id = @organizationId,\n" +
        "         show_on_test_screen = @showOnTestScreen",
      where: "id = @id",
      returning: [
        "id",
        "email",
        "password_hash",
        "role",
        "school_id",
        "organization_id",
        "display_name",
        "active",
        "show_on_test_screen",
        "created_at",
      ],
    }),
    { id, displayName, email, active, schoolId, role, organizationId, showOnTestScreen }
  );
  return rows[0] ?? null;
}

// Set a new password hash for a user (self-service password change). Kept
// deliberately separate from `updateUser` so the generic admin user-edit path
// can never write `password_hash` as a side effect. Returns true when a row was
// actually updated, so the caller can tell "no such user" from "changed".
export async function updateUserPassword(id: number, passwordHash: string): Promise<boolean> {
  const rows = await execute<{ id: number }>(
    dialect().updateReturning({
      table: "users",
      set: "password_hash = @passwordHash",
      where: "id = @id",
      returning: ["id"],
    }),
    { id, passwordHash }
  );
  // Note: `rows` rather than `rowsAffected` — libSQL reports 0 affected rows for
  // an UPDATE that carries RETURNING.
  return rows.length > 0;
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
            f.status, f.view_columns, f.code, f.submission_seq, f.doc_folder_id, f.google_form_url,
            f.created_at, f.updated_at,
            (SELECT COUNT(*) FROM dbo.submissions s WHERE s.form_id = f.id) AS submission_count
     FROM dbo.forms f ${where} ORDER BY f.updated_at DESC`,
    params
  );
}

// Count the submissions attached to a form. Used to guard form deletion: a form
// with any submission history must NOT be deleted, because submissions.form_id
// cascades on delete and would silently destroy submission data.
export async function countSubmissionsForForm(formId: number): Promise<number> {
  const rows = await execute<{ n: number }>(
    `SELECT COUNT(*) AS n FROM dbo.submissions WHERE form_id = @formId`,
    { formId }
  );
  return rows[0]?.n ?? 0;
}

// Delete a form (org-scoped). Returns true when a row was deleted, false when no
// matching form existed (or it belonged to another organization). Callers MUST
// verify the form has zero submissions first — see countSubmissionsForForm.
export async function deleteForm(id: number, organizationId?: number | null): Promise<boolean> {
  const clauses: string[] = ["id = @id"];
  const params: Record<string, unknown> = { id };
  if (organizationId !== undefined && organizationId !== null) {
    clauses.push("organization_id = @organizationId");
    params.organizationId = organizationId;
  }
  const deleted = await execute<{ id: number }>(
    dialect().deleteReturning({
      table: "forms",
      where: clauses.join(" AND "),
      returning: ["id"],
    }),
    params
  );
  return deleted.length > 0;
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
    `SELECT id, title, description, school_id, designer_id, organization_id, status,
            view_columns, code, submission_seq, doc_folder_id, google_form_url, created_at, updated_at
     FROM dbo.forms WHERE ${clauses.join(" AND ")}`,
    params
  );
  return rows[0] ?? null;
}

export async function listFormFields(formId: number): Promise<FormField[]> {
  const rows = await execute<FormField>(
    `SELECT id, form_id, label, type, options, required, staff_only, sort_order, placeholder, roles
     FROM dbo.form_fields WHERE form_id = @formId ORDER BY sort_order`,
    { formId }
  );
  // `options` is stored as a JSON string (NVARCHAR) but the API contract exposes
  // an array. Parse it back so every consumer (admin designer, parent submit,
  // public form) receives `string[] | null` and can safely call .join()/.map().
  return rows.map((f) => ({
    ...f,
    options: parseFormFieldOptions(f.options),
    roles: parseFormFieldRoles(f.roles),
  }));
}

// Parse the stored JSON-string roles into an array. Accepts a JSON string or an
// already-array value (defensive). Returns null for empty / invalid / non-array
// payloads so callers fall back to the default (all roles) for staff-only fields.
export function parseFormFieldRoles(raw: string[] | string | null | undefined): string[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string") return null;
  if (raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
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

// Deserialize a stored submission value for the API. Collections (checkbox /
// any array-valued field type) are persisted via JSON.stringify on write, so
// parse the JSON string back into an array on read; otherwise return the value
// unchanged. NULL is passed through so callers treat empty exactly as "not set".
function parseSubmissionValue(
  value: string | number | boolean | string[] | null,
  fieldType: string
): string | number | boolean | string[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(String); // already an array
  const isCollection = fieldType === "checkbox" || fieldType === "multiselect";
  if (!isCollection || typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : value;
  } catch {
    // Not valid JSON (e.g. legacy data or a plain value stored for the field) —
    // return the raw string so callers still surface it rather than dropping it.
    return value;
  }
}

export async function getFormWithFields(id: number, organizationId?: number | null): Promise<FormWithFields | null> {
  const form = await getForm(id, organizationId);
  if (!form) return null;
  const fields = await listFormFields(id);
  return { ...form, fields };
}

// Derive a short, globally-unique form code from a title (e.g. "Child Development
// Monitor" => "CDM", "IEP" => "IEP"). The code is NOT editable by admins, so the
// title is the only input. Uppercase, strip non-alphanumeric, truncate to 8 chars,
// then append a numeric suffix on collision (CDM, CDM2, CDM3, ...) to preserve the
// global-unique invariant enforced by UX_forms_code.
export async function generateFormCode(title: string): Promise<string> {
  const base =
    title.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "FORM";
  const existing = await execute<{ code: string }>(
    "SELECT code FROM dbo.forms WHERE code IS NOT NULL"
  );
  const taken = new Set(existing.map((r) => r.code.toUpperCase()));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

export async function createForm(
  {
    title,
    description,
    schoolId,
    designerId,
    organizationId,
    docFolderId,
    googleFormUrl,
  }: {
    title: string;
    description: string | null;
    schoolId: number | null;
    designerId: number | null;
    organizationId: number;
    docFolderId: string | null;
    googleFormUrl: string | null;
  },
  fields: {
    label: string;
    type: string;
    options?: string[] | null;
    required?: boolean;
    staff_only?: boolean;
    sort_order?: number;
    placeholder?: string | null;
    roles?: string[] | null;
  }[]
): Promise<FormWithFields> {
  // Derive a short, globally-unique form code from the title. The code prefixes
  // submission ids (`CDM-1001`); it is intentionally not editable.
  const code = await generateFormCode(title);
  // Insert form
  const forms = await execute<Form>(
    dialect().insertReturning({
      table: "forms",
      columns: [
        "title",
        "description",
        "school_id",
        "designer_id",
        "organization_id",
        "status",
        "code",
        "submission_seq",
        "doc_folder_id",
        "google_form_url",
      ],
      returning: [
        "id",
        "title",
        "description",
        "school_id",
        "designer_id",
        "organization_id",
        "status",
        "code",
        "submission_seq",
        "doc_folder_id",
        "google_form_url",
        "created_at",
        "updated_at",
      ],
      values:
        "@title, @description, @schoolId, @designerId, @organizationId, 'draft', @code, 0, @docFolderId, @googleFormUrl",
    }),
    { title, description, schoolId: schoolId ?? null, designerId: designerId ?? null, organizationId, code, docFolderId: docFolderId ?? null, googleFormUrl: googleFormUrl ?? null }
  );
  const form = forms[0];
  for (const f of fields) {
    await execute(
      `INSERT INTO dbo.form_fields (form_id, label, type, options, required, staff_only, sort_order, placeholder, roles)
       VALUES (@formId, @label, @type, @options, @required, @staffOnly, @sortOrder, @placeholder, @roles)`,
      {
        formId: form.id,
        label: f.label,
        type: f.type,
        options: f.options ? JSON.stringify(f.options) : null,
        required: f.required ?? false,
        staffOnly: f.staff_only ?? false,
        sortOrder: f.sort_order ?? 0,
        placeholder: f.placeholder ?? null,
        // An explicit [] ("no role may access") is stored as '[]' and must not
        // collapse to NULL, which would mean "unset -> all roles".
        roles: f.roles ? JSON.stringify(f.roles) : null,
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
    doc_folder_id?: string | null;
    google_form_url?: string | null;
    fields?: {
      id?: number;
      label: string;
      type: string;
      options?: string[] | null;
      required?: boolean;
      staff_only?: boolean;
      sort_order?: number;
      placeholder?: string | null;
      roles?: string[] | null;
    }[];
  }
): Promise<FormWithFields | null> {
  const existing = await getForm(formId);
  if (!existing) return null;

  const title = data.title ?? existing.title;
  const description = data.description === undefined ? existing.description : data.description;
  const status = data.status ?? existing.status;
  // `doc_folder_id` is nullable: an explicitly-supplied null clears it, an absent
  // key leaves it unchanged. `??` would conflate null with "not provided", so
  // check presence explicitly.
  const docFolderId = Object.prototype.hasOwnProperty.call(data, "doc_folder_id")
    ? data.doc_folder_id
    : existing.doc_folder_id;
  // Same null-vs-absent handling for the Google Form URL.
  const googleFormUrl = Object.prototype.hasOwnProperty.call(data, "google_form_url")
    ? data.google_form_url
    : existing.google_form_url;

  await execute(
    `UPDATE dbo.forms SET title=@title, description=@description, status=@status,
            doc_folder_id=@docFolderId, google_form_url=@googleFormUrl,
            updated_at=SYSUTCDATETIME() WHERE id=@id`,
    { id: formId, title, description, status, docFolderId: docFolderId ?? null, googleFormUrl: googleFormUrl ?? null }
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
    roles?: string[] | null;
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
    // Preserve [] as '[]' (explicit "no access") rather than NULL ("unset").
    const roles = f.roles ? JSON.stringify(f.roles) : null;
    if (f.id && existingIds.has(f.id)) {
      incomingIds.add(f.id);
      await execute(
        `UPDATE dbo.form_fields
         SET label=@label, type=@type, options=@options, required=@required,
             staff_only=@staffOnly, sort_order=@sortOrder, placeholder=@placeholder, roles=@roles
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
          roles,
        }
      );
    } else {
      await execute(
        `INSERT INTO dbo.form_fields (form_id, label, type, options, required, staff_only, sort_order, placeholder, roles)
         VALUES (@formId, @label, @type, @options, @required, @staffOnly, @sortOrder, @placeholder, @roles)`,
        {
          formId,
          label: f.label,
          type: f.type,
          options,
          required: f.required ?? false,
          staffOnly: f.staff_only ?? false,
          sortOrder,
          placeholder: f.placeholder ?? null,
          roles,
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
  // The submitting school's display name (LEFT JOIN so a NULL school_id still
  // renders a row). Used in the grid first column as "Student / School".
  school_name: string | null;
  // The first non-staff-only field value (conventionally the Student Name), used
  // to render a clickable name in the staff queue. Falls back to a placeholder.
  student_name: string | null;
  // Display name of the staff member who last saved the staff-only fields.
  staff_fields_updated_by_name: string | null;
}

export interface SubmissionValueRow extends SubmissionValue {
  field_label: string;
  field_type: string;
  staff_only: boolean;
  options: string[] | null;
}

export interface SubmissionDetail extends SubmissionRow {
  values: SubmissionValueRow[];
  // Staff-only fields added ad-hoc to this submission (not part of the fixed form).
  adhocFields: AdhocFieldRow[];
  // The form's own staff-only field definitions — these are always shown on the
  // detail page so staff can fill them in one by one (even before a value exists).
  staffOnlyFields: FormField[];
  // The form's non-staff-only field definitions — always shown so unanswered
  // optional fields (e.g. "Course choice #3 (optional)") still render and are
  // editable, even when no submission_values row exists yet.
  parentFields: FormField[];
  // Generated Google documents for this submission (detail-card audit line).
  documents: ListDocumentRow[];
}

export async function listSubmissions(params: {
  organizationId?: number | null;
  schoolId?: number | null;
  formId?: number | null;
  status?: string | null;
  from?: string | null;
  to?: string | null;
  // Free-text row filter (Reports). Matches the submission's public id, the
  // school name, or ANY answer value. Applied in SQL so the preview grid and
  // every export format see exactly the same rows (WYSIWYG export).
  q?: string | null;
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
  if (params.q && params.q.trim()) {
    // Escape LIKE wildcards so a literal `%` or `_` in the search term matches
    // itself; the paired `ESCAPE '\'` clauses tell SQL Server about the escape.
    const escaped = params.q.trim().replace(/[\\%_\[]/g, (m) => `\\${m}`);
    p.q = `%${escaped}%`;
    // `submission_values.value` is stored serialized (text/JSON), so this is a
    // textual match — checkbox arrays match their stored text representation.
    // An OPENJSON upgrade would give token-accurate array matching later.
    clauses.push(
      `(s.public_id LIKE @q ESCAPE '\\'` +
        ` OR sch.name LIKE @q ESCAPE '\\'` +
        ` OR EXISTS (SELECT 1 FROM dbo.submission_values svq` +
        ` WHERE svq.submission_id = s.id` +
        ` AND CAST(svq.value AS NVARCHAR(MAX)) LIKE @q ESCAPE '\\'))`
    );
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return execute<SubmissionRow>(
    `SELECT s.id, s.public_id, s.form_id, s.school_id, s.organization_id, s.status,
            s.submission_seq, s.submitted_at, s.updated_at,
            s.school_year,
            s.staff_fields_updated_by, s.staff_fields_updated_at,
            su.display_name AS staff_fields_updated_by_name,
            f.title AS form_name,
            sch.name AS school_name,
            ${dialect().submissionValueSubquery()} AS student_name
     FROM dbo.submissions s
     JOIN dbo.forms f ON f.id = s.form_id
     LEFT JOIN dbo.schools sch ON sch.id = s.school_id
     LEFT JOIN dbo.users su ON su.id = s.staff_fields_updated_by
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
    `SELECT s.id, s.public_id, s.form_id, s.school_id, s.organization_id, s.status,
            s.submission_seq, s.submitted_at, s.updated_at,
            s.school_year,
            s.staff_fields_updated_by, s.staff_fields_updated_at,
            su.display_name AS staff_fields_updated_by_name,
            f.title AS form_name, f.organization_id AS form_organization_id,
            ${dialect().submissionValueSubquery()} AS student_name
     FROM dbo.submissions s
     JOIN dbo.forms f ON f.id = s.form_id
     LEFT JOIN dbo.users su ON su.id = s.staff_fields_updated_by
     WHERE ${clauses.join(" AND ")}`,
    params
  );
  return rows[0] ?? null;
}

// Fetch a submission by its internal numeric id. Used internally by the Google
// document generator (which works with submission ids) to read back form_id and
// public_id without a public-id round trip.
export async function getSubmissionById(
  id: number
): Promise<{ id: number; form_id: number; public_id: string; school_id: number | null; organization_id: number } | null> {
  const rows = await execute<{
    id: number;
    form_id: number;
    public_id: string;
    school_id: number | null;
    organization_id: number;
  }>(
    `SELECT id, form_id, public_id, school_id, organization_id
     FROM dbo.submissions WHERE id = @id`,
    { id }
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
  // Convert the stored JSON-string options (rawOptions) into a parsed array, and
  // deserialize JSON-array values (checkbox/multiselect) back into arrays so the
  // client renderer sees the correct checked state.
  return rows.map((r) => ({
    id: r.id,
    submission_id: r.submission_id,
    field_id: r.field_id,
    value: parseSubmissionValue(r.value, r.field_type),
    field_label: r.field_label,
    field_type: r.field_type,
    staff_only: r.staff_only,
    options: parseFormFieldOptions(r.rawOptions),
  }));
}

// Bulk variant of listSubmissionValues used by the export/report table builder.
// Groups values by submission id so a whole result set is fetched with a handful
// of chunked queries instead of one query per submission (avoids an N+1 storm on
// large reports). SQL Server caps a request at 2100 parameters, so chunk at 1000.
const VALUE_BATCH_SIZE = 1000;

export async function listSubmissionValuesBatch(
  submissionIds: number[]
): Promise<Map<number, { field_id: number; value: SubmissionValue["value"] }[]>> {
  const out = new Map<number, { field_id: number; value: SubmissionValue["value"] }[]>();
  if (submissionIds.length === 0) return out;

  for (let i = 0; i < submissionIds.length; i += VALUE_BATCH_SIZE) {
    const chunk = submissionIds.slice(i, i + VALUE_BATCH_SIZE);
    const params: Record<string, unknown> = {};
    const placeholders = chunk.map((id, idx) => {
      params[`s${idx}`] = id;
      return `@s${idx}`;
    });
    interface BatchRow {
      submission_id: number;
      field_id: number;
      value: string | number | boolean | null;
      field_type: string;
    }
    const rows = await execute<BatchRow>(
      `SELECT sv.submission_id, sv.field_id, sv.value, ff.type AS field_type
       FROM dbo.submission_values sv
       JOIN dbo.form_fields ff ON ff.id = sv.field_id
       WHERE sv.submission_id IN (${placeholders.join(", ")})`,
      params
    );
    for (const r of rows) {
      const list = out.get(r.submission_id) ?? [];
      list.push({ field_id: r.field_id, value: parseSubmissionValue(r.value, r.field_type) });
      out.set(r.submission_id, list);
    }
  }
  return out;
}

export async function getSubmissionDetail(
  publicId: string,
  organizationId?: number | null,
  viewer: Role | "parent" = "admin"
): Promise<SubmissionDetail | null> {
  const submission = await getSubmissionByPublicId(publicId, organizationId);
  if (!submission) return null;
  const values = await listSubmissionValues(submission.id);
  const adhocFields = await listAdhocFields(submission.id);
  // The form's field definitions, so the detail page can render every field
  // (including ones not yet answered) for one-by-one filling. Internal fields
  // are partitioned by the viewer's access: staff/admin see the internal fields
  // their role is allowed to; parents never see internal fields.
  const formFields = await listFormFields(submission.form_id);
  const visibleFields = formFields.filter((f) => canSeeField(f, viewer));
  const visibleFieldIds = new Set(visibleFields.map((f) => f.id));
  const staffOnlyFields = visibleFields.filter((f) => f.staff_only);
  const parentFields = visibleFields.filter((f) => !f.staff_only);
  // Filter values to only the fields the viewer can see so a parent (or a staff
  // member without access) never receives out-of-view answers.
  const visibleValues = values.filter((v) => visibleFieldIds.has(v.field_id));
  const documents = await listDocumentsBySubmission(submission.id);
  return { ...submission, values: visibleValues, adhocFields, staffOnlyFields, parentFields, documents };
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
  answers: { field_id: number; value: string | number | boolean | string[] | null }[]
): Promise<SubmissionDetail> {
  // Allocate the next incremental submission id for this form inside a transaction.
  // The single UPDATE ... RETURNING takes a row lock and returns the incremented
  // value atomically, so concurrent submissions to the same form can never
  // collide. The allocation is committed immediately — the rest of the write is
  // deliberately outside the transaction, because holding a write lock across the
  // value inserts would serialise unrelated submissions.
  const allocation = await getClient().transaction(async (tx) => {
    const allocated = await tx.query<{ submission_seq: number }>(
      dialect().updateReturning({
        table: "forms",
        set: "submission_seq = submission_seq + 1, updated_at = SYSUTCDATETIME()",
        where: "id = @formId",
        returning: ["submission_seq"],
      }),
      { formId: form.id }
    );
    const row = allocated[0];
    if (!row) {
      throw new Error(`Form ${form.id} not found while allocating submission id`);
    }
    return row.submission_seq;
  });
  const submissionSeq: number = allocation;
  const publicId = formatSubmissionPublicId(form.code, submissionSeq);

  const schoolId = await resolveSubmissionSchoolId(form, answers);
  const schoolYear = schoolYearForDate(new Date());
  const subs = await execute<Submission>(
    dialect().insertReturning({
      table: "submissions",
      columns: [
        "public_id",
        "form_id",
        "school_id",
        "organization_id",
        "status",
        "submission_seq",
        "school_year",
      ],
      returning: [
        "id",
        "public_id",
        "form_id",
        "school_id",
        "organization_id",
        "status",
        "submission_seq",
        "school_year",
        "submitted_at",
        "updated_at",
      ],
      values:
        "@publicId, @formId, @schoolId, @organizationId, 'submitted', @submissionSeq, @schoolYear",
    }),
    { publicId, formId: form.id, schoolId, organizationId: form.organization_id, submissionSeq, schoolYear }
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
//
// ⚠ The upsert is spelled as UPDATE-then-INSERT-if-absent rather than any single
// "upsert" statement, because there is no one spelling that both dialects accept:
//
//   - T-SQL `IF EXISTS (…) UPDATE … ELSE INSERT …` is unparseable by libSQL
//     (SQL_PARSE_ERROR: near IF). It shipped that way and every staff-only save
//     returned 500 on Turso.
//   - `INSERT … ON CONFLICT (submission_id, field_id) DO UPDATE …` needs a UNIQUE
//     constraint on that pair, and `submission_values` has only two *non-unique*
//     indexes on both dialects (schema.ts / dialect/turso.ts). Adding one is a
//     schema migration against a live SQL Server database that this code cannot
//     verify, so it is deliberately avoided.
//   - A dialect builder (like `upsertSetting`) would need that same index.
//
// `INSERT … SELECT <params> WHERE NOT EXISTS (…)` is valid, identical SQL on both
// dialects and needs no schema change, so it is the one shape that is safe here.
// The UPDATE runs first so an existing row is written exactly once and the INSERT
// then finds it present; on a fresh field the UPDATE touches nothing and the
// INSERT creates the row. Two statements, not one, but this is a per-edit path
// with a single-answer payload, so the extra round trip is immaterial.
export async function updateSubmissionValues(
  submissionId: number,
  answers: { field_id: number; value: string | number | boolean | string[] | null }[],
  opts?: { staffOnly?: boolean; updaterId?: number }
): Promise<void> {
  for (const a of answers) {
    const serialized =
      a.value === null ? null :
      typeof a.value === "string" ? a.value :
      typeof a.value === "number" ? String(a.value) :
      typeof a.value === "boolean" ? (a.value ? "1" : "0") :
      JSON.stringify(a.value);

    const params = { submissionId, fieldId: a.field_id, value: serialized };

    await execute(
      `UPDATE dbo.submission_values SET value = @value
       WHERE submission_id = @submissionId AND field_id = @fieldId`,
      params
    );
    await execute(
      `INSERT INTO dbo.submission_values (submission_id, field_id, value)
       SELECT @submissionId, @fieldId, @value
        WHERE NOT EXISTS (
          SELECT 1 FROM dbo.submission_values
           WHERE submission_id = @submissionId AND field_id = @fieldId
        )`,
      params
    );
  }

  // Touch the submission's updated_at so the list orders reflect the change.
  await execute(
    `UPDATE dbo.submissions SET updated_at = SYSUTCDATETIME() WHERE id = @id`,
    { id: submissionId }
  );

  // Staff-only save: record which staff member saved these fields and when, so
  // the detail page can display an audit line. Only applies to explicit
  // staff-only batches (not general parent-field edits).
  if (opts?.staffOnly && opts.updaterId !== undefined) {
    await execute(
      `UPDATE dbo.submissions
       SET staff_fields_updated_by = @updaterId,
           staff_fields_updated_at = SYSUTCDATETIME(),
           updated_at = SYSUTCDATETIME()
       WHERE id = @id`,
      { id: submissionId, updaterId: opts.updaterId }
    );
  }
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
  const rows = await execute<RawAdhocRow>(
    dialect().insertReturning({
      table: "submission_adhoc_fields",
      columns: ["submission_id", "label", "type", "options", "value", "sort_order", "created_by"],
      returning: [
        "id",
        "submission_id",
        "label",
        "type",
        "options",
        "value",
        "sort_order",
        "created_by",
        "created_at",
        "updated_at",
      ],
      values: "@submissionId, @label, @type, @options, @value, @sortOrder, @createdBy",
    }),
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
  // Roles that may access this column when it is staff-only. NULL for public.
  roles: string[] | null;
  // The field's control type and option list, carried on the column so a client
  // can render a value and pick the right editor from `/api/export/preview`
  // alone. The Submissions grid used to read these from GET /api/forms/:id,
  // which is admin-only — staff and School Contacts need the same grid now, so
  // the metadata travels with the columns instead. The CSV/XLSX/PDF writers
  // read key/label and ignore these.
  type: string;
  options: string[] | null;
}

export async function getExportColumns(formId: number): Promise<ExportColumn[]> {
  const rows = await execute<{
    id: number;
    label: string;
    type: string;
    options: string | null;
    staff_only: boolean;
    roles: string | null;
  }>(
    `SELECT id, label, type, options, staff_only, roles
       FROM dbo.form_fields WHERE form_id = @formId ORDER BY sort_order`,
    { formId }
  );
  const columns = rows.map((r) => ({
    key: `field_${r.id}`,
    label: r.label,
    staff_only: Boolean(r.staff_only),
    roles: parseFormFieldRoles(r.roles),
    type: r.type,
    options: parseFormFieldOptions(r.options),
  }));

  // Group the staff-only columns at the bottom, each group keeping the form's own
  // `sort_order` (a stable partition — filter, not sort, so equal keys can't
  // shuffle). Every column list in the app is read from here: the Reports column
  // picker and preview grid, the Submissions export drawer, the CSV/XLSX/PDF
  // writers, and the form's default view-columns. Ordering here is therefore what
  // keeps the picker, the grid, and the exported file in the same order instead of
  // staff-only columns being interleaved with the public ones.
  return [...columns.filter((c) => !c.staff_only), ...columns.filter((c) => c.staff_only)];
}

// -----------------------------------------------------------------------------
// View Columns config (Submissions grid display, per-user per-form).
// Deliberately separate from getExportColumns — the Export feature must stay
// unchanged. This config only controls which columns the on-screen grid shows.
//
// Stored per (user, form) in dbo.user_form_view_columns, not on dbo.forms. The
// grid is shown to admins, staff AND School Contacts, so a single per-form
// value would mean whichever of them saved last silently rewrote everyone
// else's columns. Per-user also matches what people expect a column picker to
// do. dbo.forms.view_columns survives only as the source of the one-time
// backfill in the migration ladder.
// -----------------------------------------------------------------------------
// Base grid columns are a client-side rendering concern: they come from
// /api/submissions, not from the export preview, so the server never enumerates
// them and has no list to validate against. It only needs to tell a standard
// column's key apart from a field's, which the `base_` prefix does. An unknown
// `base_*` key is stored and then ignored by the client — harmless, and far
// better than a duplicated allow-list here that could drift from the grid.
// (Contrast `field_N`, which the server does own and validates against the
// form's real fields.)
const BASE_COLUMN_KEY = /^base_[a-z0-9_]+$/;

export interface ViewColumnsConfig {
  columns: ExportColumn[];
  viewKeys: string[];
  // The standard grid columns this user has turned OFF, by key. Stored as the
  // *hidden* set rather than the shown set deliberately: absence then means
  // "shown", which is what makes every config written before the base columns
  // were hideable still read correctly (nothing was hidden), and what makes a
  // base column added later default to on rather than silently missing.
  hiddenBase: string[];
  // Whether this form has an explicitly saved selection. `false` means nobody
  // has ever chosen (view_columns is NULL/unreadable), which is what lets a
  // caller apply its own default — e.g. the Submissions grid defaulting to the
  // staff-only columns rather than to every column.
  configured: boolean;
}

// Read the form's field columns + the stored view_columns preference.
//
// Three distinct cases, which callers depend on being distinguishable:
//   * view_columns is NULL / absent / unparseable -> not configured. Returns
//     every column key so an unconfigured grid falls back to showing everything
//     (the original safety rule).
//   * view_columns is a stored empty array -> configured with an empty
//     selection. Returns `viewKeys: []`. The caller decides what an empty
//     selection means; it must NOT be silently widened to "all", or a user who
//     unchecks every column would find them all back on the next visit.
//   * view_columns is a non-empty array -> the normalized keys. Configured keys
//     that no longer match an existing field (deleted fields) are dropped so the
//     config never references ghosts; if every entry was a ghost the selection
//     would silently become empty, so it falls back to all columns instead.
//
// There are also two readable *shapes*, told apart at parse time below:
//   * a bare array of field ids — everything written before the standard columns
//     became hideable, and the compact form field ids were always stored in.
//     Nothing was hidden, so `hiddenBase` is empty and the grid shows them all.
//   * an object { fields, hidden } — the current shape, carrying the hidden
//     standard columns alongside the same field ids.
// Both are accepted and neither is rewritten on read, so no migration is needed:
// a row keeps whatever shape it was written as until its owner next saves.
export async function getViewColumnsConfig(
  formId: number,
  userId: number
): Promise<ViewColumnsConfig> {
  const columns = await getExportColumns(formId);
  const allKeys = columns.map((c) => c.key);
  const rows = await execute<{ columns: string | null }>(
    `SELECT columns FROM dbo.user_form_view_columns
      WHERE form_id = @formId AND user_id = @userId`,
    { formId, userId }
  );
  const raw = rows[0]?.columns ?? null;
  if (!raw) {
    return { columns, viewKeys: allKeys, hiddenBase: [], configured: false };
  }
  let stored: unknown[] = [];
  let base: unknown[] = [];
  let parsedOk = false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      stored = parsed;
      parsedOk = true;
    } else if (parsed && typeof parsed === "object") {
      const obj = parsed as { fields?: unknown; hidden?: unknown };
      stored = Array.isArray(obj.fields) ? obj.fields : [];
      base = Array.isArray(obj.hidden) ? obj.hidden : [];
      parsedOk = true;
    }
  } catch {
    parsedOk = false;
  }
  if (!parsedOk) {
    return { columns, viewKeys: allKeys, hiddenBase: [], configured: false };
  }
  const hiddenBase = base.filter(
    (k): k is string => typeof k === "string" && BASE_COLUMN_KEY.test(k)
  );
  if (stored.length === 0) {
    return { columns, viewKeys: [], hiddenBase, configured: true };
  }
  // Normalize each stored entry to its `field_N` key. The stored array may
  // contain numeric ids (e.g. 10 -> field_10, as written by setViewColumns) or
  // already-normalized `field_N` strings. Unparseable/ghost entries are skipped.
  const existing = new Set(allKeys);
  const toKey = (k: unknown): string | null => {
    if (typeof k === "number" && Number.isInteger(k) && k >= 1) return `field_${k}`;
    if (typeof k === "string") {
      const m = k.match(/^field_(\d+)$/);
      if (m) return `field_${m[1]}`;
      if (/^\d+$/.test(k)) return `field_${Number(k)}`;
    }
    return null;
  };
  const viewKeys = stored
    .map(toKey)
    .filter((k): k is string => k !== null && existing.has(k));
  if (viewKeys.length === 0) {
    return { columns, viewKeys: allKeys, hiddenBase, configured: true };
  }
  return { columns, viewKeys, hiddenBase, configured: true };
}

// Persist one user's column selection for one form. viewKeys are `field_N`
// strings; stored as the JSON object { fields: [1,3,4], hidden: ["base_status"] }
// — the field ids as numbers, exactly as the array-only shape stored them, which
// is why an older row and a newer one normalize identically.
//
// `hiddenBase` holds the standard grid columns the user turned off. An empty
// array rather than an absent key, so "nothing hidden" is explicit and the
// reader never has to distinguish the two.
//
// An empty selection is stored as `{ fields: [] }`, NOT NULL. NULL means "never
// configured" and reads back as "show everything", so collapsing an empty
// selection to NULL would resurrect every column the user just turned off. The
// JSON string is truthy, so it survives the `if (!raw)` check above.
//
// Scoped by (user_id, form_id), so this can only ever write the caller's own
// row — it is not possible for one user's save to overwrite another's.
//
// Note this no longer touches dbo.forms.updated_at. It used to, because the
// selection was a column on the form; that also had the side effect of moving
// the form to the top of the admin Forms list every time someone opened and
// closed the column picker.
export async function setViewColumns(
  formId: number,
  userId: number,
  viewKeys: string[],
  hiddenBase: string[] = []
): Promise<void> {
  const ids = viewKeys
    .map((k) => k.match(/^field_(\d+)$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => Number(m[1]));
  await execute(dialect().upsertUserFormViewColumns(), {
    userId,
    formId,
    value: JSON.stringify({
      fields: ids,
      hidden: hiddenBase.filter((k) => BASE_COLUMN_KEY.test(k)),
    }),
  });
}

// -----------------------------------------------------------------------------
// Saved Reports views (dbo.report_views)
//
// A view belongs to exactly one user — every read and mutation is scoped by
// user_id in the WHERE clause, so a caller can never touch another user's row
// even if they guess the id.
// -----------------------------------------------------------------------------
export interface ReportViewRow {
  id: number;
  user_id: number;
  organization_id: number | null;
  name: string;
  form_id: number;
  // Parsed from the stored JSON. `filters` is an object (possibly empty);
  // `columns` is a `field_N` array or null meaning "all visible columns".
  filters: Record<string, unknown>;
  columns: string[] | null;
  format: string;
  is_default: boolean;
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface RawReportViewRow {
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

const REPORT_VIEW_COLUMNS = `id, user_id, organization_id, name, form_id, filters, columns,
        format, is_default, last_used_at, created_at, updated_at`;

function parseJsonRecord(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through — a corrupt blob degrades to "no filters"
  }
  return {};
}

function parseJsonKeyArray(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const keys = parsed.filter((k): k is string => typeof k === "string" && /^field_\d+$/.test(k));
      return keys.length ? keys : null;
    }
  } catch {
    // fall through
  }
  return null;
}

function toReportViewRow(r: RawReportViewRow): ReportViewRow {
  return {
    ...r,
    filters: parseJsonRecord(r.filters),
    columns: parseJsonKeyArray(r.columns),
    is_default: Boolean(r.is_default),
  };
}

export async function listReportViews(userId: number): Promise<ReportViewRow[]> {
  const rows = await execute<RawReportViewRow>(
    `SELECT ${REPORT_VIEW_COLUMNS} FROM dbo.report_views
     WHERE user_id = @userId
     ORDER BY is_default DESC, COALESCE(last_used_at, updated_at) DESC, name ASC`,
    { userId }
  );
  return rows.map(toReportViewRow);
}

export async function getReportView(id: number, userId: number): Promise<ReportViewRow | null> {
  const rows = await execute<RawReportViewRow>(
    `SELECT ${REPORT_VIEW_COLUMNS} FROM dbo.report_views
     WHERE id = @id AND user_id = @userId`,
    { id, userId }
  );
  return rows[0] ? toReportViewRow(rows[0]) : null;
}

// Look up a view by its (user-unique) name — used to return a friendly 409
// instead of letting the unique index throw a raw SQL error.
export async function findReportViewByName(
  userId: number,
  name: string
): Promise<ReportViewRow | null> {
  const rows = await execute<RawReportViewRow>(
    `SELECT ${REPORT_VIEW_COLUMNS} FROM dbo.report_views
     WHERE user_id = @userId AND name = @name`,
    { userId, name }
  );
  return rows[0] ? toReportViewRow(rows[0]) : null;
}

async function clearDefaultReportView(userId: number): Promise<void> {
  await execute(
    `UPDATE dbo.report_views SET is_default = 0, updated_at = SYSUTCDATETIME()
     WHERE user_id = @userId AND is_default = 1`,
    { userId }
  );
}

export async function createReportView(input: {
  userId: number;
  organizationId: number | null;
  name: string;
  formId: number;
  filters: Record<string, unknown>;
  columns: string[] | null;
  format: string;
  isDefault: boolean;
}): Promise<ReportViewRow> {
  if (input.isDefault) await clearDefaultReportView(input.userId);
  const rows = await execute<{ id: number }>(
    dialect().insertReturning({
      table: "report_views",
      columns: [
        "user_id",
        "organization_id",
        "name",
        "form_id",
        "filters",
        "columns",
        "format",
        "is_default",
      ],
      returning: ["id"],
      values: "@userId, @organizationId, @name, @formId, @filters, @columns, @format, @isDefault",
    }),
    {
      userId: input.userId,
      organizationId: input.organizationId,
      name: input.name,
      formId: input.formId,
      filters: JSON.stringify(input.filters ?? {}),
      columns: input.columns && input.columns.length ? JSON.stringify(input.columns) : null,
      format: input.format,
      isDefault: input.isDefault,
    }
  );
  const created = await getReportView(rows[0].id, input.userId);
  if (!created) throw new Error("Failed to load the created report view");
  return created;
}

export async function updateReportView(
  id: number,
  userId: number,
  patch: {
    name?: string;
    formId?: number;
    filters?: Record<string, unknown>;
    columns?: string[] | null;
    format?: string;
    isDefault?: boolean;
  }
): Promise<ReportViewRow | null> {
  if (patch.isDefault) await clearDefaultReportView(userId);

  const sets: string[] = ["updated_at = SYSUTCDATETIME()"];
  const p: Record<string, unknown> = { id, userId };
  if (patch.name !== undefined) {
    sets.push("name = @name");
    p.name = patch.name;
  }
  if (patch.formId !== undefined) {
    sets.push("form_id = @formId");
    p.formId = patch.formId;
  }
  if (patch.filters !== undefined) {
    sets.push("filters = @filters");
    p.filters = JSON.stringify(patch.filters ?? {});
  }
  if (patch.columns !== undefined) {
    sets.push("columns = @columns");
    p.columns = patch.columns && patch.columns.length ? JSON.stringify(patch.columns) : null;
  }
  if (patch.format !== undefined) {
    sets.push("format = @format");
    p.format = patch.format;
  }
  if (patch.isDefault !== undefined) {
    sets.push("is_default = @isDefault");
    p.isDefault = patch.isDefault;
  }

  const updated = await execute<{ id: number }>(
    dialect().updateReturning({
      table: "report_views",
      set: sets.join(", "),
      where: "id = @id AND user_id = @userId",
      returning: ["id"],
    }),
    p
  );
  if (!updated[0]) return null;
  return getReportView(id, userId);
}

export async function deleteReportView(id: number, userId: number): Promise<boolean> {
  const rows = await execute<{ id: number }>(
    dialect().deleteReturning({
      table: "report_views",
      where: "id = @id AND user_id = @userId",
      returning: ["id"],
    }),
    { id, userId }
  );
  return rows.length > 0;
}

export async function setDefaultReportView(id: number, userId: number): Promise<ReportViewRow | null> {
  const existing = await getReportView(id, userId);
  if (!existing) return null;
  await execute(
    `UPDATE dbo.report_views
     SET is_default = CASE WHEN id = @id THEN 1 ELSE 0 END, updated_at = SYSUTCDATETIME()
     WHERE user_id = @userId`,
    { id, userId }
  );
  return getReportView(id, userId);
}

// Stamp "last used" so the Reports page can auto-apply the most recent view.
export async function touchReportView(id: number, userId: number): Promise<void> {
  await execute(
    `UPDATE dbo.report_views SET last_used_at = SYSUTCDATETIME() WHERE id = @id AND user_id = @userId`,
    { id, userId }
  );
}
