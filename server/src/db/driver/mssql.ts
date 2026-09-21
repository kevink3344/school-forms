import sql, { type ConnectionPool, type Transaction } from "mssql";
import { env } from "../../config/env.js";
import { normalizeRow, type DbClient, type DbParams } from "../client.js";

// -----------------------------------------------------------------------------
// Azure SQL Server driver.
//
// This is the original `pool.ts` connection logic, lifted intact. Two things in
// here are load-bearing and must not be "simplified":
//
//   1. connectWithRetry — Azure SQL Serverless AUTO-SUSPENDS when idle and
//      signals the wake with ECONNRESET on the first login, which can take
//      minutes. 60 attempts at a 60s-capped exponential backoff with jitter
//      gives ~25 minutes of headroom before the caller's outer loop takes over.
//   2. The single-flight `poolPromise` — a naive `if (!pool)` guard lets every
//      concurrent caller start its OWN connectWithRetry() loop while the first
//      is still awaiting, which produced interleaved resetting counters and
//      connection storms during a slow wake. Sharing one in-flight promise means
//      all callers await the SAME attempt.
//
//   3. Row normalisation through the shared `normalizeRow` — the mirror image of
//      the libSQL driver's, and not optional. An earlier version of this comment
//      said "only the libSQL driver normalises". That described how the driver
//      was written, not what the API needs: every consumer is written against the
//      normalised contract (`ExportSourceSubmission.submitted_at: Date`, the grid
//      calling `toLocaleString`), so on a host whose timestamp column holds TEXT
//      the raw string reached `Intl.DateTimeFormat.format` and turned the whole
//      report into `500 {"error":"Invalid time value"}`. Measured on production.
//
// `normalizeParamValue` is deliberately NOT applied — that half is still
// libSQL-only. `mssql` binds a JS `Date` as a real datetime2, which is exactly
// what the SQL Server path has always done, and converting it to an ISO string
// would change the bound type. The libSQL driver normalises parameters because
// there a bound `Date` becomes an epoch number.
//
// `normalizeRow` is safe here even though SQL Server already returns real
// `Date`s and real booleans: it only converts strings, so a row that is already
// correct passes through by identity. The wire format is unchanged either way,
// because `JSON.stringify` renders a `Date` as `toISOString()` — the very string
// a text column held.
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

async function connectWithRetry(attempts = 60, baseDelayMs = 3000): Promise<ConnectionPool> {
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
      // Exponential backoff with jitter; cap at 60s.
      const backoff = Math.min(baseDelayMs * Math.pow(1.5, attempt - 1), 60000);
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

let pool: ConnectionPool | null = null;
let poolPromise: Promise<ConnectionPool> | null = null;

export async function getPool(): Promise<ConnectionPool> {
  if (pool) return pool;
  if (!poolPromise) {
    poolPromise = connectWithRetry()
      .then((p) => {
        pool = p;
        return p;
      })
      .catch((err) => {
        // Allow a later call to retry from scratch after a hard failure.
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

// Both query paths funnel their recordset through the shared row normaliser, so
// a host whose timestamp columns hold TEXT hands the app the same shapes a real
// `DATETIME2` would. No `columnTypes` are passed: `BIT` columns already arrive
// as real booleans on this driver, so the declared-type branch has nothing to do
// and only the timestamp repair matters.
function normalizeResult<T>(recordset: Record<string, unknown>[] | undefined): T[] {
  return (recordset ?? []).map((row) => normalizeRow({ ...row }) as T);
}

function bindParams(request: sql.Request, params: DbParams): void {
  for (const [name, value] of Object.entries(params)) {
    request.input(name, value as never);
  }
}

function transactionClient(transaction: Transaction): DbClient {
  return {
    kind: "sqlserver",
    async query<T = unknown>(statement: string, params: DbParams = {}): Promise<T[]> {
      const request = new sql.Request(transaction);
      bindParams(request, params);
      const result = await request.query(statement);
      return normalizeResult<T>(result.recordset);
    },
    async run(): Promise<void> {
      throw new Error("nested DB runs are not supported inside a transaction");
    },
    async transaction(): Promise<never> {
      throw new Error("nested DB transactions are not supported");
    },
    async close(): Promise<void> {
      /* the pooling layer owns the connection */
    },
  };
}

export const mssqlClient: DbClient = {
  kind: "sqlserver",

  async query<T = unknown>(statement: string, params: DbParams = {}): Promise<T[]> {
    const db = await getPool();
    const request = db.request();
    bindParams(request, params);
    const result = await request.query(statement);
    return normalizeResult<T>(result.recordset);
  },

  async run(statements: string[]): Promise<void> {
    const db = await getPool();
    const request = db.request();
    for (const statement of statements) {
      await request.batch(statement);
    }
  },

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    const db = await getPool();
    const transaction = new sql.Transaction(db);
    await transaction.begin();
    try {
      const result = await fn(transactionClient(transaction));
      await transaction.commit();
      return result;
    } catch (err) {
      try {
        await transaction.rollback();
      } catch {
        // Already aborted server-side — surface the original error instead.
      }
      throw err;
    }
  },

  async close(): Promise<void> {
    const current = pool;
    pool = null;
    poolPromise = null;
    if (current) await current.close();
  },
};
