import type { DbKind } from "../client.js";
import { sqlserverDialect } from "./sqlserver.js";
import { tursoDialect } from "./turso.js";
import type { Dialect } from "./types.js";

// SQL Server is the default so that a missing/blank DB_MODE keeps the live
// production behaviour exactly as it was before dual-database support existed.
export function getDialect(kind: DbKind | string | undefined): Dialect {
  return String(kind ?? "sqlserver").toLowerCase() === "turso"
    ? tursoDialect
    : sqlserverDialect;
}

export { sqlserverDialect, tursoDialect };
export type { Dialect };
