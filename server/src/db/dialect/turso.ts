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

  // --- roles -----------------------------------------------------------------
  // The mutable role catalog (Settings → Roles). `role_key` is what users.role
  // stores and what the four JSON-array stores already hold. Its UNIQUE index is
  // load-bearing: an FK target needs one, and that FK is what makes "a role that
  // has been assigned cannot be deleted" a database rule.
  //
  // SQLite enforces FKs only when `PRAGMA foreign_keys = ON`, which
  // driver/libsql.ts sets on open — without it the DELETE guard below would be
  // silently advisory on this dialect and enforced on SQL Server, which is the
  // worst of both.
  `CREATE TABLE IF NOT EXISTS roles (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     role_key      TEXT NOT NULL COLLATE NOCASE,
     label         TEXT NOT NULL,
     description   TEXT,
     badge         TEXT,
     can_view      BOOLEAN NOT NULL DEFAULT 1,
     can_edit      BOOLEAN NOT NULL DEFAULT 0,
     can_export    BOOLEAN NOT NULL DEFAULT 0,
     can_report    BOOLEAN NOT NULL DEFAULT 0,
     school_scoped BOOLEAN NOT NULL DEFAULT 0,
     is_admin      BOOLEAN NOT NULL DEFAULT 0,
     built_in      BOOLEAN NOT NULL DEFAULT 0,
     created_at    TEXT NOT NULL DEFAULT ${NOW_DEFAULT},
     updated_at    TEXT NOT NULL DEFAULT ${NOW_DEFAULT}
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS UX_roles_key ON roles(role_key)`,

  // --- users -----------------------------------------------------------------
  // No CHECK on `role` any more, deliberately: the valid set is data, so the
  // constraint is the foreign key rather than a list written into the DDL. That
  // is strictly stronger — a CHECK can only test a list frozen at migration
  // time, while the FK tests the table an admin actually edits.
  `CREATE TABLE IF NOT EXISTS users (
     id                   INTEGER PRIMARY KEY AUTOINCREMENT,
     email                TEXT NOT NULL COLLATE NOCASE,
     password_hash        TEXT NOT NULL,
     role                 TEXT NOT NULL COLLATE NOCASE REFERENCES roles(role_key) ON DELETE NO ACTION,
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
     -- docs/plans/public-private-forms.md. 'public' is the default and the value
     -- of every row that predates the column, so shipping it narrows nothing
     -- until an administrator marks a form private.
     visibility      TEXT NOT NULL DEFAULT 'public'
                     CHECK (visibility IN ('public','private')),
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
     declared_school_name    TEXT,
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

  // --- form_access / form_access_events --------------------------------------
  // Public / Private forms (docs/plans/public-private-forms.md).
  //
  // ★ NO FOREIGN KEYS, matching system_message_dismissals and webhook_events: a
  // deleted user or form must not be blocked by its access rows (they are removed
  // explicitly when the parent goes). On SQLite FK enforcement is off by default
  // anyway, so declaring them would be a claim the engine does not honour.
  //
  // ★ PRIMARY KEY (user_id, form_id) is the idempotency mechanism — see the SQL
  // Server declaration for the full reasoning.
  `CREATE TABLE IF NOT EXISTS form_access (
     user_id      INTEGER NOT NULL,
     form_id      INTEGER NOT NULL,
     status       TEXT NOT NULL CHECK (status IN ('pending','approved','denied')),
     source       TEXT NOT NULL CHECK (source IN ('request','backfill','direct')),
     requested_at TEXT NOT NULL DEFAULT ${NOW_DEFAULT},
     decided_at   TEXT,
     decided_by   INTEGER,
     note         TEXT,
     PRIMARY KEY (user_id, form_id)
   )`,
  // Append-only audit log. NEVER read by the visibility predicate — see the SQL
  // Server declaration. `actor_id` is nullable: NULL for a self-service request.
  `CREATE TABLE IF NOT EXISTS form_access_events (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id    INTEGER NOT NULL,
     form_id    INTEGER NOT NULL,
     event      TEXT NOT NULL
                CHECK (event IN ('requested','withdrawn','approved','declined','revoked','backfilled')),
     actor_id   INTEGER,
     note       TEXT,
     created_at TEXT NOT NULL DEFAULT ${NOW_DEFAULT}
   )`,

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

  // --- system messages -------------------------------------------------------
  // Admin-authored notices (docs/plans/system-messages.md). Two NEW tables, so
  // no `addColumns` entry is needed — that list is only for columns added to a
  // table an earlier revision already created.
  //
  // No foreign keys, same reasoning as webhook_events above: a deleted message
  // must not be blocked by its dismissals, and the dismissals for a message are
  // removed explicitly by deleteSystemMessage in the same transaction.
  //
  // `dismissed_at` MUST be listed in TIMESTAMP_COLUMNS (db/client.ts) — it reads
  // back as a string here and a Date on SQL Server, and that set is what unifies
  // the two.
  //
  // `audience` holds a JSON array of roles (`'["admin","staff"]'`), the same
  // storage form as form_fields.roles; NULL means "every role". It is NOT a
  // boolean or a timestamp, so it must not appear in BOOLEAN_COLUMNS or
  // TIMESTAMP_COLUMNS.
  `CREATE TABLE IF NOT EXISTS system_messages (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     organization_id INTEGER NOT NULL,
     title           TEXT NOT NULL,
     body            TEXT NOT NULL DEFAULT '',
     active          INTEGER NOT NULL DEFAULT 0,
     audience        TEXT,
     created_by      INTEGER,
     created_at      TEXT NOT NULL DEFAULT ${NOW_DEFAULT},
     updated_at      TEXT NOT NULL DEFAULT ${NOW_DEFAULT}
   )`,
  `CREATE INDEX IF NOT EXISTS IX_system_messages_org_active
     ON system_messages(organization_id, active, created_at DESC)`,
  // PK (message_id, user_id) is both the idempotency mechanism and the index the
  // active-list query reads by, so no second index is declared.
  `CREATE TABLE IF NOT EXISTS system_message_dismissals (
     message_id   INTEGER NOT NULL,
     user_id      INTEGER NOT NULL,
     dismissed_at TEXT NOT NULL DEFAULT ${NOW_DEFAULT},
     PRIMARY KEY (message_id, user_id)
   )`,

  // School Name Matching (docs/plans/school-name-reconciliation.md). An
  // admin-authored map from a submitted school SPELLING to an app school;
  // `submitted_name` is the NORMALISED key (LOWER(TRIM(...))).
  //
  // `COLLATE NOCASE` replaces SQL Server's default case-insensitive collation on
  // the key, so `WHERE submitted_name = @x` matches a differently-cased spelling
  // and the UNIQUE index dedupes case-insensitively — exactly as SQL Server's
  // index does. The `ON CONFLICT(submitted_name)` upsert below requires this
  // UNIQUE index to exist.
  //
  // `school_id` is NULLABLE (NULL = "Ignore"); the FK is NO ACTION, mirroring
  // SQL Server. New table, so no `addColumns` entry is needed.
  `CREATE TABLE IF NOT EXISTS school_name_aliases (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     submitted_name TEXT NOT NULL COLLATE NOCASE,
     display_name   TEXT NOT NULL,
     school_id      INTEGER REFERENCES schools(id) ON DELETE NO ACTION,
     created_by     INTEGER,
     created_at     TEXT NOT NULL DEFAULT ${NOW_DEFAULT}
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS UX_school_name_aliases_name ON school_name_aliases(submitted_name)`,

  // --- reference data --------------------------------------------------------
  // The two known organizations, seeded idempotently exactly as the SQL Server
  // ladder does.
  `INSERT INTO organizations (slug, name)
     SELECT 'academics', 'Academics'
     WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE slug = 'academics')`,
  `INSERT INTO organizations (slug, name)
     SELECT 'technology-services', 'Technology Services'
     WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE slug = 'technology-services')`,

  // The four built-in roles, seeded exactly as the SQL Server ladder does, one
  // row at a time and only when absent. `can_report = 1` on all four because
  // routes/reports.ts already holds REPORT_ROLES = ["staff","cdm_contact",
  // "admin"] — every current role has report access, so seeding anything less
  // would be a behaviour change rather than a new feature.
  `INSERT INTO roles (role_key, label, description, can_view, can_edit, can_export, can_report, school_scoped, is_admin, built_in)
     SELECT 'admin', 'Administrator', 'Full access, including users, schools and system settings.', 1, 1, 1, 1, 0, 1, 1
     WHERE NOT EXISTS (SELECT 1 FROM roles WHERE role_key = 'admin')`,
  `INSERT INTO roles (role_key, label, description, can_view, can_edit, can_export, can_report, school_scoped, is_admin, built_in)
     SELECT 'staff', 'Staff', 'Day-to-day form work: read, edit and export submissions.', 1, 1, 1, 1, 0, 0, 1
     WHERE NOT EXISTS (SELECT 1 FROM roles WHERE role_key = 'staff')`,
  `INSERT INTO roles (role_key, label, description, can_view, can_edit, can_export, can_report, school_scoped, is_admin, built_in)
     SELECT 'cdm_contact', 'School Contact', 'Staff access, limited to their own school.', 1, 1, 1, 1, 1, 0, 1
     WHERE NOT EXISTS (SELECT 1 FROM roles WHERE role_key = 'cdm_contact')`,
  `INSERT INTO roles (role_key, label, description, can_view, can_edit, can_export, can_report, school_scoped, is_admin, built_in)
     SELECT 'reviewer', 'Reviewer', 'Read, export and report. Cannot change submissions.', 1, 0, 1, 1, 0, 0, 1
     WHERE NOT EXISTS (SELECT 1 FROM roles WHERE role_key = 'reviewer')`,

  // Re-derive the built-ins' SECURITY flags from code on every boot, mirroring
  // the SQL Server ladder. This is what stops a stray UPDATE from permanently
  // granting write access to a role the guards trust; `updated_at` is left alone
  // because these values are derived and a timestamp on them would only record
  // when the app last started.
  `UPDATE roles SET can_view=1, can_edit=1, can_export=1, can_report=1, school_scoped=0, is_admin=1, built_in=1 WHERE role_key = 'admin'`,
  `UPDATE roles SET can_view=1, can_edit=1, can_export=1, can_report=1, school_scoped=0, is_admin=0, built_in=1 WHERE role_key = 'staff'`,
  `UPDATE roles SET can_view=1, can_edit=1, can_export=1, can_report=1, school_scoped=1, is_admin=0, built_in=1 WHERE role_key = 'cdm_contact'`,
  `UPDATE roles SET can_view=1, can_edit=0, can_export=1, can_report=1, school_scoped=0, is_admin=0, built_in=1 WHERE role_key = 'reviewer'`,
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
    {
      // System Messages. The table itself is new on this revision, so a database
      // that only ever ran the FINAL schema gets `audience` from its CREATE
      // TABLE — but a database that booted an earlier revision of the same
      // branch already has the table without the column, and SQLite has no
      // `ADD COLUMN IF NOT EXISTS`. Listed for exactly that window. Must match
      // TURSO_DDL and schema.ts; NULL means "every role".
      table: "system_messages",
      column: "audience",
      definition: "TEXT",
    },
    {
      // Public / Private forms (docs/plans/public-private-forms.md). In
      // `TURSO_DDL` as well, so a fresh database gets it from CREATE TABLE; this
      // entry is for a database created before the column existed. SQLite cannot
      // add a CHECK via ALTER TABLE, so the constraint lives only in the CREATE
      // TABLE above — which is why the app must also validate `visibility` on
      // write rather than trusting the database (dual-db.md §5.3's asymmetry).
      // `form_access` and `form_access_events` are both brand-new tables, so
      // neither needs an entry here.
      table: "forms",
      column: "visibility",
      definition: "TEXT NOT NULL DEFAULT 'public'",
    },
    {
      // School Name Matching (docs/plans/school-name-reconciliation.md). The
      // school name a submission's own answers declared, recorded at intake. In
      // `TURSO_DDL` as well, so a fresh database gets it from CREATE TABLE; this
      // entry is for a database created before the column existed. It is a plain
      // string — NOT a boolean or a timestamp — so it must not appear in
      // BOOLEAN_COLUMNS or TIMESTAMP_COLUMNS.
      table: "submissions",
      column: "declared_school_name",
      definition: "TEXT",
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

  upsertSchoolAlias() {
    // Replaces the SQL Server MERGE, keyed on the `submitted_name` unique index
    // the DDL declares (which is what `ON CONFLICT` requires). Params:
    // @submittedName (the NORMALISED key), @displayName, @schoolId (nullable —
    // NULL is the "Ignore" state), @createdBy. Re-matching the same spelling to a
    // different school updates the row in place.
    return (
      `INSERT INTO school_name_aliases (submitted_name, display_name, school_id, created_by)\n` +
      `     VALUES (@submittedName, @displayName, @schoolId, @createdBy)\n` +
      `     ON CONFLICT(submitted_name) DO UPDATE SET\n` +
      `       display_name = excluded.display_name,\n` +
      `       school_id = excluded.school_id,\n` +
      `       created_by = excluded.created_by\n` +
      `     RETURNING id, submitted_name, display_name, school_id, created_by, created_at`
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
    //
    // ★ The alias joins (docs/plans/school-name-reconciliation.md §4.4.1) are the
    // SQL sibling of `findSchoolIdByName`: `COALESCE(scs.name, acs.name, sv.value)`
    // means an APP school name — exact match, else an admin-confirmed alias —
    // wins over the parent's typed text. Without `acs.name` a re-filed row would
    // store the right `school_id` but still DISPLAY the typo.
    return (
      `(SELECT COALESCE(scs.name, acs.name, sv.value)\n` +
      `       FROM submission_values sv\n` +
      `       JOIN form_fields ff ON ff.id = sv.field_id\n` +
      `       LEFT JOIN schools scs ON LOWER(scs.name) = LOWER(LTRIM(RTRIM(sv.value)))\n` +
      `       LEFT JOIN school_name_aliases a ON LOWER(a.submitted_name) = LOWER(LTRIM(RTRIM(sv.value)))\n` +
      `       LEFT JOIN schools acs ON acs.id = a.school_id\n` +
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
