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
import { fieldAccessRoles, type Role } from "../db/schema.js";
import { listSubmissionValuesBatch } from "../db/queries.js";
import { parseTimestamp } from "../db/client.js";

// A column plus the numeric field id resolved from its `field_N` key. The field
// id is what submission values are matched on.
export interface ExportColumnWithFieldId {
  key: string;
  label: string;
  staff_only: boolean;
  roles: string[] | null;
  field_id: number;
}

// Filter export/report columns for the requesting role. Staff (and School
// Contacts) see public columns plus any staff-only column whose access roles
// include their own role (e.g. "staff" / "cdm_contact"). Admins see everything
// only when they opt into staff-only columns (includeStaffOnly); otherwise they
// see just the public columns — matching the historical default.
export function filterColumnsForRole<T extends { staff_only: boolean; roles: string[] | null }>(
  columns: T[],
  role: Role,
  includeStaffOnly: boolean
): T[] {
  if (role === "admin") {
    return columns.filter((c) => !c.staff_only || includeStaffOnly);
  }
  // Staff-like: visible when public, or its access roles grant this role.
  return columns.filter((c) => !c.staff_only || (fieldAccessRoles(c) ?? []).includes(role));
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
  for (const c of columns) byFieldId.set(String(c.field_id), c.key);

  const valuesBySubmission = await listSubmissionValuesBatch(submissions.map((s) => s.id));

  return submissions.map((s) => {
    const row: Record<string, unknown> = {
      submission_public_id: s.public_id,
      submitted_at: formatSubmittedAt(s.submitted_at),
      status: s.status,
    };
    for (const v of valuesBySubmission.get(s.id) ?? []) {
      const key = byFieldId.get(String(v.field_id));
      if (key) row[key] = v.value;
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
