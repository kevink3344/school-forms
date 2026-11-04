# SQL Server schema deploy — objects and scripts for the latest changes

Applies to **any Azure SQL (SQL Server) database** this app runs against —
production **and** the `staging` slot (both report `dbMode: "sqlserver"`; only a
`DB_MODE=turso` deployment would be different). The schema is not versioned by
files: the server applies a *cumulative, idempotent* migration ladder at every boot
(`SQLSERVER_DDL_STATEMENTS` in `server/src/db/schema.ts`, run by `initDb()` in
`server/src/db/pool.ts`). Nothing here needs a migration tool — the SQL below is
the same DDL the app runs, in the same order, so running it by hand and then
letting the app boot are equivalent.

> **Order matters.** The ladder is split into batches because SQL Server compiles a
> batch before running it — a statement that references a column added in the same
> batch fails with error 207. Run the numbered steps one at a time, in order, and
> keep the `GO` separators. Every statement is guarded, so re-running any step is a
> no-op.
>
> **You may not need to run any of this by hand.** The ladder runs at startup, so
> deploying the new code applies all of it automatically. The value of running it
> manually first is that a failure (e.g. a column type that blocks an index) is
> visible in the query window instead of aborting the boot with `dbReady=false`.
>
> **If you are behind a firewall** and cannot reach the SQL server from your machine,
> the only path is the app itself: deploy, then read the startup log
> (`[db] Database ready (mode=sqlserver): tables/indexes ensured.`). Steps 1–5 are
> then informational — they document exactly what that boot applies, and are useful
> for review or for someone with portal access to the Query editor.

> ## ⚠️ When the app cannot apply the ladder itself
>
> `dbReady=false` in `/api/health` means the ladder stopped. `run()` executes the
> ladder **batch by batch and stops at the first failure**, so every batch after the
> failing one is silently unapplied — the log line `DDL batch N of M failed and every
> batch after it was not applied: …` names the culprit. The usual causes:
>
> | Symptom in the log | Cause | Fix |
> |---|---|---|
> | `Invalid column name 'x'` on a route | the ladder stopped earlier | find the batch that failed |
> | `Could not create constraint or index` / index on a text column | the column is `nvarchar(max)` on a copied database | narrow the column (§8) |
> | `The ALTER TABLE statement conflicted with the FOREIGN KEY` / error 1750 | `int` vs `bigint` ids | §8 |
> | `Cannot add foreign key constraint … may cause cycles or multiple cascade paths` (1785) | copied database's FK shapes | §8 |
>
> **A deployment whose database already holds rows cannot be fixed by the app alone.**
> The ladder is written for a database it created; on a *copied* database (staging is
> one) the failing batch is usually a data-dependent one — e.g. the
> `users.organization_id NOT NULL` tighten, or a `CHECK` re-add — and the remaining
> batches (the newest tables) never run. In that case run **§8** first, then re-deploy
> or restart the slot.

---

## 0. Pre-flight — what does the target already have?

```sql
SELECT name FROM sys.tables WHERE schema_id = SCHEMA_ID('dbo') ORDER BY name;

SELECT OBJECT_NAME(parent_object_id) AS table_name, name AS column_name
  FROM sys.columns
 WHERE OBJECT_NAME(parent_object_id) IN
       ('schools','organizations','roles','users','forms','form_fields',
        'submissions','submission_adhoc_fields','webhook_events','system_messages')
 ORDER BY table_name, column_id;

SELECT name, OBJECT_NAME(object_id) AS table_name
  FROM sys.indexes
 WHERE name IN ('UX_schools_name','UX_schools_source_id','UX_organizations_slug',
                'UX_organizations_name','UX_roles_key','UX_users_email','IX_users_school',
                'IX_users_organization','IX_forms_school','IX_forms_status','UX_forms_code',
                'IX_forms_organization','IX_form_fields_form','UX_submissions_public_id',
                'IX_submissions_submitted_at','IX_submissions_org_school_form',
                'IX_submission_values_submission','IX_submission_values_field',
                'IX_adhoc_fields_submission','UX_report_views_user_name','IX_report_views_user',
                'IX_documents_submission','UX_ufvc_user_form',
                'IX_webhook_events_received','IX_webhook_events_status','IX_webhook_events_form',
                'IX_webhook_events_org','IX_webhook_events_replay_of',
                'IX_system_messages_org_active','UX_school_name_aliases_name',
                'IX_submission_attachments_submission','IX_submission_links_submission');
```

Anything missing from those three results is created by the steps below.

---

## 1. Tables new in the latest changes

```sql
-- 1a. Roles catalog (Settings → Roles). users.role becomes an FK to role_key.
-- NOTE: `CREATE TABLE` is the first statement of its batch, because SQL Server
-- compiles a batch before running it and a following statement naming `dbo.roles`
-- would fail with "Invalid object name" on a database that lacks the table.
IF OBJECT_ID('dbo.roles', 'U') IS NULL
CREATE TABLE dbo.roles (
  id            INT IDENTITY(1,1) PRIMARY KEY,
  role_key      NVARCHAR(40) NOT NULL,
  label         NVARCHAR(80) NOT NULL,
  description   NVARCHAR(200) NULL,
  badge         NVARCHAR(30) NULL,
  can_view      BIT NOT NULL CONSTRAINT DF_roles_can_view DEFAULT 1,
  can_edit      BIT NOT NULL CONSTRAINT DF_roles_can_edit DEFAULT 0,
  can_export    BIT NOT NULL CONSTRAINT DF_roles_can_export DEFAULT 0,
  can_report    BIT NOT NULL CONSTRAINT DF_roles_can_report DEFAULT 0,
  school_scoped BIT NOT NULL CONSTRAINT DF_roles_school_scoped DEFAULT 0,
  is_admin      BIT NOT NULL CONSTRAINT DF_roles_is_admin DEFAULT 0,
  built_in      BIT NOT NULL CONSTRAINT DF_roles_built_in DEFAULT 0,
  created_at    DATETIME2 NOT NULL CONSTRAINT DF_roles_created_at DEFAULT SYSUTCDATETIME(),
  updated_at    DATETIME2 NOT NULL CONSTRAINT DF_roles_updated_at DEFAULT SYSUTCDATETIME()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_roles_key')
  CREATE UNIQUE INDEX UX_roles_key ON dbo.roles(role_key);
GO
-- Seed the four built-in roles (idempotent).
IF NOT EXISTS (SELECT 1 FROM dbo.roles WHERE role_key = N'admin')
  INSERT INTO dbo.roles (role_key, label, description, can_view, can_edit, can_export, can_report, school_scoped, is_admin, built_in)
  VALUES (N'admin', N'Administrator', N'Full access, including users, schools and system settings.', 1, 1, 1, 1, 0, 1, 1);
IF NOT EXISTS (SELECT 1 FROM dbo.roles WHERE role_key = N'staff')
  INSERT INTO dbo.roles (role_key, label, description, can_view, can_edit, can_export, can_report, school_scoped, is_admin, built_in)
  VALUES (N'staff', N'Staff', N'Day-to-day form work: read, edit and export submissions.', 1, 1, 1, 1, 0, 0, 1);
IF NOT EXISTS (SELECT 1 FROM dbo.roles WHERE role_key = N'cdm_contact')
  INSERT INTO dbo.roles (role_key, label, description, can_view, can_edit, can_export, can_report, school_scoped, is_admin, built_in)
  VALUES (N'cdm_contact', N'School Contact', N'Staff access, limited to their own school.', 1, 1, 1, 1, 1, 0, 1);
IF NOT EXISTS (SELECT 1 FROM dbo.roles WHERE role_key = N'reviewer')
  INSERT INTO dbo.roles (role_key, label, description, can_view, can_edit, can_export, can_report, school_scoped, is_admin, built_in)
  VALUES (N'reviewer', N'Reviewer', N'Read, export and report. Cannot change submissions.', 1, 0, 1, 1, 0, 0, 1);
```

```sql
-- 1b. Per-user Submissions grid column selection (supersedes forms.view_columns).
-- The INSERT is guarded on `forms.view_columns` existing: on a database that has
-- already run the ladder that column is present, and on a brand-new one it is not.
IF COL_LENGTH('dbo.forms', 'view_columns') IS NOT NULL
BEGIN
  IF OBJECT_ID('dbo.user_form_view_columns', 'U') IS NULL
  CREATE TABLE dbo.user_form_view_columns (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    user_id    INT NOT NULL,
    form_id    INT NOT NULL,
    columns    NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_ufvc_created_at DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 NOT NULL CONSTRAINT DF_ufvc_updated_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_ufvc_user FOREIGN KEY (user_id) REFERENCES dbo.users(id) ON DELETE CASCADE,
    CONSTRAINT FK_ufvc_form FOREIGN KEY (form_id) REFERENCES dbo.forms(id) ON DELETE CASCADE
  );
END
GO
IF OBJECT_ID('dbo.user_form_view_columns', 'U') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_ufvc_user_form')
  CREATE UNIQUE INDEX UX_ufvc_user_form ON dbo.user_form_view_columns(user_id, form_id);
GO
-- Carry each form's legacy single column selection to its designer.
IF COL_LENGTH('dbo.forms', 'view_columns') IS NOT NULL
  INSERT INTO dbo.user_form_view_columns (user_id, form_id, columns)
    SELECT f.designer_id, f.id, f.view_columns
      FROM dbo.forms f
     WHERE f.view_columns IS NOT NULL
       AND f.designer_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM dbo.user_form_view_columns u
                        WHERE u.user_id = f.designer_id AND u.form_id = f.id);
```

```sql
-- 1c. Public / Private forms — access requests, grants and audit trail.
IF OBJECT_ID('dbo.form_access', 'U') IS NULL
CREATE TABLE dbo.form_access (
  user_id      INT           NOT NULL,
  form_id      INT           NOT NULL,
  status       NVARCHAR(20)  NOT NULL
      CONSTRAINT CK_form_access_status CHECK (status IN ('pending','approved','denied')),
  source       NVARCHAR(20)  NOT NULL
      CONSTRAINT CK_form_access_source CHECK (source IN ('request','backfill','direct')),
  requested_at DATETIME2     NOT NULL CONSTRAINT DF_form_access_requested DEFAULT SYSUTCDATETIME(),
  decided_at   DATETIME2     NULL,
  decided_by   INT           NULL,
  note         NVARCHAR(400) NULL,
  CONSTRAINT PK_form_access PRIMARY KEY (user_id, form_id)
);
GO
IF OBJECT_ID('dbo.form_access_events', 'U') IS NULL
CREATE TABLE dbo.form_access_events (
  id         INT IDENTITY(1,1) PRIMARY KEY,
  user_id    INT           NOT NULL,
  form_id    INT           NOT NULL,
  event      NVARCHAR(20)  NOT NULL
      CONSTRAINT CK_form_access_events_event
      CHECK (event IN ('requested','withdrawn','approved','declined','revoked','backfilled')),
  actor_id   INT           NULL,
  note       NVARCHAR(400) NULL,
  created_at DATETIME2     NOT NULL CONSTRAINT DF_form_access_events_created DEFAULT SYSUTCDATETIME()
);
GO
IF OBJECT_ID('dbo.form_access_notice_dismissals', 'U') IS NULL
CREATE TABLE dbo.form_access_notice_dismissals (
  event_id     INT NOT NULL,
  user_id      INT NOT NULL,
  dismissed_at DATETIME2 NOT NULL CONSTRAINT DF_fand_dismissed_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_form_access_notice_dismissals PRIMARY KEY (event_id, user_id)
);
```

```sql
-- 1d. Inbound webhook intake log (deliberately no foreign keys).
-- Its batch may also carry the `organization_id` add for a table created by an
-- earlier revision; the index block in §4 covers that column either way.
-- NOTE: run this BEFORE §2, because §2 adds `webhook_events.organization_id`
-- unguarded on the table's existence.
IF OBJECT_ID('dbo.webhook_events', 'U') IS NULL
CREATE TABLE dbo.webhook_events (
  id              INT IDENTITY(1,1) PRIMARY KEY,
  source          NVARCHAR(30) NOT NULL CONSTRAINT DF_webhook_events_source DEFAULT 'google',
  received_at     DATETIME2 NOT NULL CONSTRAINT DF_webhook_events_received_at DEFAULT SYSUTCDATETIME(),
  remote_ip       NVARCHAR(64) NULL,
  user_agent      NVARCHAR(200) NULL,
  auth_result     NVARCHAR(20) NOT NULL,
  status          NVARCHAR(20) NOT NULL,
  http_status     INT NOT NULL,
  error_code      NVARCHAR(40) NULL,
  error           NVARCHAR(MAX) NULL,
  form_id         INT NULL,
  organization_id INT NULL,
  submission_id   INT NULL,
  public_id       NVARCHAR(64) NULL,
  payload_raw     NVARCHAR(MAX) NULL,
  payload_bytes   INT NULL,
  payload_hash    NVARCHAR(64) NULL,
  replay_of       INT NULL,
  replayed_by     INT NULL
);
```

```sql
-- 1e. Admin system messages + per-user dismissals.
IF OBJECT_ID('dbo.system_messages', 'U') IS NULL
CREATE TABLE dbo.system_messages (
  id              INT IDENTITY(1,1) PRIMARY KEY,
  organization_id INT NOT NULL,
  title           NVARCHAR(200) NOT NULL,
  body            NVARCHAR(MAX) NOT NULL CONSTRAINT DF_system_messages_body DEFAULT (''),
  active          BIT NOT NULL CONSTRAINT DF_system_messages_active DEFAULT (0),
  audience        NVARCHAR(200) NULL,
  created_by      INT NULL,
  created_at      DATETIME2 NOT NULL CONSTRAINT DF_system_messages_created_at DEFAULT SYSUTCDATETIME(),
  updated_at      DATETIME2 NOT NULL CONSTRAINT DF_system_messages_updated_at DEFAULT SYSUTCDATETIME()
);
GO
IF OBJECT_ID('dbo.system_message_dismissals', 'U') IS NULL
CREATE TABLE dbo.system_message_dismissals (
  message_id   INT NOT NULL,
  user_id      INT NOT NULL,
  dismissed_at DATETIME2 NOT NULL CONSTRAINT DF_smd_dismissed_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_system_message_dismissals PRIMARY KEY (message_id, user_id)
);
```

```sql
-- 1f. School Name Matching — admin-authored submitted-spelling → school map.
IF OBJECT_ID('dbo.school_name_aliases', 'U') IS NULL
CREATE TABLE dbo.school_name_aliases (
  id             INT IDENTITY(1,1) PRIMARY KEY,
  submitted_name NVARCHAR(200) NOT NULL,
  display_name   NVARCHAR(200) NOT NULL,
  school_id      INT NULL,
  created_by     INT NULL,
  created_at     DATETIME2 NOT NULL CONSTRAINT DF_school_name_aliases_created_at DEFAULT SYSUTCDATETIME()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_school_name_aliases_name')
  CREATE UNIQUE INDEX UX_school_name_aliases_name ON dbo.school_name_aliases(submitted_name);
```

```sql
-- 1g. Staff Attachments — uploaded files and links per submission.
IF OBJECT_ID('dbo.submission_attachments', 'U') IS NULL
CREATE TABLE dbo.submission_attachments (
  id            INT IDENTITY(1,1) PRIMARY KEY,
  submission_id INT NOT NULL,
  drive_file_id NVARCHAR(255) NOT NULL,
  file_name     NVARCHAR(255) NOT NULL,
  mime_type     NVARCHAR(255) NULL,
  size_bytes    BIGINT NULL,
  web_view_link NVARCHAR(1000) NULL,
  uploaded_by   INT NULL,
  uploaded_at   DATETIME2 NOT NULL CONSTRAINT DF_submission_attachments_uploaded_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_submission_attachments_submission FOREIGN KEY (submission_id) REFERENCES dbo.submissions(id) ON DELETE CASCADE,
  CONSTRAINT FK_submission_attachments_uploader FOREIGN KEY (uploaded_by) REFERENCES dbo.users(id) ON DELETE SET NULL
);
GO
IF OBJECT_ID('dbo.submission_links', 'U') IS NULL
CREATE TABLE dbo.submission_links (
  id            INT IDENTITY(1,1) PRIMARY KEY,
  submission_id INT NOT NULL,
  title         NVARCHAR(200) NOT NULL,
  url           NVARCHAR(2048) NOT NULL,
  created_by    INT NULL,
  created_at    DATETIME2 NOT NULL CONSTRAINT DF_submission_links_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_submission_links_submission FOREIGN KEY (submission_id) REFERENCES dbo.submissions(id) ON DELETE CASCADE,
  CONSTRAINT FK_submission_links_creator FOREIGN KEY (created_by) REFERENCES dbo.users(id) ON DELETE SET NULL
);
```

---

## 2. Columns added to existing tables

Each `ALTER` is its own batch (error 207), and each is guarded so it is a no-op
where the column is already present.

```sql
IF COL_LENGTH('dbo.schools', 'source_id') IS NULL
  ALTER TABLE dbo.schools ADD source_id INT NULL;
IF COL_LENGTH('dbo.schools', 'grade_level') IS NULL
  ALTER TABLE dbo.schools ADD grade_level NVARCHAR(50) NULL;
IF COL_LENGTH('dbo.schools', 'calendar') IS NULL
  ALTER TABLE dbo.schools ADD calendar NVARCHAR(50) NULL;
GO
IF COL_LENGTH('dbo.organizations', 'active') IS NULL
  ALTER TABLE dbo.organizations ADD active BIT NOT NULL CONSTRAINT DF_organizations_active DEFAULT 1;
IF COL_LENGTH('dbo.organizations', 'description') IS NULL
  ALTER TABLE dbo.organizations ADD description NVARCHAR(MAX) NULL;
IF COL_LENGTH('dbo.organizations', 'doc_folder_id') IS NULL
  ALTER TABLE dbo.organizations ADD doc_folder_id NVARCHAR(255) NULL;
GO
IF COL_LENGTH('dbo.users', 'active') IS NULL
  ALTER TABLE dbo.users ADD active BIT NOT NULL CONSTRAINT DF_users_active DEFAULT 1;
IF COL_LENGTH('dbo.users', 'show_on_test_screen') IS NULL
  ALTER TABLE dbo.users ADD show_on_test_screen BIT NOT NULL CONSTRAINT DF_users_show_on_test_screen DEFAULT 0;
IF COL_LENGTH('dbo.users', 'must_change_password') IS NULL
  ALTER TABLE dbo.users ADD must_change_password BIT NOT NULL CONSTRAINT DF_users_must_change_password DEFAULT 0;
GO
IF COL_LENGTH('dbo.users', 'organization_id') IS NULL
  ALTER TABLE dbo.users ADD organization_id INT NULL;
GO
IF COL_LENGTH('dbo.forms', 'organization_id') IS NULL
  ALTER TABLE dbo.forms ADD organization_id INT NULL;
GO
IF COL_LENGTH('dbo.forms', 'doc_folder_id') IS NULL
  ALTER TABLE dbo.forms ADD doc_folder_id NVARCHAR(255) NULL;
IF COL_LENGTH('dbo.forms', 'google_form_url') IS NULL
  ALTER TABLE dbo.forms ADD google_form_url NVARCHAR(1000) NULL;
IF COL_LENGTH('dbo.forms', 'view_columns') IS NULL
  ALTER TABLE dbo.forms ADD view_columns NVARCHAR(MAX) NULL;
IF COL_LENGTH('dbo.forms', 'code') IS NULL
  ALTER TABLE dbo.forms ADD code NVARCHAR(20) NULL;
IF COL_LENGTH('dbo.forms', 'submission_seq') IS NULL
  ALTER TABLE dbo.forms ADD submission_seq INT NOT NULL CONSTRAINT DF_forms_submission_seq DEFAULT 0;
IF COL_LENGTH('dbo.forms', 'pre_archive_status') IS NULL
  ALTER TABLE dbo.forms ADD pre_archive_status NVARCHAR(20) NULL;
IF COL_LENGTH('dbo.forms', 'link_field_ids') IS NULL
  ALTER TABLE dbo.forms ADD link_field_ids NVARCHAR(MAX) NULL;
GO
IF COL_LENGTH('dbo.forms', 'visibility') IS NULL
  ALTER TABLE dbo.forms ADD visibility NVARCHAR(10) NOT NULL CONSTRAINT DF_forms_visibility DEFAULT 'public';
GO
IF COL_LENGTH('dbo.forms', 'attachments_enabled') IS NULL
  ALTER TABLE dbo.forms ADD attachments_enabled BIT NOT NULL CONSTRAINT DF_forms_attachments_enabled DEFAULT 0;
IF COL_LENGTH('dbo.forms', 'attachments_roles') IS NULL
  ALTER TABLE dbo.forms ADD attachments_roles NVARCHAR(MAX) NULL;
GO
IF COL_LENGTH('dbo.form_fields', 'roles') IS NULL
  ALTER TABLE dbo.form_fields ADD roles NVARCHAR(MAX) NULL;
IF COL_LENGTH('dbo.form_fields', 'source_item_id') IS NULL
  ALTER TABLE dbo.form_fields ADD source_item_id NVARCHAR(64) NULL;
GO
IF COL_LENGTH('dbo.submissions', 'submission_seq') IS NULL
  ALTER TABLE dbo.submissions ADD submission_seq INT NULL;
IF COL_LENGTH('dbo.submissions', 'school_year') IS NULL
  ALTER TABLE dbo.submissions ADD school_year NVARCHAR(9) NULL;
GO
IF COL_LENGTH('dbo.submissions', 'organization_id') IS NULL
  ALTER TABLE dbo.submissions ADD organization_id INT NULL;
GO
IF COL_LENGTH('dbo.submissions', 'staff_fields_updated_by') IS NULL
  ALTER TABLE dbo.submissions ADD staff_fields_updated_by INT NULL;
IF COL_LENGTH('dbo.submissions', 'staff_fields_updated_at') IS NULL
  ALTER TABLE dbo.submissions ADD staff_fields_updated_at DATETIME2 NULL;
IF COL_LENGTH('dbo.submissions', 'archived_at') IS NULL
  ALTER TABLE dbo.submissions ADD archived_at DATETIME2 NULL;
IF COL_LENGTH('dbo.submissions', 'archived_by') IS NULL
  ALTER TABLE dbo.submissions ADD archived_by INT NULL;
IF COL_LENGTH('dbo.submissions', 'declared_school_name') IS NULL
  ALTER TABLE dbo.submissions ADD declared_school_name NVARCHAR(200) NULL;
GO
IF COL_LENGTH('dbo.webhook_events', 'organization_id') IS NULL
  ALTER TABLE dbo.webhook_events ADD organization_id INT NULL;
GO
IF COL_LENGTH('dbo.system_messages', 'audience') IS NULL
  ALTER TABLE dbo.system_messages ADD audience NVARCHAR(200) NULL;
```

---

## 3. Constraints (CHECK / FK) — what makes the new features actually work

> **Run step 2 before this step.** The ladder adds `users.role`'s FK right after the
> role table and the column widening; the `organization_id` FKs assume the columns
> from §2 already exist.
>
> **Ordering caveat when running by hand:** the ladder tightens
> `users.organization_id` to `NOT NULL` inside its own batch, *before* the FK
> batches below. If any user row still has a NULL organization, that `ALTER COLUMN`
> is skipped by its guard — so run §5a (the backfill) first if you want the column
> tightened, then the FK steps.
>
> **The FK steps assume `dbo.organizations` exists** (it is created by the ladder,
> not by this document). Check first:
> `SELECT OBJECT_ID('dbo.organizations');` — a NULL means the ladder has never run
> against this database, and the app's own boot will create it.

```sql
-- 3a. users.role: drop the old fixed-list CHECK, widen the column, add the FK to dbo.roles.
DECLARE @drop_role_checks nvarchar(max) = N'';
SELECT @drop_role_checks = @drop_role_checks
     + N'ALTER TABLE dbo.users DROP CONSTRAINT ' + QUOTENAME(name) + N';' + CHAR(10)
  FROM sys.check_constraints
 WHERE parent_object_id = OBJECT_ID('dbo.users')
   AND definition LIKE '%role%';
IF @drop_role_checks <> N'' EXEC sp_executesql @drop_role_checks;
GO
IF COL_LENGTH('dbo.users', 'role') IS NOT NULL
   AND EXISTS (SELECT 1 FROM sys.columns
                WHERE object_id = OBJECT_ID('dbo.users')
                  AND name = 'role'
                  AND max_length <> 80)
  ALTER TABLE dbo.users ALTER COLUMN role NVARCHAR(40) NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys fk
                JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
               WHERE fk.parent_object_id = OBJECT_ID('dbo.users')
                 AND COL_NAME(fk.parent_object_id, fkc.parent_column_id) = 'role'
                 AND fk.referenced_object_id = OBJECT_ID('dbo.roles'))
  ALTER TABLE dbo.users ADD CONSTRAINT FK_users_role
    FOREIGN KEY (role) REFERENCES dbo.roles(role_key) ON DELETE NO ACTION;
```

```sql
-- 3b. Field type CHECKs must accept 'toggle' and 'google_doc'.
IF EXISTS (SELECT 1 FROM sys.check_constraints
            WHERE parent_object_id = OBJECT_ID('dbo.form_fields')
              AND definition LIKE '%textarea%'
              AND definition NOT LIKE '%[^a-z_]toggle[^a-z_]%')
BEGIN
  DECLARE @ck_ff nvarchar(128) = (SELECT TOP 1 name FROM sys.check_constraints
    WHERE parent_object_id = OBJECT_ID('dbo.form_fields')
      AND definition LIKE '%textarea%'
      AND definition NOT LIKE '%[^a-z_]toggle[^a-z_]%');
  IF @ck_ff IS NOT NULL
    EXEC(N'ALTER TABLE dbo.form_fields DROP CONSTRAINT ' + QUOTENAME(@ck_ff) + ';');
  ALTER TABLE dbo.form_fields ADD CONSTRAINT CK_form_fields_type
    CHECK (type IN ('text','textarea','number','date','select','checkbox','toggle','radio','email','google_doc'));
END;
GO
IF EXISTS (SELECT 1 FROM sys.check_constraints
            WHERE parent_object_id = OBJECT_ID('dbo.submission_adhoc_fields')
              AND definition LIKE '%textarea%'
              AND definition NOT LIKE '%[^a-z_]toggle[^a-z_]%')
BEGIN
  DECLARE @ck_ah nvarchar(128) = (SELECT TOP 1 name FROM sys.check_constraints
    WHERE parent_object_id = OBJECT_ID('dbo.submission_adhoc_fields')
      AND definition LIKE '%textarea%'
      AND definition NOT LIKE '%[^a-z_]toggle[^a-z_]%');
  IF @ck_ah IS NOT NULL
    EXEC(N'ALTER TABLE dbo.submission_adhoc_fields DROP CONSTRAINT ' + QUOTENAME(@ck_ah) + ';');
  ALTER TABLE dbo.submission_adhoc_fields ADD CONSTRAINT CK_submission_adhoc_fields_type
    CHECK (type IN ('text','textarea','number','date','select','checkbox','toggle','radio','email','google_doc'));
END;
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_forms_visibility')
  ALTER TABLE dbo.forms WITH CHECK ADD CONSTRAINT CK_forms_visibility
    CHECK (visibility IN ('public','private'));
```

```sql
-- 3c. Remaining foreign keys (each guarded on the RELATIONSHIP, not the name).
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys fk
                JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
               WHERE fk.parent_object_id = OBJECT_ID('dbo.users')
                 AND COL_NAME(fk.parent_object_id, fkc.parent_column_id) = 'organization_id'
                 AND fk.referenced_object_id = OBJECT_ID('dbo.organizations'))
  ALTER TABLE dbo.users ADD CONSTRAINT FK_users_organization
    FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION;
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys fk
                JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
               WHERE fk.parent_object_id = OBJECT_ID('dbo.forms')
                 AND COL_NAME(fk.parent_object_id, fkc.parent_column_id) = 'organization_id'
                 AND fk.referenced_object_id = OBJECT_ID('dbo.organizations'))
  ALTER TABLE dbo.forms ADD CONSTRAINT FK_forms_organization
    FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION;
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys fk
                JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
               WHERE fk.parent_object_id = OBJECT_ID('dbo.submissions')
                 AND COL_NAME(fk.parent_object_id, fkc.parent_column_id) = 'organization_id'
                 AND fk.referenced_object_id = OBJECT_ID('dbo.organizations'))
  ALTER TABLE dbo.submissions ADD CONSTRAINT FK_submissions_organization
    FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE NO ACTION;
GO
-- school_name_aliases.school_id → schools.id, only when the two types agree
-- (a copied database declares schools.id BIGINT, and an INT/BIGINT FK is refused).
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys fk
                JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
               WHERE fk.parent_object_id = OBJECT_ID('dbo.school_name_aliases')
                 AND COL_NAME(fk.parent_object_id, fkc.parent_column_id) = 'school_id'
                 AND fk.referenced_object_id = OBJECT_ID('dbo.schools'))
   AND EXISTS (SELECT 1 FROM sys.columns c
                 JOIN sys.types t ON t.user_type_id = c.user_type_id
                WHERE c.object_id = OBJECT_ID('dbo.school_name_aliases')
                  AND c.name = 'school_id'
                  AND t.name = (SELECT t2.name FROM sys.columns c2
                                  JOIN sys.types t2 ON t2.user_type_id = c2.user_type_id
                                 WHERE c2.object_id = OBJECT_ID('dbo.schools') AND c2.name = 'id')
                  AND c.max_length = (SELECT c2.max_length FROM sys.columns c2
                                       WHERE c2.object_id = OBJECT_ID('dbo.schools') AND c2.name = 'id'))
  ALTER TABLE dbo.school_name_aliases ADD CONSTRAINT FK_school_name_aliases_school
    FOREIGN KEY (school_id) REFERENCES dbo.schools(id);
```

---

## 4. Indexes new in the latest changes

```sql
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_forms_code')
  CREATE UNIQUE INDEX UX_forms_code ON dbo.forms(code) WHERE code IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_forms_organization')
  CREATE INDEX IX_forms_organization ON dbo.forms(organization_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_submissions_org_school_form')
  CREATE INDEX IX_submissions_org_school_form ON dbo.submissions(organization_id, school_id, form_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_webhook_events_received')
  CREATE INDEX IX_webhook_events_received ON dbo.webhook_events(received_at DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_webhook_events_status')
  CREATE INDEX IX_webhook_events_status ON dbo.webhook_events(status, received_at DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_webhook_events_form')
  CREATE INDEX IX_webhook_events_form ON dbo.webhook_events(form_id, received_at DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_webhook_events_org')
  CREATE INDEX IX_webhook_events_org ON dbo.webhook_events(organization_id, received_at DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_webhook_events_replay_of')
  CREATE INDEX IX_webhook_events_replay_of ON dbo.webhook_events(replay_of);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_system_messages_org_active')
  CREATE INDEX IX_system_messages_org_active ON dbo.system_messages(organization_id, active, created_at DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_submission_attachments_submission')
  CREATE INDEX IX_submission_attachments_submission ON dbo.submission_attachments(submission_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_submission_links_submission')
  CREATE INDEX IX_submission_links_submission ON dbo.submission_links(submission_id);
```

---

## 5. Data steps (safe, idempotent)

```sql
-- 5a. Every user/form/submission must belong to an organization before the
--     NOT NULL / FK above can hold. Backfill to Academics, then tighten.
IF OBJECT_ID('dbo.organizations') IS NOT NULL
BEGIN
  UPDATE u SET u.organization_id = o.id
    FROM dbo.users u CROSS JOIN dbo.organizations o
   WHERE o.slug = N'academics' AND u.organization_id IS NULL;
END
GO
IF OBJECT_ID('dbo.organizations') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM dbo.users WHERE organization_id IS NULL)
   AND EXISTS (SELECT 1 FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id
                WHERE c.object_id = OBJECT_ID('dbo.users') AND c.name = 'organization_id'
                  AND t.name = 'int' AND c.is_nullable = 1)
  ALTER TABLE dbo.users ALTER COLUMN organization_id INT NOT NULL;
GO
IF OBJECT_ID('dbo.organizations') IS NOT NULL
BEGIN
  UPDATE f SET f.organization_id = o.id
    FROM dbo.forms f CROSS JOIN dbo.organizations o
   WHERE o.slug = N'academics' AND f.organization_id IS NULL;
END
GO
IF OBJECT_ID('dbo.organizations') IS NOT NULL
BEGIN
  UPDATE s SET s.organization_id = f.organization_id
    FROM dbo.submissions s JOIN dbo.forms f ON f.id = s.form_id
   WHERE s.organization_id IS NULL;
END
GO
IF OBJECT_ID('dbo.organizations') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM dbo.submissions WHERE organization_id IS NULL AND form_id IS NOT NULL)
   AND EXISTS (SELECT 1 FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id
                WHERE c.object_id = OBJECT_ID('dbo.submissions') AND c.name = 'organization_id'
                  AND t.name = 'int' AND c.is_nullable = 1)
  ALTER TABLE dbo.submissions ALTER COLUMN organization_id INT NOT NULL;
```

```sql
-- 5b. School year on existing submissions (derived from each row's submitted_at).
IF COL_LENGTH('dbo.submissions', 'school_year') IS NOT NULL
  UPDATE dbo.submissions
   SET school_year =
     CASE
       WHEN MONTH(TRY_CONVERT(datetime2, submitted_at)) >= 8
         THEN CAST(YEAR(TRY_CONVERT(datetime2, submitted_at)) AS nvarchar(4)) + '-' + CAST(YEAR(TRY_CONVERT(datetime2, submitted_at)) + 1 AS nvarchar(4))
       ELSE CAST(YEAR(TRY_CONVERT(datetime2, submitted_at)) - 1 AS nvarchar(4)) + '-' + CAST(YEAR(TRY_CONVERT(datetime2, submitted_at)) AS nvarchar(4))
     END
 WHERE (school_year IS NULL OR school_year = '')
   AND TRY_CONVERT(datetime2, submitted_at) IS NOT NULL;
GO
-- 5c. Pre-existing staff-only fields default to admin + staff.
IF COL_LENGTH('dbo.form_fields', 'roles') IS NOT NULL
  UPDATE dbo.form_fields
     SET roles = N'["admin","staff"]'
   WHERE staff_only = 1 AND (roles IS NULL OR roles = '');
GO
-- 5d. Re-derive the built-in roles' security flags (the app does this every boot).
IF OBJECT_ID('dbo.roles', 'U') IS NOT NULL
BEGIN
  UPDATE dbo.roles SET can_view = 1, can_edit = 1, can_export = 1, can_report = 1, school_scoped = 0, is_admin = 1, built_in = 1 WHERE role_key = N'admin';
  UPDATE dbo.roles SET can_view = 1, can_edit = 1, can_export = 1, can_report = 1, school_scoped = 0, is_admin = 0, built_in = 1 WHERE role_key = N'staff';
  UPDATE dbo.roles SET can_view = 1, can_edit = 1, can_export = 1, can_report = 1, school_scoped = 1, is_admin = 0, built_in = 1 WHERE role_key = N'cdm_contact';
  UPDATE dbo.roles SET can_view = 1, can_edit = 0, can_export = 1, can_report = 1, school_scoped = 0, is_admin = 0, built_in = 1 WHERE role_key = N'reviewer';
END
```

---

## 6. One-off backfills (run from `server/`, dry run first)

These are **not** part of the startup DDL — booting the app must not rewrite
production rows — so run them explicitly. They use the `DB_*` settings from
`server/.env` (or the shell environment), so point those at the **target** database
(production, or staging) before running:

```bash
cd server
npm run backfill:declared-school          # then: npm run backfill:declared-school -- --apply
npm run backfill:register-role            # then: npm run backfill:register-role -- --apply
```

- `backfill:declared-school` fills `submissions.declared_school_name` for rows that
  predate the column, so the School Name Matching worklist can see them.
- `backfill:register-role` repairs accounts created by public self-registration
  before the role was fixed to `cdm_contact`.

Only run either against production if production ever served that older code.

> **`backfill:register-role` is NOT safe to run blindly on production.** It moves
> *every* `staff` user that has a `school_id` to `cdm_contact` — including staff
> accounts an admin deliberately scoped to a school. Run the dry run and read the
> candidate list first; the script refuses to guess only about `staff` rows with a
> NULL `school_id`.

---

## 7. Verify

```sql
SELECT name FROM sys.tables WHERE schema_id = SCHEMA_ID('dbo')
   AND name IN ('roles','user_form_view_columns','form_access','form_access_events',
                'form_access_notice_dismissals','webhook_events','system_messages',
                'system_message_dismissals','school_name_aliases','submission_attachments',
                'submission_links');   -- expect 11 rows

SELECT COUNT(*) FROM dbo.roles;        -- expect 4
SELECT COUNT(*) FROM dbo.users WHERE organization_id IS NULL;  -- expect 0
```

Then boot the app: the startup log prints
`[db] Database ready (mode=sqlserver): tables/indexes ensured.` Any remaining gap is
reported there as `[db] N index(es) the schema declares are MISSING …` — on a
database whose columns are `nvarchar(max)` those indexes cannot be created until the
columns are narrowed (see the note on `UX_schools_name` in `server/src/db/schema.ts`).

---

## 8. When the ladder cannot run — the copied-database repair

Use this when `/api/health` reports `dbReady: false` and the log shows a batch
failure, or when a route fails with `Invalid object name 'dbo.<new table>'` while
the app is otherwise serving. The ladder stops at the first failing batch, so the
newest tables are simply never created.

### 8.1 Find the batch that failed

The log line to search for is:

```
DDL batch <N> of <M> failed and every batch after it was not applied: <first 160 chars of the batch>
```

That prefix is the whole diagnosis: the batch's own text names the object. If the
log has rolled, reproduce it read-only — the ladder is idempotent, so re-running it
only re-attempts what is missing:

```sql
-- What the newest batches need, in ladder order. A NULL/0 here is the gap.
SELECT
  CASE WHEN OBJECT_ID('dbo.roles','U')                     IS NULL THEN 'MISSING roles' END,
  CASE WHEN OBJECT_ID('dbo.user_form_view_columns','U')    IS NULL THEN 'MISSING user_form_view_columns' END,
  CASE WHEN OBJECT_ID('dbo.form_access','U')               IS NULL THEN 'MISSING form_access' END,
  CASE WHEN OBJECT_ID('dbo.form_access_events','U')        IS NULL THEN 'MISSING form_access_events' END,
  CASE WHEN OBJECT_ID('dbo.form_access_notice_dismissals','U') IS NULL THEN 'MISSING form_access_notice_dismissals' END,
  CASE WHEN OBJECT_ID('dbo.webhook_events','U')            IS NULL THEN 'MISSING webhook_events' END,
  CASE WHEN OBJECT_ID('dbo.system_messages','U')           IS NULL THEN 'MISSING system_messages' END,
  CASE WHEN OBJECT_ID('dbo.system_message_dismissals','U') IS NULL THEN 'MISSING system_message_dismissals' END,
  CASE WHEN OBJECT_ID('dbo.school_name_aliases','U')       IS NULL THEN 'MISSING school_name_aliases' END,
  CASE WHEN OBJECT_ID('dbo.submission_attachments','U')    IS NULL THEN 'MISSING submission_attachments' END,
  CASE WHEN OBJECT_ID('dbo.submission_links','U')          IS NULL THEN 'MISSING submission_links' END;
```

### 8.2 Clear the data-dependent batch

These are the batches that fail on a database that already holds rows. Each is
guarded, so running them is safe whether or not they are the cause:

```sql
-- (a) users.organization_id: the ladder tightens to NOT NULL and adds the FK.
--     Any NULL row (a user created before organizations existed) makes the
--     tighten fail with error 515, which aborts the batch and everything after it.
SELECT COUNT(*) AS users_without_org FROM dbo.users WHERE organization_id IS NULL;
GO
IF OBJECT_ID('dbo.organizations') IS NOT NULL
BEGIN
  UPDATE u SET u.organization_id = o.id
    FROM dbo.users u CROSS JOIN dbo.organizations o
   WHERE o.slug = N'academics' AND u.organization_id IS NULL;
END
GO
-- (b) forms.organization_id / submissions.organization_id: same shape.
IF OBJECT_ID('dbo.organizations') IS NOT NULL
BEGIN
  UPDATE f SET f.organization_id = o.id
    FROM dbo.forms f CROSS JOIN dbo.organizations o
   WHERE o.slug = N'academics' AND f.organization_id IS NULL;
  UPDATE s SET s.organization_id = f.organization_id
    FROM dbo.submissions s JOIN dbo.forms f ON f.id = s.form_id
   WHERE s.organization_id IS NULL;
END
GO
-- (c) users.role → dbo.roles FK: fails with 547 if a user holds a role key that
--     is not in dbo.roles (a role created before Settings → Roles existed).
SELECT DISTINCT u.role FROM dbo.users u
 WHERE NOT EXISTS (SELECT 1 FROM dbo.roles r WHERE r.role_key = u.role);
GO
-- (d) The role CHECK drop/widen: a CHECK constraint blocks ALTER COLUMN, so the
--     ladder's own order matters — run §3a verbatim after (c) is clean.
```

If (c) lists anything, insert those keys into `dbo.roles` (or reassign the users)
before re-running §3a. If (a)/(b) changed rows, re-run §5a.

### 8.3 Apply the missing objects

Run §1 → §5 in order. They are exactly the batches the ladder would have applied,
so afterwards the app's own boot finds nothing left to do and sets `dbReady=true`.

### 8.4 The copied-database type problems (only if a batch says so)

A database copied from an older system declares `nvarchar(max)` where this DDL
declares a sized type, and `bigint` where it declares `int`. Symptoms and fixes:

| Error | Meaning | Fix |
|---|---|---|
| `Cannot create index … key length exceeds 1700` | `nvarchar(max)` key column | narrow the column (§8.5) |
| 1750 `foreign key … incompatible types` | `int` vs `bigint` | the ladder's `isSameTypeAs` guard skips the FK; leave it, ids still work |
| 1785 `multiple cascade paths` | copied FK shapes | drop the duplicate FK the message names, then re-run |

### 8.5 Narrowing a column (safe, verified on the tenant)

The measured data fits: longest `schools.name` 69/200, `users.email` 35/320,
`submissions.public_id` 10/64, `forms.code` 8/20, no NULLs in the key columns, and
no duplicate values in the six UNIQUE indexes. Check the target before running:

```sql
SELECT MAX(LEN(name)) AS longest_school_name FROM dbo.schools;   -- must be <= 200
GO
ALTER TABLE dbo.schools ALTER COLUMN name NVARCHAR(200) NOT NULL;
```

Repeat per blocking column the log names. Nothing references these columns (no FK,
computed column or full-text index), so the `ALTER` is not blocked by the schema.

### 8.6 Finish

Restart the slot (or redeploy) and confirm `/api/health` reports `dbReady: true`.

