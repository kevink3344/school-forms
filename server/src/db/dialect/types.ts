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

export interface Dialect {
  readonly kind: DbKind;

  /** The schema statements run once at boot (idempotent). */
  readonly ddl: string[];

  insertReturning(o: InsertReturningOptions): string;
  updateReturning(o: UpdateReturningOptions): string;
  deleteReturning(o: DeleteReturningOptions): string;

  /** Paginated school search for the admin Schools page. */
  selectSchoolsPage(o: { where: string; orderBy: string }): string;

  /** Upsert a single `app_settings` row keyed on `key`. */
  upsertSetting(): string;

  /** Upsert a `schools` row keyed on `source_id`, merged on the imported feed. */
  upsertSchoolFromSource(): string;

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
