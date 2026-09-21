// -----------------------------------------------------------------------------
// DbClient — the one seam every DB call in the app flows through.
//
// Two implementations exist: driver/mssql.ts (Azure SQL Server, the live
// production path) and driver/libsql.ts (Turso / libSQL). Both are selected at
// boot from `env.dbMode` by driver/index.ts.
//
// Design rules (see docs/plans/dual-db.md §8):
//  - `query()` is dialect-neutral: named `@param` placeholders, row array back.
//  - The SQL Server implementation is behaviourally identical to the original
//    `pool.ts` — including the Azure Serverless retry/backoff, which must not be
//    "cleaned up" in passing.
//  - Statements written for SQL Server use `dbo.` and `SYSUTCDATETIME()`. The
//    libSQL driver rewrites those two literal tokens on the way in, so the
//    shared SQL needs no per-dialect edits (§8.4a).
// -----------------------------------------------------------------------------

export type DbKind = "sqlserver" | "turso";

export type DbParams = Record<string, unknown>;

export interface DbClient {
  readonly kind: DbKind;

  /** Run a single statement and return its rows. */
  query<T = unknown>(sql: string, params?: DbParams): Promise<T[]>;

  /**
   * Run a batch of statements. Used for DDL and the one-time bulk import.
   * SQL Server runs them sequentially on one request; libSQL runs them in a
   * single write transaction.
   */
  run(statements: string[]): Promise<void>;

  /**
   * Run `fn` inside a write transaction, handing it a transaction-scoped client.
   * Commit on resolve, roll back on throw.
   */
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;

  /** Release the underlying connection / pool. */
  close(): Promise<void>;
}

// -----------------------------------------------------------------------------
// Boolean columns — declared BOOLEAN in the Turso DDL so `ResultSet.columnTypes`
// reports them, and named here so the driver can still normalise when a
// `columnTypes` entry is missing (older/newer drivers, or a computed column).
// SQL Server's `BIT` comes back as a real boolean; SQLite's 0/1 must not.
// -----------------------------------------------------------------------------
export const BOOLEAN_COLUMNS: ReadonlySet<string> = new Set([
  "active",
  "required",
  "staff_only",
  "is_default",
  "show_on_test_screen",
]);

// -----------------------------------------------------------------------------
// Timestamp columns — `DATETIME2` on SQL Server, `TEXT` holding fixed-width
// ISO-8601 UTC on Turso. `mssql` hands back a real `Date`; libSQL hands back the
// string. Left alone, the API layer would see a `Date` in one mode and a string
// in the other, and anything calling a `Date` method throws
// `RangeError: Invalid time value` — which is exactly how the export and report
// preview endpoints failed on Turso.
//
// Converting is safe for the wire format: `JSON.stringify` renders a `Date` as
// `toISOString()`, the same fixed-width string the Turso DDL writes, so the two
// modes emit byte-identical JSON.
//
// ⚠ Keep this list in step with the Turso DDL (`dialect/turso.ts`). Every
// timestamp column there is covered; nothing else is, deliberately —
// `school_year` is a plain string (`"2026-2027"`) that must never become a Date.
// -----------------------------------------------------------------------------
export const TIMESTAMP_COLUMNS: ReadonlySet<string> = new Set([
  "created_at",
  "updated_at",
  "submitted_at",
  "last_used_at",
  "staff_fields_updated_at",
  "received_at",
]);

/**
 * The fixed-width ISO-8601 form the Turso DDL writes and the migration script
 * copies (`2026-09-15T02:33:35.273Z`), with the trailing `Z` **optional**.
 *
 * The `Z` used to be required. It no longer is: production holds rows whose
 * `submitted_at` is that same string with the `Z` missing
 * (`2026-09-21T15:39:12.080`), written by an earlier build whose SQLite default
 * omitted it and preserved in the database since. Demanding the `Z` left those
 * rows as strings, which is how `/api/reports/preview` reached
 * `Intl.DateTimeFormat.format(string)` and threw `RangeError: Invalid time
 * value` on a host whose other rows were fine.
 *
 * Everything else — second-precision, an explicit offset, a user-entered value
 * that merely looks date-ish — is still left as a string rather than turning
 * into an `Invalid Date`.
 */
const ISO_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z)?$/;

/**
 * Parse a timestamp that may be a real `Date` (SQL Server `DATETIME2`), one of
 * the ISO-8601 strings above (Turso, or any column created as text), or epoch
 * milliseconds. Returns `null` for anything else, so a caller can decide what to
 * do rather than being handed an `Invalid Date` that throws the moment it is
 * used.
 *
 * An offset-less string is read as **UTC**. The app only ever writes UTC
 * (`SYSUTCDATETIME()`, `strftime(…,'now')`, `Date#toISOString()`), so reading a
 * bare value as local time would shift it by the server's own offset and make
 * the rendered time depend on which machine happened to run the query.
 */
export function parseTimestamp(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  // Epoch milliseconds, which is what a JSON payload or a numeric column
  // carries. A non-finite or out-of-range number is `null`, not an Invalid Date.
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }
  if (typeof value !== "string") return null;
  const match = ISO_UTC_INSTANT.exec(value);
  if (!match) return null;
  const parsed = new Date(match[1] ? value : `${value}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// -----------------------------------------------------------------------------
// Parameter normalisation, shared by both drivers.
//
// `undefined` is rejected by both `mssql` and libSQL, and libSQL serialises a
// bound JS `Date` as an epoch *number* (verified — `1789439615279.0`), which
// would land a numeric string in a TEXT timestamp column. Convert dates to the
// same ISO-8601 `…Z` form the DDL `DEFAULT` writes, and null out `undefined`.
// -----------------------------------------------------------------------------
export function normalizeParamValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

// Normalise one row using the declared column types when the driver reports
// them, falling back to the known-boolean-column list, and restore real `Date`s
// for timestamp columns so both drivers hand the app the same shapes.
//
export function normalizeRow(
  row: Record<string, unknown>,
  columnTypes?: readonly string[]
): Record<string, unknown> {
  const keys = Object.keys(row);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = row[key];
    if (value === null || value === undefined) continue;

    // A SQL Server `DATETIME2` already arrives as a `Date`, so this is a no-op
    // there and only fires on a text timestamp column. A string that is not the
    // recognised shape falls through untouched rather than becoming an Invalid
    // Date.
    if (typeof value === "string" && TIMESTAMP_COLUMNS.has(key)) {
      const parsed = parseTimestamp(value);
      if (parsed) {
        row[key] = parsed;
        continue;
      }
    }

    const declared = columnTypes?.[i];
    const isBooleanColumn = declared
      ? /^BOOL/i.test(declared)
      : BOOLEAN_COLUMNS.has(key);

    if (isBooleanColumn && (value === 0 || value === 1)) {
      row[key] = value === 1;
    }
  }
  return row;
}
