# Staff Attachments — Plan

> **Status:** ✅ **Implemented** (2026-10-31). Server typecheck, client typecheck and build are
> clean; `server npm test` → **18 files, 382 tests, all pass**. The schema migration was verified
> against the live Turso database: `submission_attachments` and both `forms.attachments_*` columns
> exist, and every pre-existing form reads `attachments_enabled = 0` as designed.
> **Not yet verified live:** the Google Drive upload path (needs an admin to set a Drive Folder ID
> and turn the switch on) and the >230 s failure path (§5.3).
>
> **Extension — Links (2026-10-31):** a **"+ Link"** button now sits next to "+ Attachment" and
> records a **Link Title + Link URL** (the URL must start with `https://`). Links render in the
> same list, **below every attachment**, and are stored in their own table
> (`dbo.submission_links`, §3.6). Implemented; see §3.6, §4.6, §5.5, §6.6 and §14.
> **Date:** 2026-10-31
> **Audience:** Engineering, and the admin who will configure it
> **Area:** Submission detail page (staff/admin), Google Drive, roles
> **Relation to other docs:**
> - Reuses the Drive plumbing and the "valid folder" check built for
>   [`google-doc.md`](./google-doc.md) (`server/src/google/docs.ts`,
>   `POST /api/forms/:id/drive-validate`).
> - Reuses the role-list contract from
>   [`staff-only-field-access-toggles.md`](./staff-only-field-access-toggles.md) §2.3
>   (`null` = unrestricted, `[]` = nobody, `[...]` = exactly those) and the toggle UI from
>   `AdminFormDesigner.tsx`'s *Access* row.
> - Follows the "one child table, one census, one delete list" discipline documented in
>   `submissions-archive.test.ts` §"the permanent delete's child set".
> - **Supersedes the "Public link" card** in the designer
>   (`AdminFormDesigner.tsx` L991–1003) and `docs/guides/admin/admin-guide.html` §3.7
>   (Figure 11).
>
> **⚠ Read §5.3 before approving.** "No size restriction" is true of the code but **not** of the
> deployment: Azure App Service cuts any request at 230 seconds, which caps a real upload at
> roughly 130–700 MB depending on the school's uplink. Decision **D7** is whether that is
> acceptable for video/audio or whether the upload must go browser → Drive directly.

---

## 1. What was asked

> "If a form has a valid Drive Folder ID, staff should have an area for 'Attachments'. This
> should be placed below the 'Staff only fields' area on the submission, and is only open to
> the roles who the Admin decides (you can replace the 'Public Link' area with this feature as
> it is not used). Documents should be saved to Google Drive and listed below the
> '+ Attachment' field. Limit is 10 attachments per submission. There is no size restriction to
> the attachments."

Restated as requirements:

| # | Requirement |
| --- | --- |
| R1 | The Attachments card appears on a submission **only** when that submission's form has a Drive Folder ID that is currently valid. |
| **R1a** | **Each form has an "Enable Staff Attachments" toggle** in its designer. Off by default. When off, no card and no upload for anyone but an admin (who sees it read-only, §3.2). |
| R2 | The card sits **directly below** the *Staff-only fields* card on the submission detail page. |
| R3 | Visibility is **per role**, chosen by an admin. Admins always see it. |
| R4 | The admin chooses those roles in the form designer, **in the space the "Public link" card occupies today**. |
| R5 | Files are uploaded to the form's Google Drive folder. |
| R6 | Uploaded files are **listed below the "+ Attachment" control**. |
| R7 | At most **10 attachments per submission**. |
| R8 | **No size limit** on an individual attachment. → **True in the code; capped by the host at ~130–700 MB in practice.** See §5.3 and decision D7. |

**Extension (2026-10-31) — Links:**

> "Add a button next to Attachments for Links. The person can click '+Link' and add a Link Title &
> Link Url. The link url must begin with 'https://' and when added displays below any attachments
> or other links."

| # | Requirement |
| --- | --- |
| R9 | A **"+ Link"** button sits **next to** "+ Attachment" in the same card. |
| R10 | Clicking it asks for a **Link Title** and a **Link URL**. |
| R11 | The URL **must begin with `https://`** — enforced on the client (immediate message) and again on the server (the authority). |
| R12 | Links display **below any attachments**, and below the previously added links (oldest first). |
| R13 | The same per-form toggle and role list govern links — a link is the same class of staff-only material as a file. |

### 1.1 One question I need answered before building

R1 says "a **valid** Drive Folder ID". The designer already validates the id live
(`POST /api/forms/:id/drive-validate` → `{ valid, name }`), but **validity is not stored** —
it is a live Google call made while an admin types. That leaves two readings:

| Option | Behaviour | Cost / risk |
| --- | --- | --- |
| **A — live check (recommended)** | The server re-validates the form's folder before serving/accepting attachments, and the card is hidden when the folder is unreachable. | One extra Drive `files.get` per detail-page load. The card can disappear if the Drive account loses access to the folder — which is honest, because uploads would fail anyway. |
| **B — stored flag** | Persist `forms.attachments_folder_valid` when the admin saves a valid id. | No per-load Google call, but the flag goes stale silently, and the first thing a staff member learns about a revoked folder is a failed upload. |

**Plan assumes A.** §11 lists it as decision D1; flipping to B is a small change (§3.2, §5.4).

---

## 2. Current behaviour (research baseline)

Measured in this repo on 2026-10-31.

### 2.1 Submission detail page — `client/src/pages/staff/StaffSubmissionDetail.tsx`

- One page for admins (`/admin/submissions/:publicId`) and staff (`/staff/:publicId`).
- Card order today: answers → *Additional fields* (captured Google Form questions) →
  **Staff-only fields** (L~660–772, with the generated-document line inside its card body) →
  modals. **The Attachments card is inserted immediately after the `Staff-only fields` card's
  closing `</div>` (currently L772, before the `{previewDoc && …}` block at L774).**
- The page already knows the role (`user.role`) and already gates one feature by setting
  (`useDocumentsEnabled(role)` → `documents_link`). Attachments will use the same pattern with
  its own setting.

### 2.2 Form designer — `client/src/pages/admin/AdminFormDesigner.tsx`

- *Form Details* card: title, description, **Drive Folder ID** (with live Valid/Invalid chip,
  L~562–600), Google Form URL, Submission Detail Link.
- *Fields* card with **Form Fields** / **Staff Only Fields** tabs. Each staff-only field row
  carries an **Access** row of per-role toggle buttons driven by `useRoleCatalog()` (L~1054,
  L~1148–1215).
- **Public link card** (L991–1003): renders `/org/{slug}/forms/{id}` as a `<code>` block when
  `form.status === "published"`. Nothing links to it, nothing copies it, no test or server route
  depends on it. **This is the card being replaced.**

### 2.3 Google Drive — `server/src/google/docs.ts`

- OAuth2 refresh-token grant (`getAuth()`), **not** a service account.
- Every call passes `supportsAllDrives: env.google.isSharedDrive` + `includeItemsFromAllDrives`.
- `resolveParentFolderId(formId)` → `form.doc_folder_id || env.google.docFolderId || null`.
- `validateDriveFolder(folderId)` → `{ valid, name }` (folder + not trashed + reachable).
- `escapeDriveQuery()` and `findFolderByName()` already exist and are reusable.
- **There is no upload path yet.** `drive.files.create` is only used for folders and templates.
  The existing OAuth scope already permits file creation (the app copies docs into the folder
  today), so **no new Google scope is required** — this is confirmed by the fact that
  `drive.files.copy` into that folder works in production (`google-doc.md` §0).

### 2.4 Server shape

- `server/src/index.ts` L51: `app.use(express.json({ limit: "2mb", verify: captureRawBody }))`
  is mounted **globally**, before every router. A multipart or raw-binary body is therefore
  already consumed/rejected before any route sees it. **The upload route must be mounted before
  that line** (§5.1).
- `server/package.json` has **no multipart parser** (no `multer`, no `busboy`). Adding a
  dependency is a deliberate choice — §5.1 explains why this plan avoids one.
- `submissionsRouter` guards every row route with `submissionAccessError(req, submission)` =
  `canAccessSchool` + `canAccessForm`. New routes must use it too.
- `requireRoles(...)` is a **static** list (`auth.ts` L169). It cannot express "the roles an
  admin picked for this form", so the per-form gate must be a separate check (§5.2).

### 2.5 Database

- Two dialects: SQL Server (`schema.ts` ladder, `COL_LENGTH`-guarded) and libSQL/Turso
  (`dialect/turso.ts` final-shape DDL + `addColumns`). `driver/libsql.test.ts` asserts the two
  create the **same table set**.
- `submissions-archive.test.ts` derives every table with a foreign key to `dbo.submissions` and
  fails if `SUBMISSION_CHILD_TABLES` in `queries.ts` disagrees — **in either direction**.
- `db/client.ts` `TIMESTAMP_COLUMNS` / `BOOLEAN_COLUMNS` unify how the two engines serve
  timestamps and booleans.

### 2.6 Settings / per-role features

`documents_link` is the template for a per-role feature switch:

| Layer | Where |
| --- | --- |
| Stored value | `app_settings` row, JSON `string[] \| null` |
| Allow-list | `ALLOWED_SETTING_KEYS` in `routes/settings.ts` |
| Parse / decide | `parseDocumentRoles()` + `documentsEnabledFor()` (server) and `lib/settings.ts` (client) |
| Public read | `GET /api/settings/:key` (no auth) |
| Admin write | `PUT /api/settings/:key` (admin, validates role keys) |
| Delete guard | `roleUsage()` census in `queries.ts` + `routes/roles.ts` label |
| UI | *Documents Link* panel in `AdminSettings.tsx` (L~1774–1839) |

---

## 3. Design

### 3.1 Data model — one new table, one new form column

#### 3.1.1 `dbo.submission_attachments`

| Column | Type (SQL Server) | Type (Turso) | Notes |
| --- | --- | --- | --- |
| `id` | `INT IDENTITY(1,1) PRIMARY KEY` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `submission_id` | `INT NOT NULL` | `INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE` | FK → `dbo.submissions(id)` `ON DELETE CASCADE` |
| `drive_file_id` | `NVARCHAR(255) NOT NULL` | `TEXT NOT NULL` | Google Drive file id |
| `file_name` | `NVARCHAR(255) NOT NULL` | `TEXT NOT NULL` | Original name, **as uploaded** (see §3.3.2 for the stored name) |
| `mime_type` | `NVARCHAR(255) NULL` | `TEXT` | From the `Content-Type` header |
| `size_bytes` | `BIGINT NULL` | `INTEGER` | From the upload response; `NULL` if Google does not report it |
| `web_view_link` | `NVARCHAR(1000) NULL` | `TEXT` | `files.get(...).webViewLink`; the client falls back to a constructed URL |
| `uploaded_by` | `INT NULL` | `INTEGER REFERENCES users(id) ON DELETE SET NULL` | FK → `dbo.users(id)` `ON DELETE SET NULL` |
| `uploaded_at` | `DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()` | `TEXT NOT NULL DEFAULT (strftime(...))` | Add `uploaded_at` to `TIMESTAMP_COLUMNS` |

Index: `IX_submission_attachments_submission ON submission_attachments(submission_id)`.

`size_bytes` is `BIGINT` on SQL Server because "no size restriction" means a file can exceed
2 GB. **Do not read it back as a JS number without care** — the driver returns SQL numeric
columns as strings (see the note in `queries.ts` `resolveSubmissionSchoolId`); the list query
should `CAST`/parse to a number explicitly, or simply not return it to the client (the UI shows
a human-readable size formatted from it, so parse with `Number(...)` and treat `NaN` as unknown).

#### 3.1.2 `forms.attachments_roles` and `forms.attachments_enabled`

Two columns, both on `forms`.

**`forms.attachments_enabled`** — the per-form master switch, surfaced in the designer as the
**"Enable Staff Attachments"** toggle (§6.4).

| Dialect | Statement |
| --- | --- |
| SQL Server | `IF COL_LENGTH('dbo.forms', 'attachments_enabled') IS NULL ALTER TABLE dbo.forms ADD attachments_enabled BIT NOT NULL CONSTRAINT DF_forms_attachments_enabled DEFAULT 0;` |
| Turso | `attachments_enabled BOOLEAN NOT NULL DEFAULT 0` in the `forms` `CREATE TABLE`, **and** an `addColumns` entry `{ table: "forms", column: "attachments_enabled", definition: "BOOLEAN NOT NULL DEFAULT 0" }` |

**`DEFAULT 0` is the whole deploy story** — the same reasoning as `forms.visibility DEFAULT
'public'` (`schema.ts` L1695–1701). Every existing form, and every form created without touching
the switch, has attachments **off**, so shipping this changes nothing for anybody until an admin
deliberately turns it on for a specific form. `attachments_enabled` is also added to
`BOOLEAN_COLUMNS` in `db/client.ts` (the libSQL fallback that stops `0` being served where every
TypeScript signature says `boolean`).

**`forms.attachments_roles`** — which roles may use the card, once it is enabled.

| Dialect | Statement |
| --- | --- |
| SQL Server | `IF COL_LENGTH('dbo.forms', 'attachments_roles') IS NULL ALTER TABLE dbo.forms ADD attachments_roles NVARCHAR(MAX) NULL;` |
| Turso | add `attachments_roles TEXT` to the `forms` `CREATE TABLE`, **and** an `addColumns` entry `{ table: "forms", column: "attachments_roles", definition: "TEXT" }` for databases created before it |

Semantics — **identical to `form_fields.roles`**:

| Stored | Meaning |
| --- | --- |
| `NULL` | **Unrestricted** — every role, including roles created later. This is the value every existing form gets, so no form needs a role grant when it is switched on. |
| `[]` | Granted to **nobody** (the card is hidden from every non-admin, even when enabled). |
| `["admin","staff"]` | Exactly those. `admin` is always allowed regardless (§3.2). |

Parsed on read with the existing `parseFormFieldRoles()` helper (it already accepts a JSON
string or an array and returns `string[] | null`); serialised with `JSON.stringify`.

> ⚠ **`attachments_roles` is meaningless while `attachments_enabled = 0`.** The role list is
> *who*, the toggle is *whether*. An admin who switches the feature off does **not** lose the
> role selections — they are preserved so switching it back on restores exactly the previous
> grant. The designer keeps the toggles visible but disabled while the switch is off, with the
> reason stated (§6.4), so the state is legible rather than mysterious.

### 3.2 Who may see and use the card

```
canUseAttachments(user, form, folderValid) =
     user.role === "admin"                                         // admins always
  || (form.attachments_enabled                                    // ← the per-form switch
      && folderValid
      && rolesAllows(form.attachments_roles, user.role))
```

where `rolesAllows(stored, role) = stored === null || stored.includes(role)`.

- **Admins are superusers**, matching `canSeeField()` (`schema.ts` L377): hiding the card from an
  admin would leave nobody able to diagnose an attachment problem. **This is the one place the
  admin exemption outranks the toggle** — an admin sees the card on a form where it is switched
  off, with the card stating *"Staff Attachments are turned off for this form"* and no upload
  control, so the admin can confirm what staff would see without a second account. If you would
  rather admins see nothing at all when the switch is off, that is a one-line change in §5.2.
- **The toggle is checked first** (§3.1.2). A form with attachments off has no card and no
  upload route for every non-admin role, whatever the role list says.
- **The folder must be valid** (R1). When it is not, the card is not rendered at all — not an
  empty card with a disabled button, which reads as broken.
- The **server** is the authority. The client's copy of this rule only decides whether to render.

### 3.3 Google Drive writes — `server/src/google/drive-upload.ts` (new)

#### 3.3.1 Where files land

`resolveParentFolderId(formId)` — the **same** resolution the document generator uses, so
attachments and generated documents for a form live in the same place:

1. `forms.doc_folder_id` when set;
2. else `env.google.docFolderId`;
3. else → **Attachments are unavailable** (the card requires a form folder id anyway, R1).

**Not** the per-school subfolder (`ensureSchoolFolder`). That folder is named after the school
and is the home of *generated* documents; attachments belong to the submission, and mixing them
would make the generated-document folder unreadable. Instead each submission gets its own
folder so 10 files × N submissions stay navigable:

```
<Drive Folder ID>/
  Attachments/
    <public_id>/            e.g. "CDM-00123"
      CDM-00123 - Report Card.pdf
      CDM-00123 - IEP.pdf
```

- `Attachments` is found/created with the existing `findFolderByName()` + `drive.files.create`
  (folder mimeType), `supportsAllDrives` as everywhere else.
- `<public_id>` likewise. `public_id` is already filename-safe (`[A-Z0-9]{2,}-NNNNN`) and
  globally unique, so it can never collide with another submission's folder.

#### 3.3.2 File naming

Stored name: `<public_id> - <original name>`, sanitised with the existing
`escapeDriveQuery`-adjacent sanitiser used by `docs.ts` for generated documents (strip `/ \ " ?`
and friends, collapse whitespace, cap at ~200 chars). The original name is kept verbatim in
`file_name` so the UI lists what the uploader chose.

Rationale: files in a shared drive are found by **name search** by real people. A bare
`scan001.pdf` × 10 submissions is unusable; the prefix makes every file self-describing.

#### 3.3.3 The upload call

```ts
// server/src/google/drive-upload.ts
export async function uploadSubmissionAttachment(input: {
  folderId: string;          // resolved per §3.3.1
  submissionPublicId: string;
  fileName: string;
  mimeType: string;
  body: Readable;            // the raw request stream — never buffered
}): Promise<{ fileId: string; webViewLink: string | null; sizeBytes: number | null }>;
```

- `drive.files.create({ requestBody: { name, parents: [folderId] }, media: { mimeType, body }, fields: "id, webViewLink, size", supportsAllDrives })`.
- **The body is streamed straight from `req` to Google.** Nothing is written to disk and nothing
  is buffered in memory, which is what makes R8 ("no size restriction") true in practice.
- Errors are mapped to sentences a staff member can act on (§3.4).

#### 3.3.4 Reading a file back

`GET` returns a **redirect (302)** to a short-lived Google URL rather than proxying bytes through
the API server:

- `webViewLink` when Google returns one (opens the file in Drive);
- otherwise `https://drive.google.com/uc?export=download&id=<fileId>`.

This keeps the server out of the download path entirely — important with no size cap.

### 3.4 Failure modes, and what the user is told

| Condition | HTTP | Message shown |
| --- | --- | --- |
| Form has no Drive Folder ID | `409` | "This form has no Drive Folder ID configured. Ask an administrator to set one." |
| Folder no longer reachable | `409` | "The form's Google Drive folder is not reachable. Ask an administrator to check the Drive Folder ID." |
| Caller's role not permitted | `403` | "Attachments are not available for your role on this form." |
| 10 already attached | `409` | "This submission already has 10 attachments, the maximum." |
| No file in the request | `400` | "No file was received." |
| Google rejects the file (quota, permission) | `502` | "Google Drive rejected the upload: <reason>" + a Slack alert (same channel as the existing alerts) |
| Row written but Drive call failed | — | **No row is written.** Drive first, then the DB row; a failed upload leaves nothing to clean up. |

### 3.5 Concurrency: the 10-file cap

The cap must hold under two staff uploading at once. Counting rows and then inserting is a
race. Options, in order of preference:

1. **`SELECT COUNT(*)` inside a transaction with the submission row locked** — SQL Server:
   `SELECT id FROM dbo.submissions WITH (UPDLOCK, ROWLOCK) WHERE id = @id`; libSQL: the driver's
   `transaction()` wrapper (single writer). Then `COUNT` + `INSERT` in the same transaction.
2. If the lock proves awkward on libSQL, accept a tiny over-count window and enforce the cap on
   read (`LIMIT 10`) — **not recommended**, because the 11th row then exists in Drive and in the
   DB with no way to see it.

Plan is **(1)**. The upload happens *before* the transaction (Drive first), so the transaction is
short: lock → count → insert → commit. If the count check fails, the just-uploaded Drive file is
deleted (`drive.files.delete`) before answering `409`.

### 3.6 Extension — Links (+ Link), added 2026-10-31

A **link** is a title + an external URL, recorded against the same submission, shown by the same
card. It is deliberately a **separate table** from `submission_attachments`:

- the attachment table is a *Drive* table (`drive_file_id NOT NULL`, `size_bytes`, `mime_type`);
  a link has none of those, and making them nullable would put two row shapes in one table that
  every query then has to branch on;
- the 10-file cap applies to **files only**. Links are not files, are not stored in Drive, and do
  not count against it;
- deleting a submission cascades both, and both are added to `SUBMISSION_CHILD_TABLES`.

#### 3.6.1 `dbo.submission_links`

| Column | Type (SQL Server) | Type (Turso) | Notes |
| --- | --- | --- | --- |
| `id` | `INT IDENTITY(1,1) PRIMARY KEY` | `INTEGER PRIMARY KEY AUTOINCREMENT` | |
| `submission_id` | `INT NOT NULL` | `INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE` | FK → `dbo.submissions(id)` `ON DELETE CASCADE` |
| `title` | `NVARCHAR(200) NOT NULL` | `TEXT NOT NULL` | "Link Title", trimmed, 1–200 chars |
| `url` | `NVARCHAR(2048) NOT NULL` | `TEXT NOT NULL` | "Link URL"; **must start with `https://`** |
| `created_by` | `INT NULL` | `INTEGER REFERENCES users(id) ON DELETE SET NULL` | FK → `dbo.users(id)` `ON DELETE SET NULL` |
| `created_at` | `DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()` | `TEXT NOT NULL DEFAULT (strftime(...))` | Add `created_at`… **already** in `TIMESTAMP_COLUMNS` |

Index: `IX_submission_links_submission ON submission_links(submission_id)` — declared through
`indexGuard`, like the attachment index, so the boot-time "missing index" report stays honest.

#### 3.6.2 The URL rule — `https://` only

`isHttpsUrl(value)` (one helper, used by the Zod schema **and** the client):

```
trim → must start with "https://" (case-insensitive) → the remainder must parse as an absolute
URL whose protocol is https: and whose host is non-empty → ≤ 2048 characters
```

- **No `http://`**, no `javascript:`, no `data:`, no protocol-relative `//host`. The prefix check
  is what the brief asks for; the `new URL()` parse is what makes it *safe* — `https://` alone
  would still admit `https://` with no host, and a stored `javascript:`-style string is the one
  way a link list becomes an XSS vector. Since the prefix is required, `javascript:` can never be
  stored; the parse is belt-and-braces for the host.
- Enforced **twice**: the card refuses to submit and says why (`Link URL must begin with
  https://`), and `POST …/links` answers `400` with the same sentence. The client check is a
  courtesy; the server is the authority.
- Rendered with `rel="noopener noreferrer"` and `target="_blank"`, and the `href` is the **stored,
  validated** URL — never a value echoed back from an unvalidated source.

#### 3.6.3 Ordering and display

The card renders **attachments first, then links** (R12). Within each group the order is
`id` ascending — oldest first — which is what "displays below any attachments or other links"
means: a new link is appended at the bottom of the list, beneath every file and every earlier
link.

```
[ + Attachment ]  [ + Link ]            3 of 10 attachments
──────────────────────────────────────────────────────────────
📄 CDM-00123 - Report Card.pdf   …  [Open] [✕]
📄 CDM-00123 - IEP.pdf           …  [Open] [✕]
🔗 Student handbook   https://…/handbook  · A. Smith, 10/31 2:20  [Open] [✕]
🔗 Course catalog     https://…/catalog   · A. Smith, 10/31 2:21  [Open] [✕]
```

#### 3.6.4 Who may add, and who may remove

- **Add**: the same verdict as uploading — the form's toggle, the role list, and the folder being
  reachable (`attachments_can_upload`). A link is staff-only material; letting a role that cannot
  attach a file add a link would be a hole in the same rule.
- **Remove**: **administrators only**, exactly like deleting an attachment (D2), through the same
  confirmation drawer. Removing a link deletes the row only — nothing external is touched, so the
  drawer says *"This removes the link from this submission. The web page itself is not affected."*

---

---

## 4. Database change, in full

### 4.1 `server/src/db/schema.ts`

Append to the SQL Server ladder (before the `report_views` batch, which is last):

```sql
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
```

Index in its **own batch** (SQL Server error 207 — a `CREATE INDEX` must not share a batch with
the `CREATE TABLE` that defines its columns), declared through `indexGuard` so
`expectedIndexNames()` sees it:

```sql
-- indexGuard("IX_submission_attachments_submission", "submission_attachments", ["submission_id"])
CREATE INDEX IX_submission_attachments_submission ON dbo.submission_attachments(submission_id);
```

Plus the `forms.attachments_enabled` and `forms.attachments_roles` `COL_LENGTH` guards from
§3.1.2:

```sql
IF COL_LENGTH('dbo.forms', 'attachments_enabled') IS NULL
  ALTER TABLE dbo.forms ADD attachments_enabled BIT NOT NULL
    CONSTRAINT DF_forms_attachments_enabled DEFAULT 0;

IF COL_LENGTH('dbo.forms', 'attachments_roles') IS NULL
  ALTER TABLE dbo.forms ADD attachments_roles NVARCHAR(MAX) NULL;
```

> `BIT NOT NULL` with a named `DEFAULT 0` is the pattern already used for
> `forms.submission_seq` (`schema.ts` L1193–1195) and `forms.visibility`. The default backfills
> every existing row **off** in one statement, so no separate data migration is needed.

Typed interface next to `Document` in `schema.ts`:

```ts
export interface SubmissionAttachment {
  id: number;
  submission_id: number;
  drive_file_id: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  web_view_link: string | null;
  uploaded_by: number | null;
  uploaded_by_name: string | null;   // joined for display
  uploaded_at: Date;
}
```

### 4.2 `server/src/db/dialect/turso.ts`

- `CREATE TABLE IF NOT EXISTS submission_attachments (...)` in final shape + `CREATE INDEX IF NOT EXISTS`.
- `attachments_enabled BOOLEAN NOT NULL DEFAULT 0` and `attachments_roles TEXT` added to the
  `forms` `CREATE TABLE`.
- `addColumns` entries for **both** `forms.attachments_enabled` and `forms.attachments_roles`
  (a database created before either column needs them added, and libSQL has no
  `ADD COLUMN IF NOT EXISTS`).

### 4.3 `server/src/db/client.ts`

- `TIMESTAMP_COLUMNS`: add `"uploaded_at"`.
- `BOOLEAN_COLUMNS`: add `"attachments_enabled"` — the fallback that stops libSQL serving `0`
  where every TypeScript signature says `boolean` (same reasoning as `staff_only`).

### 4.4 `server/src/db/queries.ts`

- `SUBMISSION_CHILD_TABLES`: add `"submission_attachments"` — **required**, or
  `submissions-archive.test.ts` fails and the permanent delete leaves rows behind on the live
  database (whose constraints are `NO ACTION`).
- `Form` interface: `attachments_enabled: boolean` and `attachments_roles: string[] | null`.
- `getForm` / `listForms` / `getFormWithFields`: select both columns; parse `attachments_roles`
  via `parseFormFieldRoles`.
- `createForm`: accept `attachmentsEnabled` (default `false`) and `attachmentsRoles`
  (default `null`).
- `updateForm`: accept `attachments_enabled?: boolean` and `attachments_roles?: string[] | null`.
  The boolean follows the plain `??` rule (`data.attachments_enabled ?? existing.…`), while the
  role list uses the **same null-vs-absent rule** as `doc_folder_id` (`hasOwnProperty`, not
  `??`). Both go into the `UPDATE`.
- `getSubmissionDetail`: after `documents`, attach
  `attachments: await listAttachmentsBySubmission(submission.id)`.

### 4.5 Tests that will fail until updated (by design)

| Test | Why |
| --- | --- |
| `db/submissions-archive.test.ts` §"the permanent delete's child set" | `childrenOfSubmissions()` now returns four tables; the hard-coded `expected` array must become `["documents","submission_attachments","submission_adhoc_fields","submission_values"]`, and `SUBMISSION_CHILD_TABLES` must match. |
| `db/driver/libsql.test.ts` §"both dialects create the same tables" | Passes automatically once both dialects declare the table — **it will fail if only one is updated**, which is the point. |

New tests to add:

- `db/submission-attachments.test.ts` — cap enforcement (10 ok, 11th rejected), cascade delete
  membership, `attachments_roles` null/empty/explicit parsing.
- `routes/submissions.attachments.test.ts` — 403 for a role not in the list, 403 for a role in
  the list but with an invalid folder, 409 at the cap, 400 with no file, and the happy path with
  the Drive client mocked.

### 4.6 Extension — Links, in full (added 2026-10-31)

**`server/src/db/schema.ts`** — appended to the same ladder, after the attachment index batch:

```sql
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

```sql
-- indexGuard("IX_submission_links_submission", "submission_links", ["submission_id"])
CREATE INDEX IX_submission_links_submission ON dbo.submission_links(submission_id);
```

Typed interface next to `SubmissionAttachment`:

```ts
export interface SubmissionLink {
  id: number;
  submission_id: number;
  title: string;
  url: string;
  created_by: number | null;
  created_by_name: string | null;   // joined for display
  created_at: Date;
}
```

**`server/src/db/dialect/turso.ts`** — `CREATE TABLE IF NOT EXISTS submission_links (…)` in final
shape + `CREATE INDEX IF NOT EXISTS IX_submission_links_submission`. New table, so **no**
`addColumns` entry. `created_at` is already in `TIMESTAMP_COLUMNS`, so the
`libsql.test.ts` "covers every timestamp column" guard stays green without an edit.

**`server/src/db/queries.ts`**

- `SUBMISSION_CHILD_TABLES` gains `"submission_links"` — `submissions-archive.test.ts` fails
  until it does, which is the point (the parser reads the FK out of the DDL).
- `SubmissionDetail` gains `links: SubmissionLink[]`, populated for every non-parent viewer
  (`viewer === "parent" ? [] : await listLinksBySubmission(...)`).

**`server/src/db/links.ts`** *(new)* — `listLinksBySubmission`, `createLink`, `deleteLinkRow`,
mirroring `db/attachments.ts` (no transaction needed: there is no cap and no external call).

**`server/src/schemas.ts`**

```ts
export const createSubmissionLinkSchema = z.object({
  title: z.string().trim().min(1).max(200),
  url: z.string().trim().max(2048).refine(isHttpsUrl, {
    message: "Link URL must begin with https://",
  }),
});
```

`isHttpsUrl` lives here (exported) so the route, the tests and the client's copy of the rule are
one definition, not three.

**`server/src/swagger.ts`** — a `SubmissionLink` schema, `links` on the submission-detail payload,
and the two routes below.

**`server/src/routes/submissions.ts`** — see §5.5.

---

## 5. Server

### 5.1 Receiving the file

`express.json()` is mounted globally at `index.ts` L51, **before** the routers. A raw-body route
mounted afterwards never sees the stream. So the upload route is mounted above it:

```ts
// server/src/index.ts — ABOVE `app.use(express.json(...))`
app.use("/api/submissions", attachmentsUploadRouter);   // handles ONLY POST /:publicId/attachments
```

`attachmentsUploadRouter` (new, `server/src/routes/attachments-upload.ts`) handles exactly
`POST /:publicId/attachments` and calls `next()` for every other method/path so the request
falls through to the ordinary router untouched.

**No body parser on this route.** `express.raw` and `express.json` both buffer the whole body in
memory; with video that is a memory-exhaustion vector on a public endpoint. Instead the route
takes `req` (an `http.IncomingMessage`, which is a `Readable`) and hands it straight to Google as
`media.body`. Zero buffering, zero new dependency.

> ⚠ **Zero buffering does not mean unlimited size.** The platform in front of the app cuts any
> request off after 230 seconds. **§5.3 is the real ceiling and it is the most important section
> in this document for video and audio.**

The client sends the raw file bytes with `Content-Type: <file type>` and
`X-File-Name: <percent-encoded name>` (percent-encoded because non-ASCII names are legal). The
server reads the name from the header, never from a multipart part.

Consequences to accept:

- The route **must** call `requireAuth` and `requireRoles(...)` itself, and must apply the same
  `submissionAccessError` + folder-validity + role-list checks. It cannot reuse the ordinary
  router's middleware chain, so those checks live in a shared helper (§5.2) called from both.
- The **global `apiLimiter`** is mounted after `express.json` too; the upload route is before it.
  Apply a dedicated limiter (`express-rate-limit`, already a dependency) to the upload route —
  e.g. 30 uploads / 10 min / IP — so a loop cannot hammer Drive.
- `helmet()` is also mounted after. It sets response headers only; mount `helmet()` **before**
  the upload router in `index.ts` to keep the headers uniform.

### 5.2 Routes

All under the existing `/api/submissions` prefix. Each one repeats the standard preamble:
`requireAuth` → `requireRoles("staff","cdm_contact","admin")` → `getSubmissionDetail` →
`submissionAccessError` → `attachmentsAccessError` (new helper).

```ts
// server/src/routes/attachments-access.ts (new) — THE gate, in one place.
//
// Mirrors submissionAccessError's contract: returns the {status, error} body to
// send, or null to proceed. Written once because four routes need it and a
// missing copy fails silently (the route simply works for everyone).
export async function attachmentsAccessError(
  user: { role: string },
  formId: number
): Promise<{ status: number; error: string } | null> {
  const form = await getForm(formId);
  // The per-form switch comes FIRST, before the folder and the role list: a form
  // that has attachments turned off must refuse every non-admin even if it still
  // carries a folder id and a role grant from when it was on.
  if (user.role !== "admin" && !form?.attachments_enabled) {
    return { status: 403, error: "Staff Attachments are not enabled for this form." };
  }
  if (!form?.doc_folder_id?.trim()) {
    return { status: 409, error: "This form has no Drive Folder ID configured." };
  }
  if (user.role !== "admin" &&
      !rolesAllow(form.attachments_roles, user.role)) {
    return { status: 403, error: "Attachments are not available for your role on this form." };
  }
  if (!(await validateDriveFolder(form.doc_folder_id))) {
    return { status: 409, error: "The form's Google Drive folder is not reachable." };
  }
  return null;
}
```

> **Order matters, and it is the toggle → folder → role → reachability sequence above.** Checking
> the role before the toggle would answer "not available for your role" on a form where the
> feature is simply off, which sends the admin looking at the wrong control.

| Method | Path | Purpose | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/submissions/:publicId/attachments` | List | Returns `{ attachments, can_upload, folder_valid, max: 10 }` so the client renders from one response. |
| `POST` | `/api/submissions/:publicId/attachments` | Upload one file | Raw body; `X-File-Name`; 201 with the new row. |
| `GET` | `/api/submissions/:publicId/attachments/:id` | Open/download | `302` to Drive (§3.3.4). Scoped by `submission_id` **and** the row's `submission_id`, so an id from another submission 404s. |
| `DELETE` | `/api/submissions/:publicId/attachments/:id` | Remove | Deletes the Drive file, then the row. **Administrators only** — and the UI requires a confirmation drawer first (§6.2). |

`DELETE` is not in the brief. It is included because a mis-upload with no way back is a support
ticket, and the cap is only 10 — one wrong file costs a tenth of the allowance. §11 decision D2.

### 5.3 ★ How large a file can actually be uploaded

**The code imposes no limit. The hosting platform does.** This is the part of the feature most
likely to disappoint, so it is written down before anything is built.

The app is deployed to **Azure App Service (Linux, Node 24)** — `docs/plans/deploy-azure.md`
§1–§2, app `webform`, slot `sandbox`, startup command `node server/dist/index.js`. App Service
sits in front of the Node process as a reverse proxy, and that proxy has a fixed request timeout
of **230 seconds** (documented in the App Service app-settings reference as "a general idle
request timeout that disconnects clients after 230 seconds"). It is **not** an app setting and
cannot be raised. A request that is still streaming when the clock runs out is cut off, whatever
the app is doing.

So the real ceiling is **how many bytes the server can pull from the browser and push to Google
within 230 seconds**, i.e. roughly `throughput × 230`. Measured against typical school-network
uplinks:

| Upload bandwidth | Bytes in 230 s | Practical max file | Verdict for a 5-minute phone video (~150–400 MB) |
| --- | --- | --- | --- |
| 5 Mbps | ~144 MB | ~130 MB | ❌ fails |
| 10 Mbps | ~288 MB | ~270 MB | ⚠️ borderline |
| 25 Mbps | ~719 MB | ~690 MB | ✅ |
| 50 Mbps | ~1.4 GB | ~1.3 GB | ✅ |
| 100 Mbps | ~2.9 GB | ~2.7 GB | ✅ |

Three things make this worse than the table suggests:

1. **The server is a relay, not a pure proxy.** Bytes arrive from the browser *and* leave for
   Google through the same App Service instance. The two legs overlap, so the effective rate is
   near the slower leg — but the instance also pays for TLS on both, and a Basic-tier instance
   has one shared vCPU.
2. **A slow or flaky connection is fatal, not slow.** If the browser pauses (a laptop lid, a
   Wi-Fi drop, a phone leaving the room), the 230 s clock keeps running. There is **no resume**:
   a failed upload restarts from byte 0.
3. **Proactive Auto Heal** recycles an instance whose requests "take longer than 200 seconds"
   (App Service app-settings reference, `WEBSITE_PROACTIVE_AUTOHEAL_ENABLED`, default `true`).
   Even a *successful* long upload can therefore be interrupted — and, worse, it can recycle the
   instance for **everyone** using the app at that moment.

#### 5.3.1 What this means for the plan

| Requirement | Reality |
| --- | --- |
| R8 "no size restriction" | **True in the code** (nothing buffers, nothing caps) and **false in production** above roughly 130–700 MB depending on the school's uplink. |

The plan therefore does **not** promise "any size". It promises:

- **No artificial cap** — no `express` limit, no `multer` limit, no UI check.
- **A clear failure** instead of a silent one: the client shows a progress bar, and when the
  request dies (the proxy returns **502/504**, or the XHR errors) the card says
  *"The upload did not finish. Large files can time out — try a smaller file or a faster
  connection."* — **not** a generic error.
- **No orphaned files**: the Drive upload is aborted when the client disconnects
  (`req.on("aborted")` → `media.body.destroy()`), and a failed upload writes no DB row.

#### 5.3.2 The three ways to actually support large video

Escalating cost. **D7 asks which one you want.**

| Option | How it works | Ceiling | Cost / caveat |
| --- | --- | --- | --- |
| **A — accept the ceiling (plan default)** | Ship §5.1 as designed. Documents, photos, short audio fine; long video often not. | ~130–700 MB | Zero extra work. Honest copy in the UI. |
| **B — browser → Drive direct upload** | Server mints a **resumable upload session** (`POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable`, returning a `Location` URI), the browser `PUT`s the bytes **straight to Google** with `XMLHttpRequest`, and the server verifies + records the file afterwards. | Google's 5 TB; no App Service timeout at all | **Needs a public CORS configuration on the Drive origin** (`drive.file`/`drive` scope + `googleapis.com` CORS is fixed by Google and allows any origin, which is fine; the *resumable session URI* is the credential and must be treated as one). Resumable = survives drops. **More work**: a two-step API, a verification step (the server must `files.get` the file and confirm `parents` contains the right folder, otherwise a client could point the session anywhere), and the 10-cap check moves *after* the upload. This is the only option that truly satisfies R8. |
| **C — raise the platform ceiling** | Move to a host without a 230 s proxy timeout (Container Apps, App Service on a Premium plan with the same proxy limit — **no**, the timeout is the same; so: a VM/Container App with a direct listener), and/or set `WEBSITE_PROACTIVE_AUTOHEAL_ENABLED=false`. | Depends on the new host | Infrastructure change to a working deployment, for one feature. Not recommended. |

**Recommendation:** ship **A** now (it is the plan as written, and it covers the majority of real
attachments — PDFs, scans, photos, short clips), and treat **B** as a follow-up if staff actually
hit the ceiling. B is additive: it changes only the upload transport (§6.1), not the table, the
card, the cap, or the role gate.

#### 5.3.3 If you choose B, the extra pieces

- `POST /api/submissions/:publicId/attachments/session` → `{ uploadUrl, expiresAt }`.
  The server creates the resumable session with `requestBody: { name, parents: [folderId] }`
  and returns Google's session URI. **The session URI is a bearer credential** — it is returned
  only to the authenticated caller, never logged, and expires (Google default ~1 week; the plan
  sets `X-Upload-Content-Length` and treats it as short-lived).
- The browser `PUT`s the file to `uploadUrl` (plain `XMLHttpRequest`, resumable by sending
  `Content-Range` and re-querying `PUT` with `Content-Range: bytes */<total>` on failure).
- `POST /api/submissions/:publicId/attachments/complete` with the returned `fileId`. The server
  **must** `files.get(fileId, { fields: "id,name,parents,size,webViewLink" })` and confirm
  `parents` contains the expected submission folder before inserting the row — otherwise a
  caller could attach any file the OAuth account can see, including one from another form.
- Cap check happens at `complete`; an over-cap upload is deleted from Drive and answered `409`.

### 5.4 `getSubmissionDetail` and the parent path

`getSubmissionDetail` is shared by the parent-facing route
(`routes/submissions.ts` L99, `viewer = "parent"`). Attachments must **never** reach a parent:

```ts
const attachments =
  viewer === "parent" ? [] : await listAttachmentsBySubmission(submission.id);
```

and `attachments_roles` / `folder_valid` are likewise omitted for a parent viewer.

`SubmissionDetail` (server `queries.ts` L1874 **and** client `types/index.ts` L543) gains:

```ts
attachments: SubmissionAttachment[];
attachments_enabled: boolean;      // the form's "Enable Staff Attachments" switch
attachments_can_upload: boolean;   // resolves toggle + role + folder + cap, server-side
attachments_folder_valid: boolean;
```

Putting `attachments_can_upload` on the detail payload means the card's visibility is decided
**once, on the server**, and the client cannot disagree with the API about who may upload.
`attachments_enabled` is sent separately so an admin can be shown the read-only
"turned off for this form" card (§3.2) without the client re-deriving the rule.

### 5.5 Extension — the Links routes (added 2026-10-31)

| Method | Path | Purpose | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/submissions/:publicId/links` | Add a link | JSON `{ title, url }`. `400` with `"Link URL must begin with https://"` when the URL fails `isHttpsUrl`; `403` when the caller may not use the card (same gate as upload); `201` with the new row. |
| `DELETE` | `/api/submissions/:publicId/links/:id` | Remove a link | **Administrators only**, mirroring the attachment delete. Answers with the remaining links. |

Both repeat the standard preamble (`requireAuth` → `requireRoles("staff","cdm_contact","admin")` →
`getSubmissionDetail` → `submissionAccessError` → the attachments gate) and both are **ordinary
JSON routes**, so they live in `routes/submissions.ts` beside the attachment routes — not in the
pre-`express.json` upload router.

The gate is `attachmentsAccessErrorForForm` (§5.2) — the same toggle → folder → role →
reachability sequence. A link needs the folder to be *reachable* only because the card as a whole
is gated on it; nothing in the link path touches Drive.

`GET /api/submissions/:publicId/attachments` (the card's list call) gains `links` in its response,
so a card refresh returns both groups in one round trip.

---

## 6. Client

### 6.1 Types & API — `client/src/types/index.ts`, `client/src/lib/api.ts`

- `SubmissionAttachment` mirroring the server row.
- `Form.attachments_roles: string[] | null`.
- `api.listAttachments(publicId)`, `api.deleteAttachment(publicId, id)`.
- `api.uploadAttachment(publicId, file, onProgress?)` — **must not** go through the shared
  `request()` helper (it forces `Content-Type: application/json` and `JSON.stringify`s the
  body). It uses `XMLHttpRequest` so the card can show a progress bar:

  ```ts
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `${API_BASE}/api/submissions/${publicId}/attachments`);
  xhr.setRequestHeader("Authorization", `Bearer ${token}`);
  xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
  xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
  xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
  xhr.send(file);            // the File object streams; no FormData, no base64
  ```

  The 401 → refresh → replay path from `request()` must be replicated here (one retry), because
  a large upload can outlive the access token.

  **If D7 = option B** (direct-to-Drive, §5.3.2), this method changes and nothing else does:
  ask the server for a resumable session URI, `PUT` the file to Google from the browser, then
  call `complete`. The card, the table, the cap and the role gate are untouched.

### 6.2 `client/src/components/AttachmentsCard.tsx` (new)

Props: `publicId`, `canUpload`, `folderValid`, `initial: SubmissionAttachment[]`, `max = 10`.

Layout, top to bottom — this ordering is R6 verbatim:

```
┌ Attachments                                    [lock] Staff only ┐
│  <muted note: "Files are saved to this form's Google Drive folder.">│
│                                                                    │
│  [ + Attachment ]        ← primary/secondary button, opens the file picker
│  "3 of 10 attachments"   ← muted counter, right-aligned             │
│                                                                    │
│  ── list (below the + Attachment control) ────────────────────────  │
│  📄 CDM-00123 - Report Card.pdf   1.2 MB   · A. Smith, 10/31 2:14  [Open] [✕]
│  📄 CDM-00123 - IEP.pdf           480 KB   · A. Smith, 10/31 2:15  [Open] [✕]
│                                                                    │
│  <progress bar while uploading>                                     │
└────────────────────────────────────────────────────────────────────┘
```

- **Hidden entirely** when `!folderValid` or `!canUpload` → the page renders nothing (R1, R3).
- `+ Attachment` is `disabled` at the cap, with `title="Maximum of 10 attachments reached"`, and
  the counter reads `10 of 10 attachments`.
- Multiple selection is allowed; files are uploaded **sequentially** so the cap check is
  authoritative per file and a partial batch stops cleanly at the limit with a message.
- `accept` is unset — any file type (R8 says nothing about types).
- **No client-side size check** — no cap is imposed by the app. But the card **must** explain
  the host's ceiling when an upload dies (§5.3): a `502`/`504`/network error on an upload renders
  *"The upload did not finish. Very large files (long video or audio) can time out — try a
  smaller file or a faster connection."* rather than a generic failure. This is the difference
  between a support ticket and a user retrying with a smaller file.
- The progress bar shows bytes sent and elapsed time, so a user on a slow link can see it is
  moving rather than hung.
- Each row: file name (link → `GET .../attachments/:id`, which redirects), human size, uploader,
  timestamp, and — **for administrators only** — a ✕ that opens the confirmation drawer below.
  Staff see the row without any delete control.
- Errors render **inside the card** in an `alert-error`, not on the page: the page's `.error`
  slot is the load error and replaces the whole page (see the comment at
  `StaffSubmissionDetail.tsx` L~72).

### 6.3 `StaffSubmissionDetail.tsx`

- Add `const [attachments, setAttachments] = useState<SubmissionDetail["attachments"]>([])`,
  seeded from `detail.attachments` on load.
- Insert `<AttachmentsCard … />` in its own `<div style={{ marginTop: 18 }}>` **immediately after
  the Staff-only fields card's closing `</div>`** (currently L772, before the
  `{previewDoc && …}` block at L774).
- Render it only when `detail.attachments_folder_valid` is true **and**
  `detail.attachments_can_upload` — both from the server (§5.4). No client-side role logic.

### 6.4 `AdminFormDesigner.tsx` — replace the Public link card

Delete the `{form?.status === "published" && user?.organization_slug && (…)}` block (L991–1003)
and render in its place:

```
┌ Attachments                                                        ┐
│  Staff can attach files to each submission of this form. They are   │
│  saved to this form's Google Drive folder.                           │
│                                                                     │
│  Enable Staff Attachments                              [ Toggle ]   │
│  <muted: on  → "Staff can add up to 10 files per submission.">       │
│  <muted: off → "The Attachments card is hidden from staff.">          │
│                                                                     │
│  <warn if no Drive Folder ID: "Set a Drive Folder ID above to        │
│   enable attachments." — the switch AND the role toggles disabled>   │
│                                                                     │
│  Access   [✓ Administrator] [✓ Staff] [+ School Contact] [+ Reviewer]│
│  <muted: "Currently unrestricted: every role…" / "…exactly these…" /  │
│           "…nobody.">                                                │
│  <muted, only while the switch is off: "Role access is saved and      │
│   applies when Enable Staff Attachments is turned on.">               │
└─────────────────────────────────────────────────────────────────────┘
```

**The toggle** — reuse the shared [`Toggle`](../../client/src/components/Toggle.tsx) component
(the same control as Settings → Documents Link), with the visible label passed as `children` so
the words become the control's accessible name:

```tsx
<Toggle
  checked={attachmentsEnabled}
  disabled={!docFolderId.trim() || saving}
  onChange={(v) => { setAttachmentsEnabled(v); setDirty(true); }}
>
  Enable Staff Attachments
</Toggle>
```

- It is **part of the form's own Save**, like the Drive Folder ID and the Submission Detail Link
  — no separate endpoint, because it has no side effect on another table (unlike Visibility,
  which writes `form_access` and therefore has its own confirm step).
- **Disabled while there is no Drive Folder ID**, with the reason stated above it: enabling the
  feature without a folder would produce a card that can never upload.
- **Turning it off does not clear `attachments_roles`.** The role toggles stay enabled and keep
  their state, so re-enabling restores the same grant. (They are only disabled when there is no
  folder id.)
- **Existing attachments are untouched when it is switched off.** The card disappears from the
  submission page; the rows and the Drive files stay. Switching it back on brings the list back
  — it is driven by the DB, not by a Drive listing (§9).

**The role toggles** reuse the **exact** `accessRoleKeys()` + three-state logic from the
staff-only *Access* row (§2.2), including the `null` / `[]` / `[...]` distinction. **Do not**
materialise `null` into a role array on save — that is defect D2 in
`staff-only-field-access-toggles.md` §2.1, and it would silently freeze the grant at today's
roles.

`useRoleCatalog()` is currently called **inside `FieldRow`** (L1054). Hoist a single call to
the designer component and pass the catalog down (or call it again in the new card — the hook
is backed by a shared snapshot, so a second call is cheap; prefer this to avoid touching
`FieldRow`).

**State and save:**

- New state: `const [attachmentsEnabled, setAttachmentsEnabled] = useState(false);`
- Initial load (L~168–174) and post-save refresh (L~330–335) both gain
  `setAttachmentsEnabled(fresh.attachments_enabled ?? false)` and
  `setAttachmentsRoles(fresh.attachments_roles ?? null)`.
- `handleSave()` gains **both** keys, sent **always** so a cleared list is a real clear:

  ```ts
  attachments_enabled: attachmentsEnabled,
  attachments_roles: attachmentsRoles,   // null stays null — see D2 above
  ```

### 6.5 `AdminSettings.tsx` — a new *Attachments* panel

A `CollapsibleSection` titled **Attachments**, immediately after *Documents Link*
(L~1839), with the same shape as that panel:

- Copy: "Choose which roles can add files to a submission's Attachments card. This is the
  default for every form; an individual form can override it in its designer."
- One row per role with a `Toggle`, optimistic with rollback (`toggleAttachmentRole`, modelled on
  `toggleDocRole` L943).
- The scope sentence ("Currently unrestricted…" / "…nobody.") copied from the Documents panel.

This is the **global default** (`attachments_roles` setting); the per-form value overrides it.
§11 decision D3 asks whether the global layer is wanted at all — if not, the panel is dropped and
the setting is not added, which removes §7's settings rows.

### 6.6 Extension — the "+ Link" button and the Links list (added 2026-10-31)

All of this lives in `AttachmentsCard.tsx`; no new component and no new page.

**Types & API** (`client/src/types/index.ts`, `client/src/lib/api.ts`):

```ts
export interface SubmissionLink {
  id: number;
  submission_id: number;
  title: string;
  url: string;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
}

api.addSubmissionLink(publicId, { title, url }): Promise<SubmissionLink>
api.deleteSubmissionLink(publicId, linkId): Promise<SubmissionLink[]>
```

`SubmissionDetail` gains `links: SubmissionLink[]`; `api.listAttachments` gains `links` in its
result (it is the card's refresh call).

**The button.** `[ + Link ]` renders immediately to the right of `[ + Attachment ]` in the same
flex row, using the same `secondary-button` style with a `Link2` icon. It is disabled with the
same `title` reasons as the attachment button (`!canUpload`), but **not** at the 10-file cap —
links do not count against the cap.

**The form.** Clicking `+ Link` opens a small inline form *in place of nothing* — a panel above
the list, not a drawer and not `window.prompt` (nothing in this app prompts natively, and a
prompt cannot show a validation message next to the field):

```
┌ Add a link ───────────────────────────────────────────────┐
│ Link Title  [ Student handbook                        ]   │
│ Link URL    [ https://…                               ]   │
│             ⚠ Link URL must begin with https://           │
│                              [ Cancel ]  [ Add link ]     │
└───────────────────────────────────────────────────────────┘
```

- `Link Title` — required, trimmed, max 200.
- `Link URL` — required, **must begin with `https://`**. Validated on submit (and on blur) with
  the same rule as the server; the message is the server's own sentence, so the two cannot
  disagree. A URL typed as `http://…` or `www.…` is refused with that message rather than
  silently rewritten — rewriting would store something the user did not type.
- `Add link` is disabled while the request is in flight; errors render inside the panel
  (`alert-error`) so the typed values are not lost.
- On success the panel closes, the new row is appended to the **links** group (bottom of the
  list), and a `notice` reads `Added “<title>”.`

**The list.** One list, two groups, in this order:

1. every attachment (unchanged rendering), then
2. every link, oldest first — icon `Link2`, the **title** is the link (opens in a new tab with
   `rel="noopener noreferrer"`), the URL shows beside it in `muted-note` (truncated, full URL in
   the `title` attribute), then `· <creator>, <date>`, then `[Open]`, and for administrators the
   same `✕` → confirmation drawer, whose copy for a link says the web page itself is not affected.

The empty state changes from *"No attachments yet."* to *"No attachments or links yet."* and the
counter line stays about files (`3 of 10 attachments`) — links are not counted, and saying so
would imply they were.

---

## 7. Settings plumbing (only if D3 = "yes, global default")

Follow `documents_link` exactly:

| File | Change |
| --- | --- |
| `server/src/routes/settings.ts` | `ATTACHMENTS_ROLES_KEY = "attachments_roles"`; add to `ALLOWED_SETTING_KEYS`; `defaultValue()` → `JSON.stringify(null)`; the `PUT` branch validates role keys exactly like `DOCUMENTS_LINK_KEY` |
| `server/src/routes/roles.ts` | label `attachments_roles: "Attachments setting"` in the delete-guard census |
| `server/src/db/queries.ts` | `RoleUsage.attachments_roles: number`; count it in `roleUsage()` and `roleUsageTotal()` |
| `server/src/swagger.ts` | add the key to both `/api/settings/{key}` enums (L572, L594) |
| `client/src/types/index.ts` | `AppSettingKey` union |
| `client/src/lib/settings.ts` | `parseAttachmentRoles` / `attachmentsEnabledFor` (or reuse `parseDocumentRoles`) |
| `client/src/lib/useAttachmentsEnabled.ts` | hook mirroring `useDocumentsEnabled` |

---

## 8. Files to change

### Server

| File | Change |
| --- | --- |
| `db/schema.ts` | table + index + `forms.attachments_enabled` / `forms.attachments_roles` guards + `SubmissionAttachment` interface; **`submission_links` table + index + `SubmissionLink` interface (§4.6)** |
| `db/dialect/turso.ts` | table + index + both `forms` columns + two `addColumns` entries; **`submission_links` table + index** |
| `db/client.ts` | `TIMESTAMP_COLUMNS += "uploaded_at"`; `BOOLEAN_COLUMNS += "attachments_enabled"` |
| `db/queries.ts` | `SUBMISSION_CHILD_TABLES` (+ **`submission_links`**), `Form.attachments_roles`, form select/parse/create/update, `SubmissionDetail.attachments*` + **`links`**, `roleUsage()` census over `forms.attachments_roles`, `RoleUsage` (if D3) |
| `db/attachments.ts` *(new)* | `listAttachmentsBySubmission`, `createAttachment` (transactional cap), `getAttachment`, `deleteAttachment` |
| `db/links.ts` *(new)* | **`listLinksBySubmission`, `createLink`, `deleteLinkRow` (§4.6)** |
| `google/drive-upload.ts` *(new)* | `uploadSubmissionAttachment`, `deleteDriveFile`, `ensureSubmissionFolder` |
| `routes/attachments-access.ts` *(new)* | the shared gate (§5.2) |
| `routes/attachments-upload.ts` *(new)* | the pre-json raw upload router (§5.1) |
| `routes/submissions.ts` | `GET` list (**+ `links`**), `GET` file redirect, `DELETE`; **`POST`/`DELETE …/links` (§5.5)** |
| `routes/forms.ts` | `attachments_roles` on create/update; `drive-validate` unchanged |
| `schemas.ts` | `attachments_enabled: z.boolean().optional()` and `attachments_roles: z.array(z.string().max(64)).nullable().optional()` on the create + update form schemas; **`createSubmissionLinkSchema` + exported `isHttpsUrl`** |
| `index.ts` | mount `helmet()` + the upload router **above** `express.json` |
| `swagger.ts` | the three new submission routes; `attachments_roles` on the form schemas; settings enum (if D3); **`SubmissionLink` schema, `links` on the detail payload, the two link routes** |
| `package.json` | **no change** (option A) |

### Client

| File | Change |
| --- | --- |
| `types/index.ts` | `SubmissionAttachment`, `Form.attachments_enabled` + `attachments_roles`, `SubmissionDetail.attachments*` + **`links`**, **`SubmissionLink`**, `AppSettingKey` (if D3) |
| `lib/api.ts` | list/upload/delete; `uploadAttachment` via XHR; **`addSubmissionLink`, `deleteSubmissionLink`** |
| `components/AttachmentsCard.tsx` *(new)* | the card (§6.2) **+ the `+ Link` button, the add-link panel and the links group (§6.6)** |
| `pages/staff/StaffSubmissionDetail.tsx` | render the card below Staff-only fields |
| `pages/admin/AdminFormDesigner.tsx` | replace Public link card with the Attachments card: **Enable Staff Attachments** toggle + Access row |
| `pages/admin/AdminSettings.tsx` | Attachments panel (if D3) |
| `lib/settings.ts`, `lib/useAttachmentsEnabled.ts` | (if D3) |

### Docs

| File | Change |
| --- | --- |
| `docs/guides/admin/admin-guide.html` | §3.7 "Publishing and the public link" → "Attachments access (and publishing)"; Figure 11 caption rewritten; new figure for the Attachments card |
| `docs/guides/staff/*` | a short "Attachments" section on the submission page |
| `scripts/measure-admin-pins.mjs` | L185–190 pin on the `Public link` heading → the new card's heading |
| `docs/plans/feature-backlog.md` | cross-reference this plan |

---

## 9. Edge cases

| Case | Behaviour |
| --- | --- |
| Form folder id cleared after files were uploaded | Card disappears; the rows stay in the DB and the files stay in Drive. Re-setting the folder brings the card back with its list — **the list is driven by the DB, not by a Drive listing**, so files are never "lost" by a folder change. |
| Admin changes the folder id | New uploads go to the new folder; existing rows keep their `drive_file_id` and still open. |
| Submission deleted (archived → delete) | `submission_attachments` rows are deleted with it (`SUBMISSION_CHILD_TABLES`). **The Drive files are not** — same deliberate rule as generated documents (`queries.ts` L2756 comment). The delete dialog's copy must say so (§10). |
| Submission archived | Card still renders (archived submissions are readable by public id on purpose). Uploads are **allowed** — archiving hides a row from lists, it does not freeze it. §11 decision D4. |
| Two staff upload the 11th file simultaneously | One wins, one gets `409`; the loser's Drive file is deleted (§3.5). |
| File with no `Content-Type` | Stored as `application/octet-stream`; Drive still accepts it. |
| File name with `/`, `\`, `"`, or non-ASCII | Sanitised for the Drive name (§3.3.2); `file_name` keeps the original. |
| Google quota / 429 | `502` with the reason; Slack alert; no row written. |
| **Upload exceeds the 230 s proxy timeout** (large video on a slow link) | The proxy answers `502`/`504` and the client shows the "upload did not finish — try a smaller file" copy (§6.2). The server aborts the Drive stream on `req.on("aborted")`, so **no partial file is left in Drive** and no row is written. §5.3. |
| **Admin turns "Enable Staff Attachments" off on a form that already has files** | The card disappears for every non-admin; **the rows and the Drive files are untouched**. An admin still sees the read-only "turned off for this form" card (§3.2). Turning it back on restores the list and the previous role grant. |
| **Admin turns the toggle on but has no Drive Folder ID** | The toggle is disabled in the designer with the reason stated (§6.4); if it were somehow set anyway, the upload route answers `409` "no Drive Folder ID configured". |
| Drive account loses access mid-session | `validateDriveFolder` fails → `409` with the "not reachable" sentence. |
| Parent calls any attachment route | `403` (role guard) and the detail payload carries no attachment data. |
| Role deleted while it holds a grant | `roleUsage()` gains a **`form_fields.roles`-style LIKE census over `forms.attachments_roles`** (`roles IS NOT NULL AND roles LIKE @pattern`), so the delete guard blocks it exactly as it does for a staff-only field. This is required **regardless of D3**. |
| A role created after a form was saved with `NULL` | Sees the card — that is what `NULL` means. |
| **A link URL typed as `http://…`, `www.…`, `ftp://…` or `javascript:…`** | Refused with *"Link URL must begin with https://"* — in the panel on the client, and `400` from the server. It is never rewritten to `https://`; storing a URL the user did not type is worse than refusing it. |
| **A link URL with `https://` and no host (`https://`)** | Refused by the `new URL()` parse (§3.6.2) with the same message. |
| **A link whose page is later deleted** | The row stays; clicking it reaches the site's own 404. The submission record is a record of what was linked, not a liveness check. |
| **A link added while the submission is archived** | Allowed, same rule as an attachment upload (D4). |
| **Submission deleted (archived → delete)** | `submission_links` rows are deleted with it (`SUBMISSION_CHILD_TABLES`). Nothing external exists to clean up. |
| **A submission with 10 attachments** | `+ Link` is still enabled — links are not files and do not count against the cap. |
| **A link added by a staff member, removed by staff** | `403`; only an administrator may remove a link (D2), and the `✕` is not rendered for anyone else. |

---

## 10. Copy changes that must ship with the code

1. **Delete-submission dialog** (`StaffSubmissionDetail.tsx` L868–873): the paragraph that
   says generated Docs are not deleted must add *"Attached files are not deleted either — they
   stay in the organization's Drive folder."*
2. **Form designer, Drive Folder ID hint**: currently "Google Drive folder ID (optional — blank
   uses the default folder)". Add: *"Also used for staff attachments when set."*
3. **Admin guide §3.7** (Figure 11) and the *Public link* references at
   `admin-guide.html` L435, L441 — the new figure must show the **Enable Staff Attachments**
   toggle and the Access row.
4. **Card heading sub-line** — with links in the card, "Files are saved to this form's Google
   Drive folder" is no longer the whole story. It becomes *"Files are saved to this form's Google
   Drive folder. Links point to pages elsewhere."*
5. **Empty state** — "No attachments yet." → **"No attachments or links yet."**

---

## 11. Decisions needed from you

| # | Decision | Plan's choice |
| --- | --- | --- |
| **D1** | "Valid Drive Folder ID" = **live check** each time, or a stored flag? | **Live check** (§1.1 option A). |
| **D2** | Should staff be able to **delete** an attachment? | **Administrators only** (decided 2026-10-31). The uploader is not necessarily the right person to erase a file later, so the role is fixed. The card hides the ✕ from everyone else and the server refuses them. Every delete goes through a slide-out **confirmation drawer** that names the file — a mis-upload is cheap to undo, but an accidental delete is not. |
| **D3** | Is there a **global default** for attachment roles (a Settings panel), or **per-form only**? | **Yes, global default + per-form override**, mirroring `documents_link`. If no, §6.5 and §7 are dropped. |
| **D4** | May attachments be added to an **archived** submission? | **Yes** (§9). If no, the upload route returns `409` when `archived_at` is set. |
| **D5** | Should the **Public link** be moved elsewhere rather than deleted? | **Deleted** — the brief says it is not used. If you want it kept, it can move into the *Form Details* card as a read-only line. |
| **D6** | File **types** — really anything? | **Any type** (brief). If you later want to block executables, the `accept` attribute plus a server-side MIME allow-list is a small addition. |
| **D7** | **How large must a video/audio attachment be able to be?** The code has no cap, but Azure App Service cuts every request at **230 seconds**, so the practical ceiling is ~130 MB on a 5 Mbps uplink and ~700 MB on 25 Mbps (§5.3). | **Option A — accept the ceiling** and ship §5.1, with honest failure copy. If staff must upload multi-hundred-MB video reliably, choose **option B — browser → Drive resumable upload** (§5.3.2), which is additive: it changes only the upload transport, not the table, card, cap or role gate. |
| **D8** | Should an **admin** see the Attachments card on a form where **"Enable Staff Attachments" is off**? | **Yes, read-only** — the card says it is turned off and offers no upload (§3.2), so an admin can confirm what staff see. If no, admins see nothing and the card is strictly toggle-gated. |

---

## 12. Verification plan

Static:

- `server: npm run typecheck` · `client: npm run typecheck` · `client: npm run build`.
- `server: npm test` — the two updated suites (§4.5) plus the two new ones.

Database:

- Boot against SQL Server and against Turso (`DB_MODE=turso`); both create
  `submission_attachments`, `forms.attachments_enabled` and `forms.attachments_roles`; the
  boot-time missing-index report does not name `IX_submission_attachments_submission`.
- **Every pre-existing form reads `attachments_enabled = false`** after the migration, on both
  engines (this is the `DEFAULT 0` backfill, and the libSQL path needs the `addColumns` entry to
  reach it).
- `submissions-archive.test.ts` passes — i.e. the child set and `SUBMISSION_CHILD_TABLES` agree.

Browser (with a real Drive folder configured):

| Probe | Expected |
| --- | --- |
| Form with **no** folder id | No Attachments card on the submission |
| **"Enable Staff Attachments" off** (default on every existing form) | No card for staff; admin sees the read-only "turned off for this form" card |
| **Toggle on, then off again** | Card appears below Staff-only fields, then disappears; previously uploaded files reappear when switched back on |
| Form with a folder id, role **not** granted | No card |
| Form with a folder id, role granted | Card below Staff-only fields, `0 of 10 attachments`, `+ Attachment` enabled |
| Upload a 50 MB PDF | Progress bar runs; row appears **below** the button; file is in `<folder>/Attachments/<public_id>/` with the `<public_id> - ` prefix |
| **Upload a file that takes > 230 s** (throttle the browser to ~1 Mbps with a 200 MB file) | Fails with the "upload did not finish" copy; **no** row in the DB; **no** orphan in Drive. This is the §5.3 ceiling, measured rather than assumed. |
| Upload a ~50 MB video (`.mp4`) | Succeeds and plays from Drive via the file link |
| Upload files 1–10 | Counter climbs to `10 of 10`; `+ Attachment` disabled |
| Upload an 11th (via a second tab) | `409`, message "already has 10 attachments" |
| Click a file name | Opens the file in Drive |
| Delete an attachment (as admin) | ✕ opens a **drawer that slides in from the right** naming the file; Cancel leaves it; "Yes, remove it" deletes it from the list **and** from Drive |
| Delete control as staff / School Contact | **No ✕ at all**; a direct `DELETE` call answers **403** |
| Parent public page for the same submission | No attachment data in the network response |
| Archive → delete the submission | `submission_attachments` rows gone; Drive files still present; dialog said so |
| Form designer | Attachments card where Public link was; **Enable Staff Attachments** toggle disabled until a Drive Folder ID is set; toggles match the staff-only Access row behaviour (untick all → `[]`; re-grant one → only that one); role selection survives switching the feature off and on |
| Settings → Attachments (if D3) | Toggling a role changes the default for a form whose `attachments_roles` is `NULL` |

**Links (added 2026-10-31):**

| Probe | Expected |
| --- | --- |
| Card with no links | `+ Link` sits **next to** `+ Attachment`; empty state reads "No attachments or links yet." |
| Click `+ Link` | The add-link panel appears with `Link Title` and `Link URL`; Cancel closes it and discards what was typed |
| Submit with a `http://…` URL | Refused **in the panel** with "Link URL must begin with https://"; nothing is sent |
| `POST …/links` directly with `http://…` (curl) | `400` with the same sentence — the client is not the authority |
| Submit with a `https://…` URL | Row appears **below every attachment** and below earlier links; notice reads `Added “<title>”.` |
| Add two links | The second renders below the first; both below the files |
| Click a link title / Open | Opens the URL in a new tab |
| Add a link as staff | Allowed (when the card allows uploads); **no ✕** on the row |
| `DELETE …/links/:id` as staff (curl) | `403` |
| Remove a link as admin | ✕ opens the drawer; copy says the web page is not affected; "Yes, remove it" removes the row only |
| Submission with 10 attachments | `+ Link` still enabled; the counter still reads `10 of 10 attachments` |
| Archive → delete the submission | `submission_links` rows gone along with the attachment rows |
| Parent public page for the same submission | Neither attachments nor links in the network response |

---

## 13. Suggested build order

1. Schema + Turso DDL + `TIMESTAMP_COLUMNS` + `SUBMISSION_CHILD_TABLES`; update the two failing
   suites. *(Nothing user-visible yet; deployable on its own.)*
2. `forms.attachments_enabled` + `forms.attachments_roles` through schema → queries →
   `updateForm` → `schemas.ts`.
3. `google/drive-upload.ts` + `db/attachments.ts` + unit tests with the Drive client mocked.
4. The shared gate + the four routes; `index.ts` mount order. *(Curl-testable.)*
5. **Measure the real ceiling** (§5.3): upload a throttled large file and record where it dies.
   This decides whether D7 option B is needed before the UI is polished.
6. `AttachmentsCard` + the detail-page insertion.
7. Designer card replacing Public link.
8. Settings panel (if D3) + copy changes (§10) + guide updates.
9. *(Only if D7 = B)* the resumable-session routes and the browser `PUT` path (§5.3.3).

---

## 14. Extension — Links: what shipped (2026-10-31)

Built in the order below, on top of the implemented feature. No existing behaviour changed:
attachments render exactly as before, and the 10-file cap, the role gate and the delete rule are
untouched.

1. **Database.** `dbo.submission_links` + `IX_submission_links_submission` on SQL Server; the same
   table and index on Turso (new table, so no `addColumns` entry). `SUBMISSION_CHILD_TABLES` gains
   `submission_links`, which `submissions-archive.test.ts` verifies against the DDL in both
   directions.
2. **Data layer.** `server/src/db/links.ts` — list / create / delete, with the creator's display
   name joined (the same shape as `db/attachments.ts`).
3. **Validation.** `isHttpsUrl()` in `schemas.ts`, used by `createSubmissionLinkSchema` and pinned
   by unit tests (accepts `https://…`; refuses `http://`, `www.`, `javascript:`, `https://` with
   no host, and over-long URLs).
4. **Routes.** `POST` / `DELETE /api/submissions/:publicId/links` behind the existing gate;
   `GET …/attachments` now also returns `links`; the detail payload carries `links`.
5. **Client.** `SubmissionLink` type, `api.addSubmissionLink` / `api.deleteSubmissionLink`, the
   `+ Link` button, the inline add-link panel, and the links group rendered below the attachments
   with the same confirmation drawer for removal.

**Decisions taken without asking** (recorded here because they are the ones a reviewer would
otherwise ask about):

| Question | Choice | Why |
| --- | --- | --- |
| Separate table, or a nullable-URL row in `submission_attachments`? | **Separate table** | §3.6 — the attachment row is a Drive row; a link has no file, no size and no MIME type. |
| Do links count against the 10-file cap? | **No** | The cap is about Drive storage and the upload path; a link stores ~300 bytes. |
| May a link be edited after it is added? | **No** (remove and re-add) | Same as attachments — the row is a record of what was linked, and an edit would silently change a record someone else may already have read. |
| Who may remove a link? | **Administrators only** | D2, applied consistently. |
| Is `http://` rewritten to `https://`? | **No — refused** | Storing a URL the user did not type is worse than refusing it. |

