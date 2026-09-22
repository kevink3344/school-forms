import { SQLSERVER_DDL_STATEMENTS } from "../schema.js";
import { submissionValuePredicate, schoolFieldPredicate } from "./shared.js";
import type { Dialect } from "./types.js";

// -----------------------------------------------------------------------------
// SQL Server dialect.
//
// The migration ladder lives in `schema.ts` (exported as
// `SQLSERVER_DDL_STATEMENTS`) and is consumed here rather than transcribed — it
// IS the SQL Server schema, and an accidental edit during a copy would be fatal
// on the live database. The Turso dialect (./turso.ts) does NOT port it: a fresh
// libSQL database gets the final shape directly (docs/plans/dual-db.md §5.3).
// (No statement count is quoted here on purpose: it changed on every migration
// and a stale figure reads as a fact.)
//
// Every builder below emits SQL that is semantically identical to the literals
// that were inline in `queries.ts` before the dialect split, so the SQL Server
// path stays byte-for-byte the same on the wire.
// -----------------------------------------------------------------------------

function outputList(returning: string[]): string {
  return returning.map((column) => `INSERTED.${column}`).join(", ");
}

export const sqlserverDialect: Dialect = {
  kind: "sqlserver",

  ddl: SQLSERVER_DDL_STATEMENTS,

  // The ladder is cumulative, so every additive column is already covered by its
  // own `COL_LENGTH`-guarded ALTER in `SQLSERVER_DDL_STATEMENTS`.
  addColumns: [],

  insertReturning({ table, columns, returning, values }) {
    return (
      `INSERT INTO dbo.${table} (${columns.join(", ")})\n` +
      `     OUTPUT ${outputList(returning)}\n` +
      `     VALUES (${values})`
    );
  },

  updateReturning({ table, set, where, returning }) {
    return (
      `UPDATE dbo.${table}\n` +
      `     SET ${set}\n` +
      `     OUTPUT ${outputList(returning)}\n` +
      `     WHERE ${where}`
    );
  },

  deleteReturning({ table, where, returning }) {
    return `DELETE FROM dbo.${table} OUTPUT DELETED.${returning.join(", DELETED.")} WHERE ${where}`;
  },

  selectSchoolsPage({ where, orderBy }) {
    // SQL Server requires ORDER BY to use OFFSET/FETCH.
    return (
      `SELECT id, source_id, name, grade_level, calendar, district, created_at\n` +
      `     FROM dbo.schools\n` +
      `     ${where}\n` +
      `     ORDER BY ${orderBy}\n` +
      `     OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`
    );
  },

  selectPage({ select, from, where, orderBy }) {
    // SQL Server requires ORDER BY to use OFFSET/FETCH.
    return (
      `SELECT ${select}\n` +
      `     FROM ${from}\n` +
      `     ${where}\n` +
      `     ORDER BY ${orderBy}\n` +
      `     OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`
    );
  },

  upsertSetting() {
    return (
      `MERGE dbo.app_settings AS target\n` +
      `     USING (SELECT @key AS [key], @value AS [value]) AS source\n` +
      `     ON target.[key] = source.[key]\n` +
      `     WHEN MATCHED THEN UPDATE SET target.[value] = source.[value],\n` +
      `                                  target.updated_at = SYSUTCDATETIME()\n` +
      `     WHEN NOT MATCHED THEN INSERT ([key], [value], updated_at)\n` +
      `       VALUES (source.[key], source.[value], SYSUTCDATETIME());`
    );
  },

  upsertSchoolFromSource() {
    return (
      `MERGE dbo.schools AS tgt\n` +
      `     USING (SELECT @sourceId AS source_id) AS src\n` +
      `       ON tgt.source_id = src.source_id\n` +
      `     WHEN MATCHED THEN\n` +
      `       UPDATE SET tgt.name = @name, tgt.grade_level = @gradeLevel,\n` +
      `                  tgt.calendar = @calendar,\n` +
      `                  tgt.district = COALESCE(@district, tgt.district)\n` +
      `     WHEN NOT MATCHED THEN\n` +
      `       INSERT (source_id, name, grade_level, calendar, district)\n` +
      `       VALUES (@sourceId, @name, @gradeLevel, @calendar, @district)\n` +
      `     OUTPUT INSERTED.id, INSERTED.source_id, INSERTED.name, INSERTED.grade_level,\n` +
      `            INSERTED.calendar, INSERTED.district, INSERTED.created_at;`
    );
  },

  upsertUserFormViewColumns() {
    // Keyed on the (user_id, form_id) unique index. MERGE rather than an
    // UPDATE-then-INSERT pair so the read and the write cannot interleave with
    // another request for the same pair.
    return (
      `MERGE dbo.user_form_view_columns AS target\n` +
      `     USING (SELECT @userId AS user_id, @formId AS form_id) AS source\n` +
      `     ON target.user_id = source.user_id AND target.form_id = source.form_id\n` +
      `     WHEN MATCHED THEN UPDATE SET target.columns = @value,\n` +
      `                                  target.updated_at = SYSUTCDATETIME()\n` +
      `     WHEN NOT MATCHED THEN INSERT (user_id, form_id, columns, updated_at)\n` +
      `       VALUES (source.user_id, source.form_id, @value, SYSUTCDATETIME());`
    );
  },

  submissionValueSubquery(label) {
    return (
      `(SELECT TOP 1 sv.value\n` +
      `       FROM dbo.submission_values sv\n` +
      `       JOIN dbo.form_fields ff ON ff.id = sv.field_id\n` +
      `      WHERE sv.submission_id = s.id\n` +
      `        AND ${submissionValuePredicate(label)}\n` +
      `        AND sv.value IS NOT NULL\n` +
      `      ORDER BY ff.sort_order)`
    );
  },

  submissionSchoolNameSubquery() {
    // The answer is what `submissions.school_id` is derived FROM, so it is the
    // only value that can name a school the district feed has not imported yet.
    // The LEFT JOIN turns the typed answer into the canonical school name when
    // one matches; `scs.id` breaks a tie between duplicate names the same way
    // for both dialects, and matching on LOWER() keeps that true on libSQL,
    // whose comparison operators are case-sensitive.
    //
    // The answer is TRIMMED before comparison because every other site that
    // resolves this answer trims first: `resolveSubmissionSchoolId` writes
    // `a.value.trim()` into the lookup, `schoolFieldPredicate` trims the label,
    // and the backfill script trims its lookup key. Comparing untrimmed here
    // would let an answer typed with a trailing space resolve at insert time
    // and then fail to resolve for display.
    return (
      `(SELECT TOP 1 COALESCE(scs.name, sv.value)\n` +
      `       FROM dbo.submission_values sv\n` +
      `       JOIN dbo.form_fields ff ON ff.id = sv.field_id\n` +
      `       LEFT JOIN dbo.schools scs ON LOWER(scs.name) = LOWER(LTRIM(RTRIM(sv.value)))\n` +
      `      WHERE sv.submission_id = s.id\n` +
      `        AND ${schoolFieldPredicate()}\n` +
      `        AND sv.value IS NOT NULL\n` +
      `        AND LTRIM(RTRIM(sv.value)) <> ''\n` +
      `      ORDER BY ff.sort_order, scs.id)`
    );
  },
};
