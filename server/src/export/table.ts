// -----------------------------------------------------------------------------
// Shared export/report table helpers.
//
// Extracted from routes/export.ts so that BOTH the legacy `/api/export/*` router
// and the new `/api/reports/*` router build their tables the same way. Keeping a
// single implementation is what guarantees "what you see is what you export":
// the preview grid and every writer (CSV / XLSX / PDF) consume the same rows.
//
// The behavior here is intentionally identical to the code that used to live in
// routes/export.ts — moving it must not change the CSV output by a single byte.
// -----------------------------------------------------------------------------
import { fieldAccessRoles } from "../db/schema.js";
import { listSubmissionValuesBatch, type ExportColumn } from "../db/queries.js";
import { parseTimestamp } from "../db/client.js";

// A column plus the numeric field id resolved from its `field_N` key. The field
// id is what submission values are matched on.
//
// Derived from the real column shape rather than re-declared: an earlier revision
// repeated the fields by hand and left out `type` and `options`, so
// `/api/reports/preview` could not type-check sending them even though the value
// it held had carried them all along (getExportColumns always sets both). A
// subset re-declaration does not fail — it just quietly makes part of the value
// unreachable to everything downstream.
export interface ExportColumnWithFieldId extends ExportColumn {
  field_id: number;
}

// Filter export/report columns for the requesting role. Staff (and School
// Contacts) see public columns plus any staff-only column whose access roles
// include their own role (e.g. "staff" / "cdm_contact"). A staff-only column
// whose access list is UNSET (`null`) is unrestricted, so every role sees it —
// including a role an admin creates after the column was written. Admins see
// everything only when they opt into staff-only columns (includeStaffOnly);
// otherwise they see just the public columns — matching the historical default.
//
// `role` is a plain string, not the `Role` union: roles are data now, so a
// custom role must be able to flow through here without a cast.
export function filterColumnsForRole<T extends { staff_only: boolean; roles: string[] | null }>(
  columns: T[],
  role: string,
  includeStaffOnly: boolean
): T[] {
  if (role === "admin") {
    return columns.filter((c) => !c.staff_only || includeStaffOnly);
  }
  // Staff-like: visible when public, or when its access roles grant this role or
  // are unset (unrestricted).
  return columns.filter((c) => {
    if (!c.staff_only) return true;
    const allowed = fieldAccessRoles(c);
    return allowed === null || allowed.includes(role);
  });
}

// Resolve the numeric field id encoded in a `field_N` key (0 when malformed).
export function withFieldId<T extends { key: string }>(columns: T[]): (T & { field_id: number })[] {
  return columns.map((c) => {
    const m = /^field_(\d+)$/.exec(c.key);
    return { ...c, field_id: m ? Number(m[1]) : 0 };
  });
}

// Date formatter — renders submission timestamps as "8/27/2026, 9:52:20 AM"
// in the school's local timezone (America/New_York), independent of the
// server's configured timezone (Azure may run in UTC).
//
// ⚠ `Intl.DateTimeFormat#format` coerces its argument with ToNumber, so handing
// it a STRING throws `RangeError: Invalid time value`. Every caller here passes a
// value straight out of the data layer, and a host whose timestamp columns hold
// TEXT hands back strings — production served 18 rows whose `submitted_at` was
// `"2026-09-21T15:39:12.080"`, and one such row was enough to turn
// `/api/reports/preview` and both `/api/export/*` formats into
// `500 {"error":"Invalid time value"}`. So this accepts whatever arrives and
// never throws.
//
// An unparseable value is returned unchanged rather than replaced by a
// placeholder: showing the raw timestamp is strictly more useful than a blank
// cell, and it keeps the bad value visible instead of hiding it behind a 500.
const submittedAtFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "numeric",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});
export function formatSubmittedAt(value: unknown): string {
  if (value === null || value === undefined) return "";
  const date = parseTimestamp(value);
  if (date) return submittedAtFormatter.format(date);
  return typeof value === "string" ? value : "";
}

// CSV escaping helper.
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (typeof value === "object") {
    s = JSON.stringify(value);
  } else {
    s = String(value);
  }
  // Wrap in quotes if it contains commas, quotes, or newlines
  const needsQuote = /[",\n\r]/.test(s);
  if (needsQuote) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// -----------------------------------------------------------------------------
// Google Drive document answers.
//
// ★ `drive.google.com/file/d/`, NOT `docs.google.com/document/d/` — a Google Forms
// file UPLOAD stores a binary file in Drive, not a Google Doc, and the two paths
// are not interchangeable. Measured against the Drive API with this app's own
// credentials, reading each file's own `webViewLink`:
//
//   application/pdf                        -> drive.google.com/file/d/<id>/view
//   application/vnd.google-apps.document   -> docs.google.com/document/d/<id>/edit
//
// ★ The URL template is DUPLICATED from client/src/lib/googleDoc.ts, because the
// server cannot import from the client and the client cannot import from here.
// `google-doc-field.test.ts` asserts the two are byte-identical — a hand-copy is
// acceptable only when a gate diffs it against its source, which is the same
// technique MENU_ITEM_KEYS <-> MENU_ITEMS and the two dialects' index lists use.
// -----------------------------------------------------------------------------
export const GOOGLE_DOC_URL_PREFIX = "https://drive.google.com/file/d/";
export const GOOGLE_DOC_URL_SUFFIX = "/view";

/** The Docs viewer URL for a Drive document id. */
export function googleDocUrl(id: string): string {
  return `${GOOGLE_DOC_URL_PREFIX}${encodeURIComponent(id)}${GOOGLE_DOC_URL_SUFFIX}`;
}

/**
 * A google_doc answer as exportable TEXT.
 *
 * ★ A CSV cell has no hyperlink concept and (per the plan's Q2 answer) XLSX does
 * not get one either, so every writer receives the URL as plain text — which a
 * spreadsheet auto-links on paste. That keeps all three writers identical, which
 * is the "what you see is what you export" invariant this module exists for.
 *
 * ★ Multiple ids are joined with a SPACE, never a comma: a comma is the CSV
 * delimiter (so it would need quoting) and a comma-joined list of URLs reads as
 * one URL. A space-joined list is the honest representation — a spreadsheet
 * links the first and leaves the rest readable.
 *
 * A value that is already an absolute http(s) URL is passed through unchanged, so
 * a form whose script was changed to send a URL does not get double-wrapped.
 */
export function googleDocExportText(value: unknown): string {
  const ids = googleDocIds(value);
  return ids.map((id) => (isAbsoluteHttpUrl(id) ? id : googleDocUrl(id))).join(" ");
}

/**
 * The document ids carried by a google_doc answer, in order.
 *
 * Handles BOTH shapes the webhook can produce: an array (a Google Forms
 * file-upload question) and a bare string (a short-answer question). Splits a
 * string on whitespace and commas so a hand-typed list works too. Blank entries
 * are dropped so a trailing empty answer does not render a dead link.
 */
export function googleDocIds(value: unknown): string[] {
  const raw: string[] = Array.isArray(value)
    ? value.map((v) => String(v))
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : [];
  return raw.map((s) => s.trim()).filter((s) => s !== "");
}

/** True only for an absolute http(s) URL — never for `javascript:` or `data:`. */
export function isAbsoluteHttpUrl(v: string): boolean {
  return /^https?:\/\//i.test(v);
}

// -----------------------------------------------------------------------------
// Row building
// -----------------------------------------------------------------------------
export interface ExportSourceSubmission {
  id: number;
  public_id: string;
  // Declared as `Date` because that is what the normalised contract promises,
  // but the reported value comes from the driver untouched — so a host whose
  // column holds TEXT really does put a string here. `formatSubmittedAt`
  // tolerates both; the type says so rather than pretending otherwise.
  submitted_at: Date | string;
  status: string;
}

// Build the exportable rows for a set of submissions + columns. Values are
// fetched in bulk (chunked IN clauses) instead of one query per submission, so a
// large report doesn't turn into an N+1 storm.
export async function buildExportRows(
  columns: ExportColumnWithFieldId[],
  submissions: ExportSourceSubmission[]
): Promise<Record<string, unknown>[]> {
  // Key BOTH sides by string. The row types claim `number`, but a driver that
  // hands back TEXT ids returns `"30"`, and `Map<number, …>.get("30")` misses
  // silently — every answer column would come back blank with no error at all,
  // a worse failure than the 500 this change fixes.
  const byFieldId = new Map<string, string>();
  // The field's control type, keyed the same way, so a google_doc answer can be
  // rendered as its URL here rather than by each of the three writers.
  const typeByFieldId = new Map<string, string>();
  for (const c of columns) {
    byFieldId.set(String(c.field_id), c.key);
    typeByFieldId.set(String(c.field_id), c.type);
  }

  const valuesBySubmission = await listSubmissionValuesBatch(submissions.map((s) => s.id));

  return submissions.map((s) => {
    const row: Record<string, unknown> = {
      submission_public_id: s.public_id,
      submitted_at: formatSubmittedAt(s.submitted_at),
      status: s.status,
    };
    for (const v of valuesBySubmission.get(s.id) ?? []) {
      const idKey = String(v.field_id);
      const key = byFieldId.get(idKey);
      if (!key) continue;
      // ★ Rendered HERE, where the column's type is known, rather than in
      // `cellText`/`csvEscape`, which receive only the value. A google_doc answer
      // is stored as the bare id(s); the URL is derived so the export matches what
      // the grid shows.
      row[key] =
        typeByFieldId.get(idKey) === "google_doc" ? googleDocExportText(v.value) : v.value;
    }
    return row;
  });
}

// -----------------------------------------------------------------------------
// Neutral table model shared by every writer (CSV / XLSX / PDF).
// -----------------------------------------------------------------------------
export interface TableHeader {
  header: string;
  key: string;
}

export interface TableModel {
  headers: TableHeader[];
  rows: Record<string, unknown>[];
  // Optional caption metadata used by the PDF letterhead.
  title?: string;
  subtitle?: string;
}

// The three identifier columns always lead the export, in this order.
export const BASE_HEADERS: TableHeader[] = [
  { header: "submission_public_id", key: "submission_public_id" },
  { header: "submitted_at", key: "submitted_at" },
  { header: "status", key: "status" },
];

// Compose the final header list: base columns first, then the selected form
// columns labelled by their human-readable label but keyed by `field_N`.
export function buildTableModel(
  columns: { key: string; label: string }[],
  rows: Record<string, unknown>[],
  meta: { title?: string; subtitle?: string } = {}
): TableModel {
  return {
    headers: [...BASE_HEADERS, ...columns.map((c) => ({ header: c.label, key: c.key }))],
    rows,
    ...meta,
  };
}

// Render a cell for display in a table (used by the PDF writer).
export function cellText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
