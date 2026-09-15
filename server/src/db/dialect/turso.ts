import { submissionValuePredicate } from "./shared.js";
import type { Dialect } from "./types.js";

// -----------------------------------------------------------------------------
// Turso / libSQL dialect.
//
// The DDL below is the FINAL schema, not a migration ladder. A fresh Turso
// database has nothing to converge, so all 39 SQL Server guard statements
// collapse into plain `CREATE TABLE IF NOT EXISTS` (docs/plans/dual-db.md §5.3).
//
// Type map (docs/plans/dual-db.md §5.1):
//   INT IDENTITY(1,1) PRIMARY KEY  -> INTEGER PRIMARY KEY AUTOINCREMENT
//   NVARCHAR(n|MAX)                -> TEXT
//   BIT                            -> BOOLEAN   (declared, so ResultSet.columnTypes
//                                                 reports it and driver/libsql.ts can
//                                                 normalise 0/1 back to booleans)
//   DATETIME2                      -> TEXT, ISO-8601 UTC via strftime
//
// ⚠ Timestamps MUST use `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, never
// `CURRENT_TIMESTAMP` (which emits `2026-08-30 15:42:47` — no `Z`, space
// separator — and V8 parses that as LOCAL time, shifting every displayed
// timestamp). The format is fixed-width, so lexicographic ORDER BY still sorts
// correctly (docs/plans/dual-db.md §10.4).
//
// ⚠ `COLLATE NOCASE` on the identity columns replaces SQL Server's default
// case-INSENSITIVE collation. Without it `WHERE email = @email` stops matching a
// differently-cased login and `UX_users_email` would admit two case-variant
// accounts (docs/plans/dual-db.md §10.1). NOCASE is ASCII-only — accepted.
//
// ⚠ libSQL/SQLite ignores foreign keys unless `PRAGMA foreign_keys = ON` is set
// per connection. driver/libsql.ts sets it on open. Every referential action
// here mirrors the SQL Server FKs exactly (docs/plans/dual-db.md §10.3).
//
// The statements are written with literal `strftime(...)` rather than the
// driver's `SYSUTCDATETIME()` rewrite, so the schema does not depend on the
// transform.
// -----------------------------------------------------------------------------

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const NOW_DEFAULT = `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

const TURSO_DDL: string[] = [
  // --- schools ---------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS schools (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     source_id   INTEGER UNIQUE,
     name        TEXT NOT NULL COLLATE NOCASE,
     grade_level TEXT,
     calendar    TEXT,
     district    TEXT,
     created_at  TEXT NOT NULL DEFAULT ${NOW_DEFAULT}
   )`,
  // SQL Server has UX_schools_name (case-insensitive) + a FILTERED unique index
  // on source_id. SQLite's UNIQUE treats NULLs as distinct, which is exactly the
  // filtered-index semantics — so `source_id INTEGER UNIQUE` is the equivalent.
  `CREATE UNIQUE INDEX IF NOT EXISTS UX_schools_name ON schools(name)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS UX_schools_source_id ON schools(source_id)`,

  // --- organizations ---------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS organizations (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     slug          TEXT NOT NULL COLLATE NOCASE,
     name          TEXT NOT NULL COLLATE NOCASE,
     description   TEXT,
     doc_folder_id TEXT,
     active        BOOLEAN NOT NULL DEFAULT 1,
     created_at    TEXT NOT NULL DEFAULT ${NOW_DEFAULT}
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS UX_organizations_slug ON organizations(slug)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS UX_organizations_name ON organizations(name)`,

  // --- users -----------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS users (
     id                   INTEGER PRIMARY KEY AUTOINCREMENT,
     email                TEXT NOT NULL COLLATE NOCASE,
     password_hash        TEXT NOT NULL,
     role                 TEXT NOT NULL CHECK (role IN ('admin','staff','cdm_contact')),
     school_id            INTEGER REFERENCES schools(id) ON DELETE SET NULL,
     organization_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE NO ACTION,
     display_name         TEXT NOT NULL,
     active               BOOLEAN NOT NULL DEFAULT 1,
     show_on_test_screen  BOOLEAN NOT NULL DEFAULT 0,
     created_at           TEXT NOT NULL DEFAULT ${NOW_DEFAULT}
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS UX_users_email ON users(email)`,
  `CREATE INDEX IF NOT EXISTS IX_users_school ON users(school_id)`,
  `CREATE INDEX IF NOT EXISTS IX_users_organization ON users(organization_id)`,

  // --- forms -----------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS forms (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     title           TEXT NOT NULL,
     description     TEXT,
     school_id       INTEGER REFERENCES schools(id) ON DELETE CASCADE,
     designer_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
     organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE NO ACTION,
     status          TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','published','archived')),
     code            TEXT COLLATE NOCASE,
     submission_seq  INTEGER NOT NULL DEFAULT 0,
     view_columns    TEXT,
     doc_folder_id   TEXT,
     google_form_url TEXT,
     created_at      TEXT NOT NULL DEFAULT ${NOW_DEFAULT},
     updated_at      TEXT NOT NULL DEFAULT ${NOW_DEFAULT}
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS UX_forms_code ON forms(code)`,
  `CREATE INDEX IF NOT EXISTS IX_forms_school ON forms(school_id)`,
  `CREATE INDEX IF NOT EXISTS IX_forms_status ON forms(status)`,
  `CREATE INDEX IF NOT EXISTS IX_forms_organization ON forms(organization_id)`,

  // --- form_fields -----------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS form_fields (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     form_id     INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
     label       TEXT NOT NULL,
     type        TEXT NOT NULL
                 CHECK (type IN ('text','textarea','number','date','select','checkbox','radio','email')),
     options     TEXT,
     required    BOOLEAN NOT NULL DEFAULT 0,
     staff_only  BOOLEAN NOT NULL DEFAULT 0,
     sort_order  INTEGER NOT NULL DEFAULT 0,
     placeholder TEXT,
     roles       TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS IX_form_fields_form ON form_fields(form_id)`,

  // --- submissions -----------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS submissions (
     id                      INTEGER PRIMARY KEY AUTOINCREMENT,
     public_id               TEXT NOT NULL COLLATE NOCASE,
     form_id                 INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
     school_id               INTEGER REFERENCES schools(id) ON DELETE NO ACTION,
     organization_id         INTEGER NOT NULL REFERENCES organizations(id) ON DELETE NO ACTION,
     status                  TEXT NOT NULL DEFAULT 'submitted'
                             CHECK (status IN ('submitted','in_review','flagged','completed')),
     submission_seq          INTEGER,
     school_year             TEXT,
     staff_fields_updated_by INTEGER,
     staff_fields_updated_at TEXT,
     submitted_at            TEXT NOT NULL DEFAULT ${NOW_DEFAULT},
     updated_at              TEXT NOT NULL DEFAULT ${NOW_DEFAULT}
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS UX_submissions_public_id ON submissions(public_id)`,
  `CREATE INDEX IF NOT EXISTS IX_submissions_submitted_at ON submissions(submitted_at)`,
  `CREATE INDEX IF NOT EXISTS IX_submissions_org_school_form
     ON submissions(organization_id, school_id, form_id)`,

  // --- submission_values -----------------------------------------------------
  `CREATE TABLE IF NOT EXISTS submission_values (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
     field_id      INTEGER NOT NULL REFERENCES form_fields(id) ON DELETE NO ACTION,
     value         TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS IX_submission_values_submission
     ON submission_values(submission_id)`,
  `CREATE INDEX IF NOT EXISTS IX_submission_values_field ON submission_values(field_id)`,

  // --- submission_adhoc_fields ----------------------------------------------
  `CREATE TABLE IF NOT EXISTS submission_adhoc_fields (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
     label         TEXT NOT NULL,
     type          TEXT NOT NULL
                   CHECK (type IN ('text','textarea','number','date','select','checkbox','radio','email')),
     options       TEXT,
     value         TEXT,
     sort_order    INTEGER NOT NULL DEFAULT 0,
     created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at    TEXT NOT NULL DEFAULT ${NOW_DEFAULT},
     updated_at    TEXT NOT NULL DEFAULT ${NOW_DEFAULT}
   )`,
  `CREATE INDEX IF NOT EXISTS IX_adhoc_fields_submission
     ON submission_adhoc_fields(submission_id)`,

  // --- app_settings ----------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS app_settings (
     "key"      TEXT NOT NULL PRIMARY KEY,
     "value"    TEXT NOT NULL,
     updated_at TEXT NOT NULL DEFAULT ${NOW_DEFAULT}
   )`,

  // --- documents -------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS documents (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
     document_id   TEXT,
     status        TEXT NOT NULL DEFAULT 'Pending'
                   CHECK (status IN ('Pending','Completed','Failed')),
     created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at    TEXT NOT NULL DEFAULT ${NOW_DEFAULT},
     updated_at    TEXT NOT NULL DEFAULT ${NOW_DEFAULT},
     error         TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS IX_documents_submission ON documents(submission_id)`,

  // --- report_views ----------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS report_views (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     organization_id INTEGER,
     name            TEXT NOT NULL,
     form_id         INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
     filters         TEXT,
     columns         TEXT,
     format          TEXT NOT NULL DEFAULT 'csv',
     is_default      BOOLEAN NOT NULL DEFAULT 0,
     last_used_at    TEXT,
     created_at      TEXT NOT NULL DEFAULT ${NOW_DEFAULT},
     updated_at      TEXT NOT NULL DEFAULT ${NOW_DEFAULT}
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS UX_report_views_user_name ON report_views(user_id, name)`,
  `CREATE INDEX IF NOT EXISTS IX_report_views_user ON report_views(user_id)`,

  // --- reference data --------------------------------------------------------
  // The two known organizations, seeded idempotently exactly as the SQL Server
  // ladder does.
  `INSERT INTO organizations (slug, name)
     SELECT 'academics', 'Academics'
     WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE slug = 'academics')`,
  `INSERT INTO organizations (slug, name)
     SELECT 'technology-services', 'Technology Services'
     WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE slug = 'technology-services')`,
];

function returningList(returning: string[]): string {
  return returning.join(", ");
}

export const tursoDialect: Dialect = {
  kind: "turso",

  ddl: TURSO_DDL,

  // Columns that post-date the first Turso databases. `ddl` is the FINAL schema,
  // so a fresh database gets these from its CREATE TABLE — but a database created
  // before the column existed only gains it here, because SQLite has no
  // `ALTER TABLE ADD COLUMN IF NOT EXISTS` (docs/plans/dual-db.md §5.3).
  addColumns: [
    {
      table: "users",
      column: "show_on_test_screen",
      definition: "BOOLEAN NOT NULL DEFAULT 0",
    },
  ],

  insertReturning({ table, columns, returning, values }) {
    return (
      `INSERT INTO ${table} (${columns.join(", ")}) ` +
      `VALUES (${values}) ` +
      `RETURNING ${returningList(returning)}`
    );
  },

  updateReturning({ table, set, where, returning }) {
    return `UPDATE ${table} SET ${set} WHERE ${where} RETURNING ${returningList(returning)}`;
  },

  deleteReturning({ table, where, returning }) {
    return `DELETE FROM ${table} WHERE ${where} RETURNING ${returningList(returning)}`;
  },

  selectSchoolsPage({ where, orderBy }) {
    // SQLite does not require ORDER BY for LIMIT/OFFSET.
    return (
      `SELECT id, source_id, name, grade_level, calendar, district, created_at\n` +
      `     FROM schools\n` +
      `     ${where}\n` +
      `     ORDER BY ${orderBy}\n` +
      `     LIMIT @pageSize OFFSET @offset`
    );
  },

  upsertSetting() {
    // Replaces the SQL Server MERGE. `RETURNING` reports both the inserted and
    // the updated row, so both branches are covered by one statement.
    //
    // `${NOW}` literally, not `SYSUTCDATETIME()`: the Turso dialect must not
    // depend on the driver's token rewrite (see the header note above), and
    // `libsql.test.ts` enforces that no SQL Server-only token survives outside
    // the SQL Server dialect.
    return (
      `INSERT INTO app_settings ("key", "value", updated_at)\n` +
      `     VALUES (@key, @value, ${NOW})\n` +
      `     ON CONFLICT("key") DO UPDATE SET\n` +
      `       "value" = excluded."value",\n` +
      `       updated_at = ${NOW}\n` +
      `     RETURNING "key"`
    );
  },

  upsertSchoolFromSource() {
    return (
      `INSERT INTO schools (source_id, name, grade_level, calendar, district)\n` +
      `     VALUES (@sourceId, @name, @gradeLevel, @calendar, @district)\n` +
      `     ON CONFLICT(source_id) DO UPDATE SET\n` +
      `       name = excluded.name,\n` +
      `       grade_level = excluded.grade_level,\n` +
      `       calendar = excluded.calendar,\n` +
      `       district = COALESCE(excluded.district, schools.district)\n` +
      `     RETURNING id, source_id, name, grade_level, calendar, district, created_at`
    );
  },

  submissionValueSubquery(label) {
    // The SQL Server spelling is `SELECT TOP 1 …`; libSQL rejects `TOP`
    // outright, so the limit moves to the tail. The predicate is shared with the
    // SQL Server builder so the two cannot drift.
    return (
      `(SELECT sv.value\n` +
      `       FROM submission_values sv\n` +
      `       JOIN form_fields ff ON ff.id = sv.field_id\n` +
      `      WHERE sv.submission_id = s.id\n` +
      `        AND ${submissionValuePredicate(label)}\n` +
      `        AND sv.value IS NOT NULL\n` +
      `      ORDER BY ff.sort_order\n` +
      `      LIMIT 1)`
    );
  },
};

// Re-exported so the migration script can create the schema without going
// through the dialect singleton.
export { NOW as TURSO_NOW_EXPRESSION };
