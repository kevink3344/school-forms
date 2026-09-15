import { env } from "../../config/env.js";
import type { DbClient, DbKind } from "../client.js";
import { libsqlClient } from "./libsql.js";
import { mssqlClient } from "./mssql.js";

// -----------------------------------------------------------------------------
// Driver selection.
//
// SQL Server is the default, so an unset or unrecognised DB_MODE keeps the live
// production behaviour. Both modules are imported eagerly — that is deliberate
// and cheap: neither opens a connection at import time, and `mssql.ts` only
// builds a config object literal, so a Turso-only environment (with no DB_*
// values) still loads.
// -----------------------------------------------------------------------------

let override: DbClient | null = null;

export function getClient(): DbClient {
  if (override) return override;
  return env.dbMode === "turso" ? libsqlClient : mssqlClient;
}

export function getDbKind(): DbKind {
  return getClient().kind;
}

/**
 * Point the process at an explicit client. Used by the one-time migration script
 * (which needs a SQL Server reader AND a Turso writer in the same process) and by
 * tests. Pass `null` to return to normal selection.
 */
export function setClient(next: DbClient | null): void {
  override = next;
}

export { libsqlClient, mssqlClient };
