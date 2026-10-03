// Shared types mirroring the backend API contract (server/src/db/schema.ts)

/**
 * A role key.
 *
 * This is `string`, NOT a union of the roles this installation happens to ship
 * with, because roles are admin-managed DATA: `dbo.roles` is the catalog and an
 * administrator can add a key from Settings → Roles at any time. A union would
 * be a claim baked in at module load, and it would make every new role fail to
 * compile rather than simply work.
 *
 * The consequence to keep in mind while reading this codebase: **a role literal
 * must never decide what an account may do.** `user.role === "admin"` is only
 * true for the role whose key literally is "admin", which answers "no" for a
 * role an administrator created and granted administrator power. Authority comes
 * from `User.capabilities`, which the server resolves from the catalog. A literal
 * is legitimate only for DISPLAY — ordering the built-ins, or choosing a fallback
 * badge for a role with none stored.
 */
export type Role = string;

export type FormStatus = "draft" | "published" | "archived";
export type SubmissionStatus = "submitted" | "in_review" | "flagged" | "completed";
export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "date"
  | "select"
  | "checkbox"
  | "radio"
  | "email"
  | "google_doc";

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
  description: string | null;
  doc_folder_id: string | null;
  active: boolean;
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

// Distinct grade-level/calendar values for the Schools page filter dropdowns
// (returned by /api/schools/facets).
export interface SchoolFacets {
  gradeLevels: string[];
  calendars: string[];
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
  // True when an administrator has issued a temporary password for this account
  // (POST /api/users/{id}/reset-password). The app refuses to render anything but
  // the change-password screen while this is set, so a temporary password cannot
  // quietly become a permanent one. Cleared by a successful password change.
  // See docs/plans/password-recovery.md.
  must_change_password: boolean;
  // What this account's role permits. RESOLVED BY THE SERVER from the role
  // catalog — never derived on the client from `role`, because the client's copy
  // was the one that decided where a signed-in account LANDED: a custom role sent
  // the browser to /login and the router bounced it back, an infinite loop.
  capabilities: Capabilities;
}

/**
 * The authority an account's role carries, resolved server-side.
 *
 * These are the ONLY sanctioned inputs to an authorization decision in the
 * client. Note the two that are not actions: `is_admin` is the broad grant
 * (users, schools, form authoring, settings) and `school_scoped` narrows every
 * read to the account's own school.
 *
 * An unknown role resolves to the restrictive answer for both, so a typo in a
 * role key yields an account that can do nothing rather than one that can do
 * everything.
 */
export interface Capabilities {
  view: boolean;
  edit: boolean;
  export: boolean;
  report: boolean;
  is_admin: boolean;
  school_scoped: boolean;
}

/**
 * A row of the role catalog (`dbo.roles`), as returned by the /api/roles
 * endpoints — a mirror of `RoleRow` in server/src/db/schema.ts.
 *
 * `built_in` means the boot ladder seeds this row and re-derives its six
 * security flags at every start, so its capabilities are not editable and it is
 * never deletable (an installation with zero administrators must not be able to
 * delete `admin`). `label`, `description` and `badge` are display-only, carry no
 * authority, and ARE editable on a built-in.
 *
 * `badge` holds a bare CSS suffix ("orange", "teal", …), not a class name; the
 * client renders `badge badge-${badge}`. It is `null` on every seeded row — the
 * seed never sets it — so a reader must have a fallback rather than assuming a
 * stored value.
 */
export interface RoleRow {
  id: number;
  role_key: string;
  label: string;
  description: string | null;
  badge: string | null;
  can_view: boolean;
  can_edit: boolean;
  can_export: boolean;
  can_report: boolean;
  school_scoped: boolean;
  is_admin: boolean;
  built_in: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Where a role is referenced, counted across all five channels.
 *
 * Counted rather than merely detected, because "in use" without a number is
 * unactionable — an administrator cannot tell a stale experiment from 40 live
 * accounts. It exists because the foreign key covers only the first of the five:
 * form-field access lists, message audiences, menu items and the Documents Link
 * setting each store role keys inside JSON, with no constraint behind them.
 */
export interface RoleUsage {
  users: number;
  form_fields: number;
  system_messages: number;
  menu_items: number;
  documents_link: number;
}

/** Response of GET /api/roles/:key/usage (administrator-only). */
export interface RoleUsageReport {
  role_key: string;
  built_in: boolean;
  usage: RoleUsage;
  total: number;
  // The sentence a DELETE would refuse with, or `null` when nothing references
  // the role. Composed by the SAME helper the 409 uses, so a disabled Delete
  // button and the error behind it cannot disagree. Render this rather than
  // re-writing the wording in the browser.
  usage_message: string | null;
}

// Login modes selectable in Settings → Login Mode (and stored in app_settings).
export type LoginMode = "select" | "password" | "maintenance";

// App setting keys the client can read/write. `documents_link` stores a JSON
// role array; `login_mode` / `maintenance_message` back the Login Mode feature.
export type AppSettingKey = "login_mode" | "maintenance_message" | "documents_link" | "menu_items";

// A user row for the select-mode login dropdown (no password hash, no school).
export interface LoginUser {
  id: number;
  display_name: string;
  email: string;
  role: Role;
}

// Public login-page stat counts (org-scoped), returned by /api/health/stats.
export interface LoginStats {
  users: number;
  schools: number;
  submissions: number;
}

// User row as returned by the admin /api/users endpoints — enriched with the
// school's display name (null for admins with no school) and the active flag.
export interface AdminUser extends User {
  school_name: string | null;
  organization_name: string | null;
  organization_slug: string | null;
  active: boolean;
  // Whether the account is offered in the select-mode ("Test") login dropdown.
  // Server defaults it to false, so it must be opted into per user.
  show_on_test_screen: boolean;
  must_change_password: boolean;
  created_at: string;
}

// Response of POST /api/users/{id}/reset-password. `temporary_password` is
// returned exactly once and cannot be retrieved again — the server keeps only the
// bcrypt hash — so the UI must show it before the dialog closes.
export interface ResetPasswordResult {
  id: number;
  email: string;
  display_name: string;
  temporary_password: string;
  must_change_password: boolean;
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
  // The status this form held immediately before it was archived, so Restore can
  // return it to exactly that state. Non-null only while `status` is "archived".
  pre_archive_status: FormStatus | null;
  code: string | null;
  submission_seq: number;
  // Per-form Google Drive parent folder for generated documents. NULL falls back
  // to the global env folder (see server google/docs.ts).
  doc_folder_id: string | null;
  // Optional link to the source Google Form this form mirrors. Shown to staff so
  // they can open it. Purely informational — no API integration.
  google_form_url: string | null;
  // Who may READ this form's results (docs/plans/public-private-forms.md).
  // `private` hides it from the organization's School Contacts unless they hold
  // an approved grant; administrators and staff are unaffected either way.
  visibility: FormVisibility;
  // Number of submissions attached to this form. Present on list responses so
  // the admin Forms list can gate the Delete action (used forms can't be deleted).
  submission_count?: number;
  created_at: string;
  updated_at: string;
}

// Who may read a form's results. `public` is the default and the value of every
// form that predates the column.
export type FormVisibility = "public" | "private";

// The caller's relationship to a form, as returned by GET /api/forms/available.
//
// ★ DERIVED by the server from the same predicate every other query uses — the
// client must never compute this from `visibility`, or there are two visibility
// implementations and they will disagree.
export type FormAccess = "granted" | "none" | "pending" | "denied";

/** One row of the Available Forms page. */
export interface AvailableForm {
  id: number;
  title: string;
  description: string | null;
  code: string | null;
  access: FormAccess;
  /** Only on a granted row: why it is readable. */
  reason?: "role" | "public" | "grant";
  requested_at?: string;
  decided_at?: string | null;
  note?: string | null;
  /** The latest audit event, so the UI can say "declined" vs "access removed". */
  last_event?: string | null;
}

/** One row of the admin access-request queue. */
export interface AccessRequestRow {
  user_id: number;
  form_id: number;
  status: "pending" | "approved" | "denied";
  source: string;
  requested_at: string;
  decided_at: string | null;
  decided_by: number | null;
  note: string | null;
  user_name: string | null;
  user_email: string | null;
  form_title: string | null;
  form_code: string | null;
  school_name: string | null;
}

/** One audit event in an account's history for a form. */
export interface AccessEventRow {
  id: number;
  event: string;
  actor_id: number | null;
  actor_name: string | null;
  note: string | null;
  created_at: string;
}

/** One account's relationship to a form, with its full history. */
export interface AccessGrantRow {
  user_id: number;
  user_name: string | null;
  user_email: string | null;
  school_name: string | null;
  status: "pending" | "approved" | "denied" | null;
  source: string | null;
  decided_at: string | null;
  note: string | null;
  events: AccessEventRow[];
}

/**
 * One access row belonging to ONE account, for the admin's Edit User drawer.
 *
 * ★ This is "grants that exist for this account", not "forms this person can
 * read". The two differ for a staff or admin account, which is exempt by rule
 * and normally holds no row at all — so its list is legitimately empty.
 */
export interface UserAccessRow {
  form_id: number;
  form_title: string | null;
  form_code: string | null;
  form_visibility: FormVisibility | null;
  status: "pending" | "approved" | "denied";
  source: string;
  requested_at: string;
  decided_at: string | null;
  decided_by: number | null;
  note: string | null;
  last_event: string | null;
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
  school_year: string | null;
  // Staff-only fields audit trail (null until a staff-only save happens).
  staff_fields_updated_by: number | null;
  staff_fields_updated_at: string | null;
  // Archive trail. Archiving is its OWN axis, deliberately not a `status` value:
  // an archived row keeps its workflow status (submitted / in_review / …), so
  // restoring it returns it exactly as it was. Null on every active row.
  archived_at: string | null;
  archived_by: number | null;
  // Display name of the admin who archived it (detail endpoint only).
  archived_by_name?: string | null;
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

// Result of promoting a captured ad-hoc field to a real form field
// (docs/plans/google-form-undefined-fields.md §11). The promoted answer moves out
// of `adhocFields` and into `values`, which is why the whole submission comes
// back rather than the new field alone.
export interface PromoteAdhocResult {
  // The `form_fields` row that was created.
  field: FormField;
  // How many submissions had their captured answer migrated — this one included,
  // and every other submission of the same form with the same question title.
  migrated_submissions: number;
  // The submission, re-read after the move.
  submission: SubmissionDetail;
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
  // The underlying form-field type. Carried with the column so a grid can render
  // and edit a value without a second, admin-only call to GET /api/forms/:id.
  type: FieldType;
  options: string[] | null;
}

export interface ExportPreview {
  columns: ExportColumn[];
  rows: Record<string, unknown>[];
  total: number;
}

// Per-user, per-form config returned by GET/PUT /api/forms/:id/columns — which
// subset of columns this user's Submissions grid shows. Everyone with access to
// the form (admin, staff, School Contact) may keep their own selection; nobody
// can see or overwrite anyone else's. `viewKeys` defaults to all keys when this
// user has no saved config. Export is separate and always shows all columns.
//
// `configured` distinguishes "this user has not chosen yet" (false, and viewKeys
// is every column) from "the user deliberately chose nothing" (true, viewKeys is
// empty). Only the former should trigger a caller's own default — otherwise
// unchecking every column would silently turn them all back on.
export interface ViewColumnsConfig {
  columns: ExportColumn[];
  viewKeys: string[];
  // The standard grid columns this user has turned OFF, as `base_*` keys. Empty
  // for any config saved before those columns became hideable — absence means
  // "shown", so an old config and a base column added later both default to on.
  // Student / School is never listed; it is the grid's identity column.
  hiddenBase: string[];
  configured: boolean;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export type ReportFormat = "csv" | "xlsx" | "pdf";

// The filter subset a Saved View persists. `columns` lives alongside (not inside)
// the filters because it is stored in its own column on dbo.report_views.
export interface ReportFilters {
  school_id?: number | null;
  status?: SubmissionStatus | null;
  from?: string | null;
  to?: string | null;
  q?: string | null;
  include_staff_only?: boolean;
}

// The full report query: the filter set plus which columns to render and in
// what order. Both the preview grid and every export are built from this.
export interface ReportQuery extends ReportFilters {
  form_id: number;
  columns?: string[] | null;
}

// Response from GET /api/reports/preview — exactly the rows the export contains.
export interface ReportPreview {
  form_id: number;
  form_title: string;
  // True when the caller is locked to their own school (staff / School Contact).
  school_scoped: boolean;
  columns: ExportColumn[];
  rows: Record<string, unknown>[];
  total: number;
}

// A saved report configuration, owned by exactly one user.
export interface ReportView {
  id: number;
  name: string;
  form_id: number;
  filters: ReportFilters;
  // null means "all columns currently visible to the user".
  columns: string[] | null;
  format: ReportFormat;
  is_default: boolean;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReportViewInput {
  name: string;
  form_id: number;
  filters: ReportFilters;
  columns: string[] | null;
  format: ReportFormat;
  is_default?: boolean;
}

// ---------------------------------------------------------------------------
// Webhook intake log (docs/plans/webhook-log.md)
//
// Every inbound Google Forms webhook attempt is recorded, succeeded or failed
// (Q1), and this is the admin-only read side of it. `payload_raw` is never part
// of a list row — a page of 100 failures must not ship 100 verbatim payloads to
// the browser — so it appears only on the detail type, fetched when the drawer
// is opened or a replay is requested.
// ---------------------------------------------------------------------------

export type WebhookEventStatus = "succeeded" | "failed";

// Why the secret check went the way it did. "missing" is a misconfigured Apps
// Script, "invalid" is a rotated secret — the distinction is the first thing an
// admin needs.
export type WebhookAuthResult = "ok" | "invalid" | "missing";

// A machine-readable reason, kept separate from the HTTP status so the UI can say
// "arrived while the form was unpublished" rather than "Form is not accepting
// submissions". This is also what makes the failed rows replayable: a
// `form_not_published` response becomes deliverable once the form is published.
export type WebhookErrorCode =
  | "unauthorized"
  | "invalid_body"
  | "form_not_found"
  | "form_not_published"
  | "internal_error";

export interface WebhookEventRow {
  id: number;
  source: string;
  received_at: string;
  remote_ip: string | null;
  user_agent: string | null;
  auth_result: WebhookAuthResult;
  status: WebhookEventStatus;
  http_status: number;
  error_code: WebhookErrorCode | null;
  error: string | null;
  form_id: number | null;
  /** NULL means "could not be attributed to an organization" — such a row is
   *  visible only as the `unattributed` count, never in a list. */
  organization_id: number | null;
  submission_id: number | null;
  public_id: string | null;
  payload_bytes: number | null;
  payload_hash: string | null;
  /** Set on the row a replay created, pointing at the attempt it retried. */
  replay_of: number | null;
  replayed_by: number | null;
  // Joined for display — the row survives the deletion of either one.
  form_title: string | null;
  form_code: string | null;
  replayed_by_name: string | null;
  /** Whether a payload is stored, so the grid can decide whether Replay is
   *  available without fetching any payloads. */
  payload_present: boolean;
  /** Whether a SUCCEEDING replay already exists. Replay is one-shot (Q5). */
  has_replay: boolean;
}

export interface WebhookEventDetail extends WebhookEventRow {
  payload_raw: string | null;
}

export interface WebhookEventStats {
  succeeded: number;
  failed: number;
  total: number;
}

export interface WebhookRetention {
  rows: number;
  /** Row count above which the page shows a "consider trimming" warning (Q8). */
  threshold: number;
  warning: boolean;
}

export interface WebhookEventPage {
  events: WebhookEventRow[];
  stats: WebhookEventStats;
  /** Attempts no organization owns. Reported as a bare count so they are never
   *  silently missing from the feature whose job is to be complete. */
  unattributed: number;
  retention: WebhookRetention;
}

export interface WebhookEventSummary {
  days: number;
  /** The trailing-window counters for the dashboard (Q9). */
  window: { succeeded: number; failed: number };
  /** Per-form counters, or null when no form was asked about. Drives the
   *  republish prompt (Q4). */
  form: { form_id: number; succeeded: number; failed: number; total: number } | null;
  unattributed: number;
  retention: WebhookRetention;
}

export interface WebhookReplayResult {
  id: number;
  /** "skipped" means the row was ineligible (already replayed, no payload, or
   *  not in the caller's organization) rather than that delivery failed. */
  status: "succeeded" | "failed" | "skipped";
  public_id: string | null;
  error_code: string | null;
  error: string | null;
}

export interface WebhookBulkReplayResult {
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: WebhookReplayResult[];
}

export interface WebhookEventQuery {
  status?: WebhookEventStatus;
  auth_result?: WebhookAuthResult;
  form_id?: number;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * A System Message — an administrative banner shown to every user in an
 * organization until each one closes it out (Settings → System Messages).
 *
 * Mirrors `SystemMessage` in server/src/db/schema.ts, with the two timestamps
 * as the ISO strings JSON actually carries (the server-side interface calls
 * them `Date` because that is what the query layer parses them into before
 * serializing).
 *
 * `audience` is the API contract; the DB column behind it is a JSON string.
 * Every server reader goes through `toSystemMessage`, which runs the stored value
 * through `messageAudienceRoles()`. So the three states are:
 *   - `null` → EVERYONE, including roles created later. This is a NULL column
 *     (or an absent/corrupt one), and it is what a message authored before
 *     audiences existed reads back as.
 *   - `[]` → nobody sees it. The only way to write a message that is authored but
 *     not delivered.
 *   - a subset → those roles, and only those.
 *
 * ★ `null` is load-bearing and must NOT be flattened into the full roster of
 * built-in roles. `messageAudienceRoles` used to return the roles that existed
 * when it ran, which froze an unset audience at that moment: a role created
 * afterwards could not see a message nobody had narrowed. Checking
 * `audience !== null && audience.includes(role)` is the correct test;
 * `audience.length` cannot distinguish "everyone" from "nobody" once null is in
 * play, so never use a length as the test.
 */
export interface SystemMessage {
  id: number;
  organization_id: number;
  title: string;
  body: string;
  active: boolean;
  audience: string[] | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}
