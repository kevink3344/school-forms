import { getDialect } from "./dialect/index.js";
import type { Dialect } from "./dialect/types.js";
import { getClient, getDbKind } from "./driver/index.js";
import { expectedIndexNames, formatSubmissionPublicId } from "./schema.js";

// -----------------------------------------------------------------------------
// Thin facade over the active driver.
//
// This used to BE the Azure SQL pool. The connection work now lives in
// `driver/mssql.ts` (Azure SQL Serverless) and `driver/libsql.ts` (Turso), and
// this file keeps the lifecycle the rest of the app already depends on:
//
//   getClient()   the active DbClient            (was: getPool())
//   initDb()      connect + ensure schema, sets dbReady
//   isDbReady()   health-check gate
//   resetDbPool() drop the connection so the next call reconnects
//
// Schema creation and the one-time submission-id backfill are written against
// the DbClient interface, so they run unchanged on both dialects. The DDL comes
// from the active dialect: SQL Server replays its migration ladder, Turso
// creates the final shape directly.
// -----------------------------------------------------------------------------

let dbReady = false;
let initPromise: Promise<boolean> | null = null;

export { getClient, getDbKind };

// -----------------------------------------------------------------------------
// Initialize schema idempotently.
// -----------------------------------------------------------------------------
async function runDdl(): Promise<void> {
  const client = getClient();
  const dialect = getDialect(client.kind);

  // Additive columns are applied BOTH before and after the schema batch.
  //
  // Before: `ddl` is the FINAL schema, so it also declares the INDEXES — and an
  // index may name one of these late columns. libSQL executes the batch as one
  // transaction and refuses all of it if any single statement fails, so on a
  // database created before that column existed a `CREATE INDEX` on it does not
  // merely skip the index: it aborts the whole batch (CREATE TABLEs included) and
  // `initDb()` never sets dbReady, leaving the app unable to start at all.
  // Widening first is what keeps that index creatable.
  //
  // After: not redundant. `ALTER TABLE` cannot touch a table that does not exist
  // yet, so a brand-new database is widened only by the CREATE TABLE statements
  // themselves. The second pass guarantees every declared column is present
  // whichever path supplied it.
  await applyAddColumns(dialect);
  await client.run(dialect.ddl);
  await applyAddColumns(dialect);

  await backfillSubmissionIds();

  // Report only — a missing index must never stop the app from starting.
  try {
    await reportSkippedIndexes(dialect);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[db] Could not report skipped indexes: ${err instanceof Error ? err.message : err}`);
  }
}

// -----------------------------------------------------------------------------
// Report the index declarations the ladder had to skip.
//
// Some of the index guards in `schema.ts` skip their `CREATE INDEX` outright —
// that is what lets the app start against a database it did not create, where the
// string columns are `nvarchar(max)` and such an index is impossible. Skipping is
// invisible by nature, and several of those indexes are UNIQUE, so a skip
// silently drops a real business rule (one account per email address, one
// submission per public id). One line at boot is what makes the cost visible.
//
// The expected names are derived from the ladder itself, never listed here: a
// hand-copied list of the same names drifts as soon as somebody adds an index,
// and nothing reminds whoever added it that the copy exists.
// -----------------------------------------------------------------------------
async function reportSkippedIndexes(dialect: Dialect): Promise<void> {
  // SQL Server is the only dialect that can skip — its catalog is `sys.indexes`.
  // The libSQL path issues `CREATE INDEX IF NOT EXISTS` against the final shape,
  // so it never has this gap.
  if (getDbKind() !== "sqlserver") return;

  const expected = expectedIndexNames(dialect.ddl);
  if (expected.length === 0) return;

  const rows = await getClient().query<{ name: string }>(
    `SELECT name FROM sys.indexes WHERE name IN (${expected.map((name) => `'${name}'`).join(", ")})`
  );
  const present = new Set(rows.map((row) => row.name));
  const missing = expected.filter((name) => !present.has(name));
  if (missing.length === 0) return;

  // eslint-disable-next-line no-console
  console.warn(
    `[db] ${missing.length} index(es) the schema declares are MISSING and could not be created, ` +
      `because their key columns are not indexable as they stand (e.g. nvarchar(max)). ` +
      `Any uniqueness they enforced is NOT enforced: ${missing.join(", ")}`
  );
}

// Additive columns for databases created by an EARLIER version of the schema.
//
// SQL Server declares none — its ladder is `COL_LENGTH`-guarded, so the column
// arrives with the rest of the DDL. SQLite has no `ALTER TABLE ADD COLUMN IF NOT
// EXISTS`, so the column is added only when it is genuinely absent. That makes
// this safe on every boot, in either call position.
async function applyAddColumns(dialect: Dialect): Promise<void> {
  if (dialect.addColumns.length === 0) return;
  const client = getClient();
  for (const { table, column, definition } of dialect.addColumns) {
    // A table that does not exist yet is not an error, and must not be ALTERed:
    // `ddl` creates it with this column already in place. Skipping is what makes
    // the pre-batch call safe. (Both queries here are SQLite-specific and are only
    // ever reached when `addColumns` is non-empty, which means the Turso dialect.)
    const tableExists = await client.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = @table`,
      { table }
    );
    if (tableExists.length === 0) continue;

    const existing = await client.query<{ name: string }>(`PRAGMA table_info(${table})`);
    if (existing.some((c) => c.name === column)) continue;
    await client.run([`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`]);
  }
}

// One-time migration: convert legacy hex submission ids (`7bea...`) into the new
// incremental format (`CDM-00001`). It computes a per-form counter from the
// existing submission order and stamps both `public_id` and `submission_seq`.
// Guarded by `submission_seq IS NULL` (legacy rows only) so re-running is a no-op
// and never renumbers rows that already carry an incremental id.
//
// On a freshly-created Turso database this is always a no-op (no forms), and on a
// migrated one every row already carries a submission_seq.
async function backfillSubmissionIds(): Promise<void> {
  const client = getClient();
  const forms = await client.query<{
    id: number;
    code: string | null;
    submission_seq: number | null;
  }>(`SELECT id, code, submission_seq FROM dbo.forms ORDER BY id`);

  let backfilled = 0;
  for (const f of forms) {
    // Legacy rows are those not yet stamped with a submission_seq (the current
    // code stamps this column on insert, so new-format rows are excluded).
    const subs = await client.query<{ id: number }>(
      `SELECT id FROM dbo.submissions
       WHERE form_id = @formId AND submission_seq IS NULL
       ORDER BY submitted_at ASC, id ASC`,
      { formId: f.id }
    );
    if (!subs.length) continue;

    // Continue numbering from the form's current counter so we never collide
    // with already-allocated ids. The counter is the last number handed out.
    let seq = f.submission_seq || 0;
    for (const s of subs) {
      seq += 1;
      const publicId = formatSubmissionPublicId(f.code, seq);
      await client.query(
        `UPDATE dbo.submissions
         SET public_id = @publicId, submission_seq = @seq
         WHERE id = @id`,
        { id: s.id, seq, publicId }
      );
      backfilled += 1;
    }
    // Advance the form counter to the last allocated number so the next real
    // submission continues from here.
    if (seq > (f.submission_seq || 0)) {
      await client.query(`UPDATE dbo.forms SET submission_seq = @seq WHERE id = @formId`, {
        formId: f.id,
        seq,
      });
    }
  }
  if (backfilled > 0) {
    // eslint-disable-next-line no-console
    console.log(`[db] Backfilled ${backfilled} legacy submission id(s) to incremental format.`);
  }
}

// -----------------------------------------------------------------------------
// initDb — idempotent, sets dbReady. Call this from a background retry loop
// AFTER app.listen() so the server accepts health checks while warming up.
// -----------------------------------------------------------------------------
export function initDb(): Promise<boolean> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const kind = getDbKind();
      await getClient().query("SELECT 1 AS ok");
      await runDdl();
      dbReady = true;
      // eslint-disable-next-line no-console
      console.log(`[db] Database ready (mode=${kind}): tables/indexes ensured.`);
      return true;
    } catch (err) {
      dbReady = false;
      // eslint-disable-next-line no-console
      console.error(
        "[db] init failed, will retry:",
        err instanceof Error ? err.message : err
      );
      initPromise = null; // allow re-init on next call
      throw err;
    }
  })();
  return initPromise;
}

export function isDbReady(): boolean {
  return dbReady;
}

export function resetDbPool(): void {
  void getClient()
    .close()
    .catch(() => undefined);
  dbReady = false;
  initPromise = null;
}
