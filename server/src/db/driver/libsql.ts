import {
  createClient,
  type Client,
  type InValue,
  type ResultSet,
  type Transaction,
} from "@libsql/client";
import { env } from "../../config/env.js";
import { normalizeParamValue, normalizeRow, type DbClient, type DbParams } from "../client.js";

// -----------------------------------------------------------------------------
// Turso / libSQL driver.
//
// Three things this driver does that the SQL Server one does not:
//
//  1. STATEMENT REWRITE. The shared SQL was written for SQL Server. Rather than
//     fork 271 statements, a handful of safe literal tokens are translated on
//     the way in (docs/plans/dual-db.md §8.4a):
//       `dbo.`              -> ``            (schema qualifier; libSQL has none)
//       `SYSUTCDATETIME()`  -> strftime UTC ISO-8601
//       `N'...'`            -> `'...'`       (SQL Server unicode literal prefix)
//       `NVARCHAR(MAX)`     -> `NVARCHAR`    (libSQL rejects the `MAX` length
//                                             token; see NVARCHAR_MAX below)
//     The rewrite is a pure function so it can be unit-tested, and the DDL does
//     NOT depend on it (dialect/turso.ts writes strftime literally).
//
//     ⚠ Structural divergence is NOT handled here. `SELECT TOP n`, `OUTPUT
//     INSERTED`, `MERGE` and `OFFSET/FETCH` move whole clauses around, so they
//     are built per dialect in dialect/ instead. Adding a case here only works
//     when the fix is a straight token-for-token substitution.
//
//     Any shared statement that trips a construct the rewriter cannot fix now
//     fails the build-time scan in libsql.test.ts
//     ("keeps SQL Server-only constructs out of the shared data layer").
//
//  2. PARAMETER NORMALISATION. libSQL serialises a bound JS `Date` as an epoch
//     NUMBER (`1789439615279.0`) — verified — which would land a numeric string
//     in a TEXT timestamp column and desync it from the rows the DDL DEFAULT
//     stamped. Dates become ISO-8601 strings; `undefined` becomes NULL.
//
//  3. ROW NORMALISATION. SQLite has no boolean type: a `BOOLEAN` column comes
//     back as 0/1 where SQL Server's `BIT` returns a real boolean. Rows are
//     converted using the declared column types libSQL reports, so the JSON the
//     API emits is identical under both modes.
//
// ⚠ Timestamps are plain TEXT. Everything sorts lexicographically because the
// format is fixed-width — see dialect/turso.ts.
// -----------------------------------------------------------------------------

/** ISO-8601 UTC with milliseconds — the same shape `Date#toISOString()` emits. */
export const TURSO_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

// `N'...'` only, never the tail of a longer identifier such as `..._RN'`.
const UNICODE_LITERAL = /(?<![A-Za-z0-9_$])N'/g;
const SYSUTCDATETIME_CALL = /SYSUTCDATETIME\s*\(\s*\)/gi;
// libSQL's CAST type parser accepts `NVARCHAR(10)` (it contains `CHAR`, so the
// affinity is TEXT) but rejects the `MAX` length token outright. Dropping just
// the length keeps TEXT affinity and the declared intent readable — unlike
// rewriting the whole type to `TEXT`, which would hide that it came from
// SQL Server. Verified against live Turso: `CAST('a' AS NVARCHAR(MAX))` raises
// `SQL_PARSE_ERROR near ID, "Some("MAX")"` while `NVARCHAR` and `NVARCHAR(4)`
// both succeed.
const NVARCHAR_MAX = /\bNVARCHAR\s*\(\s*MAX\s*\)/gi;

/**
 * Translate SQL Server-flavoured shared SQL into libSQL SQL.
 *
 * This is intentionally a token rewrite, not a parser. It must never be used on
 * SQL that contains the literal text `dbo.` or `SYSUTCDATETIME()` *inside a
 * quoted string* — no statement in the codebase does, and
 * `driver/libsql.test.ts` asserts that.
 */
export function toLibsql(sqlText: string): string {
  return sqlText
    .replaceAll("dbo.", "")
    .replace(SYSUTCDATETIME_CALL, TURSO_NOW)
    .replace(UNICODE_LITERAL, "'")
    .replace(NVARCHAR_MAX, "NVARCHAR");
}

// libSQL accepts named args as `Record<string, InValue>`. `normalizeParamValue`
// returns `unknown` (it only promises a libSQL-safe value), so the cast is the
// single place that contract is asserted.
function normalizeParams(params: DbParams): Record<string, InValue> {
  const out: Record<string, InValue> = {};
  for (const [name, value] of Object.entries(params)) {
    out[name] = normalizeParamValue(value) as InValue;
  }
  return out;
}

function normalizeResult<T>(result: ResultSet): T[] {
  const columnTypes = result.columnTypes as unknown as readonly string[] | undefined;
  return result.rows.map((row) =>
    normalizeRow({ ...row } as Record<string, unknown>, columnTypes)
  ) as T[];
}

// `{ sql, args }` is a named-parameter statement. The positional overload wants
// a bare string, so the object form must be exactly an InStatement.
function namedStatement(sqlText: string, params: DbParams) {
  return { sql: toLibsql(sqlText), args: normalizeParams(params) };
}

let client: Client | null = null;
let clientPromise: Promise<Client> | null = null;

async function openClient(): Promise<Client> {
  if (client) return client;
  if (!clientPromise) {
    clientPromise = (async () => {
      const created = createClient({
        url: env.turso.url,
        authToken: env.turso.authToken || undefined,
        intMode: "number",
      });
      client = created;
      await applySessionPragmas(created);
      return created;
    })().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

// libSQL/SQLite ignore foreign keys unless enabled per connection. Best-effort:
// a remote Turso endpoint may reject or ignore the pragma, in which case
// referential integrity is the application's responsibility (see
// docs/plans/dual-db.md §10.3 and the explicit child deletes in queries.ts).
async function applySessionPragmas(target: Client): Promise<void> {
  try {
    await target.execute("PRAGMA foreign_keys = ON");
    const check = await target.execute("PRAGMA foreign_keys");
    const value = check.rows[0] ? Object.values(check.rows[0])[0] : undefined;
    if (Number(value) !== 1) {
      // eslint-disable-next-line no-console
      console.warn(
        "[db] libSQL foreign_keys could not be enabled (PRAGMA reports " +
          `${String(value)}). Referential integrity falls back to the ` +
          "application layer; run `migrate-turso verify` after any bulk import."
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[db] libSQL PRAGMA foreign_keys unsupported:",
      err instanceof Error ? err.message : err
    );
  }
}

function transactionClient(tx: Transaction): DbClient {
  return {
    kind: "turso",
    async query<T = unknown>(sqlText: string, params: DbParams = {}): Promise<T[]> {
      const result = await tx.execute(namedStatement(sqlText, params));
      return normalizeResult<T>(result);
    },
    async run(): Promise<void> {
      throw new Error("nested DB runs are not supported inside a transaction");
    },
    async transaction(): Promise<never> {
      throw new Error("nested DB transactions are not supported");
    },
    async close(): Promise<void> {
      /* the transaction owner owns the lifecycle */
    },
  };
}

export const libsqlClient: DbClient = {
  kind: "turso",

  async query<T = unknown>(sqlText: string, params: DbParams = {}): Promise<T[]> {
    const db = await openClient();
    const result = await db.execute(namedStatement(sqlText, params));
    return normalizeResult<T>(result);
  },

  async run(statements: string[]): Promise<void> {
    const db = await openClient();
    const translated = statements.map(toLibsql);
    if (!translated.length) return;
    await db.batch(translated, "write");
  },

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    const db = await openClient();
    const tx = await db.transaction("write");
    try {
      const result = await fn(transactionClient(tx));
      await tx.commit();
      return result;
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // Already rolled back / connection lost — surface the original error.
      }
      throw err;
    }
  },

  async close(): Promise<void> {
    const current = client;
    client = null;
    clientPromise = null;
    if (current) current.close();
  },
};
