import { submissionValuePredicate, schoolFieldPredicate } from "./shared.js";
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
     must_change_password BOOLEAN NOT NULL DEFAULT 0,
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
     pre_archive_status TEXT,
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
     archived_at             TEXT,
     archived_by             INTEGER,
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

  // --- user_form_view_columns -----------------------------------------------
  // The per-user Submissions grid column selection. Supersedes forms.view_columns,
  // which held ONE value per form and so was shared by every user — once staff
  // and School Contacts got the column chooser too, a save by any of them would
  // have rewritten what the org admin saw. Same per-user shape as report_views.
  `CREATE TABLE IF NOT EXISTS user_form_view_columns (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     form_id    INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
     columns    TEXT,
     created_at TEXT NOT NULL DEFAULT ${NOW_DEFAULT},
     updated_at TEXT NOT NULL DEFAULT ${NOW_DEFAULT}
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS UX_ufvc_user_form ON user_form_view_columns(user_id, form_id)`,

  // Carry the one legacy forms.view_columns value over to the form's designer,
  // who is the person most likely to have set it. Idempotent, and deliberately
  // best-effort: a form with no designer_id has no recoverable owner and simply
  // starts unconfigured. Mirrors the SQL Server ladder.
  `INSERT INTO user_form_view_columns (user_id, form_id, columns)
     SELECT f.designer_id, f.id, f.view_columns
       FROM forms f
      WHERE f.view_columns IS NOT NULL
        AND f.designer_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM user_form_view_columns u
                         WHERE u.user_id = f.designer_id AND u.form_id = f.id)`,

  // --- webhook_events --------------------------------------------------------
  // Inbound webhook intake log (docs/plans/webhook-log.md). NO foreign keys, by
  // design: every candidate FK here would either destroy the audit trail with a
  // CASCADE or block an existing delete with NO ACTION, and form_id must be
  // recordable for a form that does not exist.
  //
  // `received_at` is a TEXT ISO-8601 instant and MUST also be listed in
  // TIMESTAMP_COLUMNS (db/client.ts) — on Turso it reads back as a string, on
  // SQL Server as a Date, and that set is what unifies the two.
  `CREATE TABLE IF NOT EXISTS webhook_events (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     source        TEXT NOT NULL DEFAULT 'google',
     received_at   TEXT NOT NULL DEFAULT ${NOW_DEFAULT},
     remote_ip     TEXT,
     user_agent    TEXT,
     auth_result   TEXT NOT NULL,
     status        TEXT NOT NULL,
     http_status   INTEGER NOT NULL,
     error_code    TEXT,
     error         TEXT,
     form_id       INTEGER,
     organization_id INTEGER,
     submission_id INTEGER,
     public_id     TEXT,
     payload_raw   TEXT,
     payload_bytes INTEGER,
     payload_hash  TEXT,
     replay_of     INTEGER,
     replayed_by   INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS IX_webhook_events_received ON webhook_events(received_at DESC)`,
  `CREATE INDEX IF NOT EXISTS IX_webhook_events_status ON webhook_events(status, received_at DESC)`,
  `CREATE INDEX IF NOT EXISTS IX_webhook_events_form ON webhook_events(form_id, received_at DESC)`,
  `CREATE INDEX IF NOT EXISTS IX_webhook_events_org ON webhook_events(organization_id, received_at DESC)`,
  `CREATE INDEX IF NOT EXISTS IX_webhook_events_replay_of ON webhook_events(replay_of)`,

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
    {
      // Admin password reset. Marked by POST /api/users/{id}/reset-password and
      // cleared by the user's own change-password call, so a temporary password
      // handed over by an administrator is not a permanent one. DEFAULT 0 keeps
      // every pre-existing account working exactly as before.
      table: "users",
      column: "must_change_password",
      definition: "BOOLEAN NOT NULL DEFAULT 0",
    },
    {
      // Archive & Restore. Holds the status a form held just before it was
      // archived so Restore can return it to exactly that status; NULL for any
      // form that is not currently archived.
      table: "forms",
      column: "pre_archive_status",
      definition: "TEXT",
    },
    {
      // Webhook Log. The organization an intake attempt is attributed to, stored
      // as a COLUMN rather than derived from the `form_id` join (a deleted form
      // would blank the join and the row would disappear from every admin's view).
      // Must match `TURSO_DDL` and `schema.ts` exactly; it was added to this table
      // after the first Turso deployment, which is precisely the case this list
      // exists for — and it also carries IX_webhook_events_org, which the index
      // batch below cannot create until the column is present.
      table: "webhook_events",
      column: "organization_id",
      definition: "INTEGER",
    },
    {
      // Archive. Both columns are in `TURSO_DDL` as well, so a fresh database
      // gets them from CREATE TABLE; this is for databases created before the
      // feature. `archived_at` must ALSO be listed in TIMESTAMP_COLUMNS
      // (db/client.ts) or it reads back as a string on Turso and a Date on SQL
      // Server — the libsql.test.ts honesty guard enforces that pairing.
      table: "submissions",
      column: "archived_at",
      definition: "TEXT",
    },
    {
      table: "submissions",
      column: "archived_by",
      definition: "INTEGER",
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

  selectPage({ select, from, where, orderBy }) {
    // SQLite does not require ORDER BY for LIMIT/OFFSET.
    return (
      `SELECT ${select}\n` +
      `     FROM ${from}\n` +
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

  upsertUserFormViewColumns() {
    // Replaces the SQL Server MERGE, keyed on the (user_id, form_id) unique
    // index. `${NOW}` literally, not `SYSUTCDATETIME()` — the Turso dialect must
    // not depend on the driver's token rewrite (see the header note above).
    return (
      `INSERT INTO user_form_view_columns (user_id, form_id, columns, updated_at)\n` +
      `     VALUES (@userId, @formId, @value, ${NOW})\n` +
      `     ON CONFLICT(user_id, form_id) DO UPDATE SET\n` +
      `       columns = excluded.columns,\n` +
      `       updated_at = ${NOW}\n` +
      `     RETURNING id`
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

  submissionSchoolNameSubquery() {
    // Same limit relocation as `submissionValueSubquery`, and the same shared
    // predicate — including the LOWER() match, which matters more here than on
    // SQL Server because libSQL's `=` is case-sensitive. The answer is trimmed
    // before comparison to agree with the insert-time resolver and the backfill
    // script; see the SQL Server variant for the full reasoning.
    return (
      `(SELECT COALESCE(scs.name, sv.value)\n` +
      `       FROM submission_values sv\n` +
      `       JOIN form_fields ff ON ff.id = sv.field_id\n` +
      `       LEFT JOIN schools scs ON LOWER(scs.name) = LOWER(LTRIM(RTRIM(sv.value)))\n` +
      `      WHERE sv.submission_id = s.id\n` +
      `        AND ${schoolFieldPredicate()}\n` +
      `        AND sv.value IS NOT NULL\n` +
      `        AND LTRIM(RTRIM(sv.value)) <> ''\n` +
      `      ORDER BY ff.sort_order, scs.id\n` +
      `      LIMIT 1)`
    );
  },
};

// Re-exported so the migration script can create the schema without going
// through the dialect singleton.
export { NOW as TURSO_NOW_EXPRESSION };
