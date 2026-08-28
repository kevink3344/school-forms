import sql, { type ConnectionPool } from "mssql";
import { env } from "../config/env.js";
import { DDL_STATEMENTS, formatSubmissionPublicId } from "./schema.js";

let pool: ConnectionPool | null = null;
let dbReady = false;
let initPromise: Promise<boolean> | null = null;

// -----------------------------------------------------------------------------
// Connection pool config (Azure SQL Serverless aware)
// -----------------------------------------------------------------------------
const config: sql.config = {
  server: env.db.server,
  port: env.db.port,
  database: env.db.database,
  user: env.db.user,
  password: env.db.password,
  pool: {
    max: env.db.poolMax,
    min: env.db.poolMin,
    idleTimeoutMillis: env.db.poolIdleTimeoutMs,
  },
  connectionTimeout: env.db.connectionTimeoutMs,
  requestTimeout: env.db.requestTimeoutMs,
  options: {
    encrypt: true,
    trustServerCertificate: false,
    enableArithAbort: true,
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -----------------------------------------------------------------------------
// Connect with retry-with-backoff — Azure SQL Serverless AUTO-SUSPENDS when
// idle and signals via ECONNRESET on the first login after wake (can exceed
// ~4 minutes). Retry until the handshake succeeds.
// -----------------------------------------------------------------------------
async function connectWithRetry(attempts = 20, baseDelayMs = 3000): Promise<ConnectionPool> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const newPool = await new sql.ConnectionPool(config).connect();
      return newPool;
    } catch (err) {
      const isNetworkReset =
        err instanceof Error &&
        (err.message.includes("ECONNRESET") ||
          err.message.includes("ESOCKET") ||
          err.message.includes("login") ||
          err.message.includes("connect"));
      if (attempt === attempts) {
        throw err;
      }
      // Exponential backoff with jitter; cap at 30s.
      const backoff = Math.min(baseDelayMs * Math.pow(1.5, attempt - 1), 30000);
      const jitter = backoff * (0.5 + Math.random() * 0.5);
      // eslint-disable-next-line no-console
      console.error(
        `[db] Connection attempt ${attempt}/${attempts} failed (${err instanceof Error ? err.message : err}). ` +
          `Retrying in ${Math.round(jitter / 1000)}s${isNetworkReset ? " (serverless wake)" : ""}...`
      );
      await sleep(jitter);
    }
  }
  throw new Error("Unreachable: db.connectWithRetry");
}

// -----------------------------------------------------------------------------
// Initialize schema idempotently (CREATE IF NOT EXISTS for each table/index)
// -----------------------------------------------------------------------------
async function runDdl(): Promise<void> {
  const db = await getPool();
  const request = db.request();
  for (const statement of DDL_STATEMENTS) {
    await request.batch(statement);
  }
  await backfillSubmissionIds(db);
}

// One-time migration: convert legacy hex submission ids (`7bea...`) into the new
// incremental format (`CDM-00001`). It computes a per-form counter from the
// existing submission order and stamps both `public_id` and `submission_seq`.
// Guarded by `submission_seq IS NULL` (legacy rows only) so re-running is a no-op
// and never renumbers rows that already carry an incremental id.
async function backfillSubmissionIds(db: ConnectionPool): Promise<void> {
  const forms = await db.request().query(
    `SELECT id, code, submission_seq FROM dbo.forms ORDER BY id`
  );
  let backfilled = 0;
  for (const f of forms.recordset) {
    // Legacy rows are those not yet stamped with a submission_seq (the current
    // code stamps this column on insert, so new-format rows are excluded).
    const subs = await db.request()
      .input("formId", f.id)
      .query(
        `SELECT id FROM dbo.submissions
         WHERE form_id = @formId AND submission_seq IS NULL
         ORDER BY submitted_at ASC, id ASC`
      );
    if (!subs.recordset.length) continue;

    // Continue numbering from the form's current counter so we never collide
    // with already-allocated ids. The counter is the last number handed out.
    let seq = (f.submission_seq as number) || 0;
    for (const s of subs.recordset) {
      seq += 1;
      const publicId = formatSubmissionPublicId(f.code, seq);
      await db.request()
        .input("id", s.id)
        .input("seq", seq)
        .input("publicId", publicId)
        .query(
          `UPDATE dbo.submissions
           SET public_id = @publicId, submission_seq = @seq
           WHERE id = @id`
        );
      backfilled += 1;
    }
    // Advance the form counter to the last allocated number so the next real
    // submission continues from here.
    if (seq > (f.submission_seq as number)) {
      await db.request()
        .input("formId", f.id)
        .input("seq", seq)
        .query(`UPDATE dbo.forms SET submission_seq = @seq WHERE id = @formId`);
    }
  }
  if (backfilled > 0) {
    // eslint-disable-next-line no-console
    console.log(`[db] Backfilled ${backfilled} legacy submission id(s) to incremental format.`);
  }
}

export async function getPool(): Promise<ConnectionPool> {
  if (!pool) {
    pool = await connectWithRetry();
  }
  return pool;
}

// -----------------------------------------------------------------------------
// initDb — idempotent, sets dbReady. Call this from a background retry loop
// AFTER app.listen() so the server accepts health checks while warming up.
// -----------------------------------------------------------------------------
export function initDb(): Promise<boolean> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      await getPool();
      await runDdl();
      dbReady = true;
      // eslint-disable-next-line no-console
      console.log("[db] Database ready: tables/indexes ensured.");
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
  if (pool) {
    void pool.close().catch(() => undefined);
    pool = null;
  }
  dbReady = false;
  initPromise = null;
}
