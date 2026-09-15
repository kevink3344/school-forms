import type { DbKind } from "../client.js";

// -----------------------------------------------------------------------------
// Statements that genuinely differ between SQL Server and libSQL.
//
// Everything else in the app is dialect-neutral: `execute()` binds named
// `@param`s and the libSQL driver rewrites the two safe literal tokens (`dbo.`,
// `SYSUTCDATETIME()`). Only these shapes need a hand-written variant:
//
//   OUTPUT INSERTED / OUTPUT DELETED   ->  RETURNING
//   MERGE ... WHEN MATCHED/not MATCHED ->  INSERT ... ON CONFLICT ... DO UPDATE
//   OFFSET n ROWS FETCH NEXT m ROWS    ->  LIMIT m OFFSET n
//   SELECT TOP n ... ORDER BY x        ->  SELECT ... ORDER BY x LIMIT n
//
// See docs/plans/dual-db.md §5.1 and §8.2. `SELECT TOP n` is a *token* in the
// select list but a *clause* at the tail, so it cannot be fixed by the driver's
// token rewriter — it has to be built per dialect like the shapes above.
// -----------------------------------------------------------------------------

export interface InsertReturningOptions {
  table: string;
  columns: string[];
  returning: string[];
  /** Raw VALUES body — parameter names, literals, or a mix. */
  values: string;
}

export interface UpdateReturningOptions {
  table: string;
  /** The SET body, e.g. `name = @name, active = @active`. */
  set: string;
  /** The WHERE body without the keyword, e.g. `id = @id`. */
  where: string;
  returning: string[];
}

export interface DeleteReturningOptions {
  table: string;
  where: string;
  returning: string[];
}

/**
 * A column that a database created by an EARLIER version of `ddl` is missing.
 *
 * SQL Server declares none: its ladder is cumulative and every `ALTER TABLE ADD`
 * is `COL_LENGTH`-guarded, so the column arrives with the rest of the schema.
 * SQLite has no `ALTER TABLE ADD COLUMN IF NOT EXISTS` and its DDL is the final
 * shape rather than a ladder, so a Turso database created before the column
 * existed would never gain it. `pool.ts` applies these only when `PRAGMA
 * table_info` does not already list the column (docs/plans/dual-db.md §5.3).
 */
export interface AddColumn {
  /** The table the column belongs to, e.g. `users`. */
  table: string;
  /** The column name exactly as it appears in `ddl`. */
  column: string;
  /** Everything after the name — type, constraints, default. */
  definition: string;
}

export interface Dialect {
  readonly kind: DbKind;

  /** The schema statements run once at boot (idempotent). */
  readonly ddl: string[];

  /**
   * Additive columns for databases created before the column existed. Applied
   * by `pool.ts` after `ddl`; empty on SQL Server, whose ladder already covers
   * them. Keep each entry in step with the column's definition in `ddl`.
   */
  readonly addColumns: AddColumn[];

  insertReturning(o: InsertReturningOptions): string;
  updateReturning(o: UpdateReturningOptions): string;
  deleteReturning(o: DeleteReturningOptions): string;

  /** Paginated school search for the admin Schools page. */
  selectSchoolsPage(o: { where: string; orderBy: string }): string;

  /**
   * Generic paginated SELECT for a list that can exceed one screen.
   *
   * Exists because SQL Server expresses a row window as a *trailing clause*
   * (`ORDER BY x OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`) while
   * libSQL uses `LIMIT @pageSize OFFSET @offset`. Neither spelling parses on the
   * other dialect, and `OFFSET @n ROWS` is one of the constructs
   * `driver/libsql.test.ts` bans from shared files, so it cannot be written
   * inline. `selectSchoolsPage` above is the same idea hardcoded to `schools`.
   *
   * Callers MUST supply `@pageSize` and `@offset` params and MUST supply an
   * `orderBy` — SQL Server rejects a windowed query without one.
   */
  selectPage(o: { select: string; from: string; where: string; orderBy: string }): string;

  /** Upsert a single `app_settings` row keyed on `key`. */
  upsertSetting(): string;

  /** Upsert a `schools` row keyed on `source_id`, merged on the imported feed. */
  upsertSchoolFromSource(): string;

  /**
   * Upsert one `user_form_view_columns` row keyed on (user_id, form_id): the
   * per-user set of grid columns for one form. Params: `@userId`, `@formId`,
   * `@value` (a JSON array of field ids, e.g. `[11,9]`).
   */
  upsertUserFormViewColumns(): string;

  /**
   * Parenthesised scalar subquery yielding the first non-null value of one
   * submission field, correlated on the outer alias `s` (a `submissions` row)
   * and ordered by `form_fields.sort_order`.
   *
   * SQL Server writes the row limit into the select list (`SELECT TOP 1 …`);
   * libSQL appends it after the ordering (`… ORDER BY … LIMIT 1`). Since one is
   * a token and the other a trailing clause, there is no shared spelling.
   *
   * `label` selects a field by exact case-insensitive label; omit it to take
   * the first non-staff-only field, which is the "student name" heuristic the
   * submission list relies on.
   *
   * Returns the subquery only — the caller appends its own `AS <alias>` so this
   * builder never interpolates an identifier. Names are escaped defensively but
   * are always source constants, never user input.
   */
  submissionValueSubquery(label?: string): string;
}
