import { getDialect } from "./dialect/index.js";
import { getClient, getDbKind } from "./driver/index.js";
import { formatSubmissionPublicId } from "./schema.js";

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
// from the active dialect: SQL Server replays its 39-statement migration ladder,
// Turso creates the final shape directly.
// -----------------------------------------------------------------------------

let dbReady = false;
let initPromise: Promise<boolean> | null = null;

export { getClient, getDbKind };

// -----------------------------------------------------------------------------
// Initialize schema idempotently.
// -----------------------------------------------------------------------------
async function runDdl(): Promise<void> {
  const client = getClient();
  await client.run(getDialect(client.kind).ddl);
  await backfillSubmissionIds();
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
