/**
 * One-time data copy: SQL Server -> Turso (docs/plans/dual-db.md §9, Phase 7).
 *
 * WHY THIS IS A SEPARATE SCRIPT
 * -----------------------------
 * The runtime seam (`db/driver/index.ts`) resolves ONE client from `DB_MODE`.
 * A migration needs both databases at once, so this script deliberately imports
 * the two drivers directly instead of going through `getClient()`. It also
 * ignores `DB_MODE` entirely: the SOURCE is always the SQL Server named by the
 * `DB_*` variables and the TARGET is always the Turso database named by
 * `TURSO_DB_URL` / `TURSO_DB_APIKEY`. That way an operator cannot accidentally
 * point the copy at the wrong pair by editing one variable.
 *
 * SAFETY
 * ------
 * Nothing runs without `--confirm`. Without it the script prints what it would
 * do and exits 0. With it, the target's data tables are EMPTIED first — the
 * target is a brand-new database, but the wipe makes the copy re-runnable and
 * idempotent, and it is why the confirmation gate exists.
 *
 * USAGE (from `server/`)
 * ----------------------
 *   npx tsx src/db/migrate-turso.ts                    # dry run, prints the plan
 *   npx tsx src/db/migrate-turso.ts --confirm          # schema + data copy
 *   npx tsx src/db/migrate-turso.ts --confirm --ddl-only
 *   npx tsx src/db/migrate-turso.ts --verify           # read-only checks
 *
 * ORDERING
 * --------
 * Tables are copied in topological order so every foreign key is satisfied when
 * it is checked. `PRAGMA foreign_keys = ON` is prepended to every batch: a
 * remote libSQL batch runs on one connection inside one transaction, so the
 * pragma applies to the inserts that follow it in that batch. A parent/child
 * mistake therefore fails loudly instead of silently committing orphans.
 *
 * `client.migrate()` is NOT used for the data copy — it turns foreign keys OFF.
 */
import { createClient, type Client as LibsqlClient, type InValue } from "@libsql/client";
import { env } from "../config/env.js";
import { mssqlClient } from "./driver/mssql.js";
import { libsqlClient } from "./driver/libsql.js";
import { tursoDialect } from "./dialect/turso.js";

// ---------------------------------------------------------------------------
// Table plan — explicit ids are preserved, so no foreign key ever needs
// remapping. Order is parent-before-child.
// ---------------------------------------------------------------------------
const TABLES: { name: string; label: string }[] = [
  { name: "organizations", label: "organizations" },
  { name: "schools", label: "schools" },
  { name: "users", label: "users" },
  { name: "forms", label: "forms" },
  { name: "form_fields", label: "form fields" },
  { name: "submissions", label: "submissions" },
  { name: "submission_values", label: "submission values" },
  { name: "submission_adhoc_fields", label: "ad-hoc fields" },
  { name: "documents", label: "generated documents" },
  { name: "app_settings", label: "app settings" },
  { name: "report_views", label: "report views" },
];

/** Reverse order — children before parents, for the wipe. */
const WIPE_ORDER = [...TABLES].reverse();

/** Rows per batch. libSQL has no bulk COPY; each batch is one round trip. */
const BATCH_ROWS = 200;

/** Columns whose stored TEXT must read back as a real boolean. */
const BOOLEAN_COLUMNS = ["active", "required", "staff_only", "is_default"] as const;

/** Timestamp columns that must round-trip as ISO-8601 `...Z`. */
const TIMESTAMP_COLUMNS = ["created_at", "updated_at", "submitted_at", "last_used_at", "staff_fields_updated_at"];

const args = process.argv.slice(2);
const CONFIRM = args.includes("--confirm");
const DDL_ONLY = args.includes("--ddl-only");
const VERIFY_ONLY = args.includes("--verify");

function log(line = "") {
  // eslint-disable-next-line no-console
  console.log(line);
}

// ---------------------------------------------------------------------------
// Value translation: SQL Server -> libSQL
// ---------------------------------------------------------------------------
function toTargetValue(value: unknown): InValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string" || typeof value === "bigint") {
    return value;
  }
  if (value instanceof Uint8Array) return value;
  return String(value);
}

function openTarget(): LibsqlClient {
  return createClient({
    url: env.turso.url,
    authToken: env.turso.authToken || undefined,
    intMode: "number",
  });
}

// ---------------------------------------------------------------------------
// Step 1 — schema
// ---------------------------------------------------------------------------
async function createSchema(target: LibsqlClient): Promise<void> {
  log("Step 1 — creating the Turso schema (idempotent)…");
  await target.batch(
    tursoDialect.ddl.map((sql) => ({ sql, args: {} })),
    "write"
  );
  const tables = await target.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  );
  log(`  ${tables.rows.length} table(s): ${tables.rows.map((r) => String(r.name)).join(", ")}`);
}

// ---------------------------------------------------------------------------
// Wipe — makes the copy re-runnable
// ---------------------------------------------------------------------------
async function wipeTarget(target: LibsqlClient): Promise<void> {
  log("Step 1b — clearing target data tables (children first)…");
  for (const { name } of WIPE_ORDER) {
    await target.execute({ sql: `DELETE FROM "${name}"`, args: {} });
  }
}

// ---------------------------------------------------------------------------
// Step 2 — data
// ---------------------------------------------------------------------------
async function sourceColumns(table: string): Promise<string[]> {
  const rows = await mssqlClient.query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = @table
     ORDER BY ORDINAL_POSITION`,
    { table }
  );
  return rows.map((r) => r.COLUMN_NAME);
}

async function copyTable(target: LibsqlClient, table: string, label: string): Promise<number> {
  const columns = await sourceColumns(table);
  if (!columns.length) {
    log(`  ${label.padEnd(22)} SKIPPED — no such table in the source`);
    return 0;
  }

  const rows = await mssqlClient.query<Record<string, unknown>>(`SELECT * FROM dbo.${table}`);
  const columnList = columns.map((c) => `"${c}"`).join(", ");
  const placeholders = columns.map((c) => `@${c}`).join(", ");
  const insertSql = `INSERT INTO "${table}" (${columnList}) VALUES (${placeholders})`;

  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH_ROWS) {
    const chunk = rows.slice(i, i + BATCH_ROWS);
    const statements = [
      // Per-connection enforcement — see the header.
      { sql: "PRAGMA foreign_keys = ON", args: {} },
      ...chunk.map((row) => {
        const params: Record<string, InValue> = {};
        for (const c of columns) params[c] = toTargetValue(row[c]);
        return { sql: insertSql, args: params };
      }),
    ];
    await target.batch(statements, "write");
    written += chunk.length;
  }

  log(`  ${label.padEnd(22)} ${String(written).padStart(6)} row(s)`);
  return written;
}

async function copyData(target: LibsqlClient): Promise<void> {
  log("Step 2 — copying data (parents first, ids preserved)…");
  for (const { name, label } of TABLES) {
    await copyTable(target, name, label);
  }
}

// ---------------------------------------------------------------------------
// Step 3 — verification
// ---------------------------------------------------------------------------
async function verify(target: LibsqlClient): Promise<boolean> {
  let pass = true;
  log("Step 3 — verifying…");

  // 3a. row counts
  log("  3a. row counts");
  for (const { name, label } of TABLES) {
    const src = await mssqlClient.query<{ n: number }>(`SELECT COUNT(*) AS n FROM dbo.${name}`);
    const tgt = await target.execute({ sql: `SELECT COUNT(*) AS n FROM "${name}"`, args: {} });
    const expected = Number(src[0]?.n ?? 0);
    const actual = Number(tgt.rows[0]?.n ?? -1);
    const same = expected === actual;
    if (!same) pass = false;
    log(`      ${same ? "OK  " : "FAIL"} ${label.padEnd(22)} source=${expected} target=${actual}`);
  }

  // 3b. referential integrity
  const fk = await target.execute({ sql: "PRAGMA foreign_key_check", args: {} });
  const fkOk = fk.rows.length === 0;
  if (!fkOk) pass = false;
  log(`  3b. ${fkOk ? "OK  " : "FAIL"} PRAGMA foreign_key_check — ${fk.rows.length} violation(s)`);

  // 3c. booleans read back as real booleans. Read through `libsqlClient` — the
  //     REAL app driver — because that is what applies row normalisation; the
  //     raw client would correctly report 0/1 and prove nothing about the API.
  log("  3c. boolean columns (via the app driver, which normalises rows)");
  const boolProbes: { table: string; column: string }[] = [
    { table: "organizations", column: "active" },
    { table: "users", column: "active" },
    { table: "form_fields", column: "required" },
    { table: "form_fields", column: "staff_only" },
    { table: "report_views", column: "is_default" },
  ];
  for (const { table, column } of boolProbes) {
    const rows = await libsqlClient.query<Record<string, unknown>>(
      `SELECT DISTINCT "${column}" AS v FROM "${table}" WHERE "${column}" IS NOT NULL`
    );
    const types = [...new Set(rows.map((r) => typeof r.v))];
    const good = types.length > 0 && types.every((t) => t === "boolean");
    if (!good) pass = false;
    log(`      ${good ? "OK  " : "FAIL"} ${table}.${column} -> ${types.join(", ") || "(no rows)"}`);
  }
  // Cross-check against the declaration, so this test can't silently drift.
  for (const column of BOOLEAN_COLUMNS) {
    if (!boolProbes.some((p) => p.column === column)) {
      log(`      WARN boolean column ${column} has no probe`);
    }
  }

  // 3d. every timestamp column that exists stores ISO-8601 UTC text.
  //     A bound JS `Date` serialises as an epoch number in libSQL, so a value
  //     that is not shaped `...Z` means a copy path bypassed the driver's
  //     `normalizeParamValue`.
  log("  3d. timestamp columns");
  const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  let stampsChecked = 0;
  let stampFailures = 0;
  for (const { name } of TABLES) {
    const info = await target.execute({ sql: `PRAGMA table_info("${name}")`, args: {} });
    const cols = info.rows.map((r) => String(r.name));
    for (const column of TIMESTAMP_COLUMNS) {
      if (!cols.includes(column)) continue;
      stampsChecked += 1;
      const res = await target.execute({
        sql: `SELECT "${column}" AS v FROM "${name}" WHERE "${column}" IS NOT NULL`,
        args: {},
      });
      const bad = res.rows.filter((r) => !(typeof r.v === "string" && ISO_UTC.test(r.v)));
      if (bad.length) {
        stampFailures += 1;
        pass = false;
        log(
          `      FAIL ${name}.${column} — ${bad.length} non-ISO value(s), e.g. ${JSON.stringify(bad[0].v)}`
        );
      }
    }
  }
  log(
    `      ${stampFailures === 0 ? "OK  " : "FAIL"} ${stampsChecked} timestamp column(s), ` +
      `${stampFailures} with non-ISO values`
  );

  // 3e. AUTOINCREMENT sequence must be >= max(id) or post-copy inserts collide
  log("  3e. sqlite_sequence vs max(id)");
  for (const { name } of TABLES) {
    const info = await target.execute({ sql: `PRAGMA table_info("${name}")`, args: {} });
    // app_settings is keyed by `key` and has no rowid alias named `id`.
    if (!info.rows.some((r) => String(r.name) === "id")) {
      log(`      --   ${name.padEnd(22)} (no id column)`);
      continue;
    }
    const res = await target.execute({
      sql: `SELECT (SELECT COALESCE(MAX(id), 0) FROM "${name}") AS max_id,
                   (SELECT COALESCE(seq, 0) FROM sqlite_sequence WHERE name = @t) AS seq`,
      args: { t: name },
    });
    const maxId = Number(res.rows[0]?.max_id ?? 0);
    const seq = Number(res.rows[0]?.seq ?? 0);
    const good = maxId === 0 || seq >= maxId;
    if (!good) pass = false;
    log(`      ${good ? "OK  " : "FAIL"} ${name.padEnd(22)} max_id=${maxId} seq=${seq}`);
  }

  // 3f. no epoch-shaped timestamps anywhere (the bound-Date trap). A 13-digit
  //     number stored in a TEXT column is exactly what a raw libSQL Date bind
  //     produces, so scan every text timestamp column for that shape.
  log("  3f. epoch-shaped values in timestamp columns");
  let epochish = 0;
  for (const { name } of TABLES) {
    const info = await target.execute({ sql: `PRAGMA table_info("${name}")`, args: {} });
    const cols = info.rows.map((r) => String(r.name));
    for (const column of TIMESTAMP_COLUMNS) {
      if (!cols.includes(column)) continue;
      const res = await target.execute({
        sql: `SELECT COUNT(*) AS n FROM "${name}"
              WHERE "${column}" GLOB '*[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*'`,
        args: {},
      });
      epochish += Number(res.rows[0]?.n ?? 0);
    }
  }
  if (epochish > 0) {
    pass = false;
    log(`      FAIL ${epochish} epoch-shaped timestamp value(s)`);
  } else {
    log("      OK   no epoch-shaped timestamp values");
  }

  log(pass ? "\nVERIFY: PASS" : "\nVERIFY: FAIL");
  return pass;
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  if (!env.turso.url) throw new Error("TURSO_DB_URL is not set — nothing to copy into.");
  if (!env.db.server) throw new Error("DB_SERVER is not set — nothing to copy from.");

  log("SQL Server -> Turso data copy (docs/plans/dual-db.md §9 Phase 7)");
  log(`  source (SQL Server): ${env.db.server} / ${env.db.database}`);
  log(`  target (Turso):      ${env.turso.url}`);
  log(`  auth token:          ${env.turso.authToken ? "(set)" : "(none)"}`);
  log("");

  const target = openTarget();
  try {
    if (VERIFY_ONLY) {
      const ok = await verify(target);
      process.exit(ok ? 0 : 1);
    }

    if (!CONFIRM) {
      log("DRY RUN — nothing was written. This would:");
      log("  1. create the Turso schema (idempotent DDL)");
      log("  2. DELETE every row from the target's data tables");
      for (const { label } of TABLES) log(`  3. copy ${label}`);
      log("  4. verify row counts, foreign keys, booleans and timestamps");
      log("");
      log("Re-run with --confirm to execute.");
      return;
    }

    await createSchema(target);
    if (DDL_ONLY) {
      log("\n--ddl-only: stopping before the data copy.");
      return;
    }

    await wipeTarget(target);
    await copyData(target);
    const ok = await verify(target);
    if (!ok) process.exitCode = 1;
  } finally {
    target.close();
    await mssqlClient.close().catch(() => undefined);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("MIGRATION FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
