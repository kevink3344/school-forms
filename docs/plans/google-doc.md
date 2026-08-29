# Google Document Generation — Implementation Plan

> **Status:** Approved design (implement)
> **Date:** 2026-08-29
> **Goal:** When a staff member checks a staff-only **"Generate document"**
> checkbox on a submission and saves, the app creates a **Google Doc** from the
> existing template, fills its **inline `Label:`** placeholders with the
> submission's answers, and records it in a new **`Documents`** table.

---

## 0. What changed vs. the earlier draft

This plan supersedes `docs/features/create-doc.md`. Three decisions were made:

1. **Inline `Label:` placeholders**, NOT `{{FieldLabel}}` tokens. The template
   (`_Phase I Template (do not delete)`) is authored as plain paragraphs such as
   `Student Name:`, `School Name:`, `Course Title:`, `Phase 1 Result:`. The
   replacement logic appends the answer value **after** the matching `Label:`
   rather than swapping a `{{...}}` token.
2. **OAuth client + refresh-token grant**, NOT a service account. The app
   authenticates via `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` /
   `GOOGLE_REFRESH_TOKEN` (verified working against the live shared drive).
3. **Shared drive is on.** `GOOGLE_IS_SHARED_DRIVE=true` — every Drive call must
   pass `supportsAllDrives: true` and use the folder id in a shared drive.

### Verified credentials (already tested live)
- OAuth refresh token → access token ✅
- Read template doc (`1WWV6DZLxCmIsNVkLQD6rMhz3NJ-GS1-Pz0qkqaRyj8s`) ✅
- Read shared-drive folder (`0AMopBbRk6De5Uk9PVA`) ✅
- `drive.files.copy` into the folder ✅
- `documents.batchUpdate` (`replaceAllText`) ✅

---

## 1. Purpose

Staff reviewing a submission can tick a per-submission staff-only checkbox,
**"Generate document"**. On save, the app:

1. Creates a row in a new `dbo.documents` table (`Pending`).
2. Copies the Google Doc template into the target Drive folder.
3. Fills the **inline `Label:`** placeholders from the submission's answers.
4. Stores the Google Doc id and sets status to `Completed` (or `Failed` + error).

This keeps a permanent, auditable record of every generated document per
submission — who generated it, when, and the final Google Doc id.

---

## 2. New table: `dbo.documents`

Matches the existing SQL Server idioms in `server/src/db/schema.ts`.

### 2.1 Columns

| Column             | Type                                      | Notes                                          |
| ------------------ | ----------------------------------------- | ---------------------------------------------- |
| `id`               | `INT IDENTITY(1,1) PRIMARY KEY`           | Surrogate PK.                                  |
| `submission_id`    | `INT NOT NULL`                            | FK → `dbo.submissions(id)` `ON DELETE CASCADE`. |
| `document_id`      | `NVARCHAR(512) NULL`                      | Google Doc id. `NULL` while `Pending`.         |
| `status`           | `NVARCHAR(20) NOT NULL DEFAULT 'Pending'` | `CHECK (status IN ('Pending','Completed','Failed'))`. |
| `created_by`       | `INT NULL`                                | FK → `dbo.users(id)` `ON DELETE SET NULL`.     |
| `created_at`       | `DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()` | `DateCreated`.                              |
| `updated_at`       | `DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()` | Last change (for retries).                  |
| `error`            | `NVARCHAR(MAX) NULL`                      | Reason for `Failed`.                           |

### 2.2 DDL (idempotent — appends to `DDL_STATEMENTS`)

```sql
IF OBJECT_ID('dbo.documents', 'U') IS NULL
CREATE TABLE dbo.documents (
  id            INT IDENTITY(1,1) PRIMARY KEY,
  submission_id INT NOT NULL,
  document_id   NVARCHAR(512) NULL,
  status        NVARCHAR(20) NOT NULL CONSTRAINT DF_documents_status DEFAULT 'Pending'
                CHECK (status IN ('Pending','Completed','Failed')),
  created_by    INT NULL,
  created_at    DATETIME2 NOT NULL CONSTRAINT DF_documents_created_at DEFAULT SYSUTCDATETIME(),
  updated_at    DATETIME2 NOT NULL CONSTRAINT DF_documents_updated_at DEFAULT SYSUTCDATETIME(),
  error         NVARCHAR(MAX) NULL,
  CONSTRAINT FK_documents_submission FOREIGN KEY (submission_id) REFERENCES dbo.submissions(id) ON DELETE CASCADE
);
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name='FK_documents_creator')
  ALTER TABLE dbo.documents ADD CONSTRAINT FK_documents_creator
    FOREIGN KEY (created_by) REFERENCES dbo.users(id) ON DELETE SET NULL;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_documents_submission')
  CREATE INDEX IX_documents_submission ON dbo.documents(submission_id);
```

> **Cascade note:** `documents → submissions` is the child side (documents depends
> on submissions), so no "multiple cascade paths" error arises. `documents → users`
> uses `SET NULL` to avoid blocking user deletes. `submission_values.field_id →
> form_fields` stays `NO ACTION` (unchanged).

### 2.3 Typed row interface + status enum (in `schema.ts`)

```ts
export const DOCUMENT_STATUS = ["Pending", "Completed", "Failed"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUS)[number];

export interface Document {
  id: number;
  submission_id: number;
  document_id: string | null;
  status: DocumentStatus;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
  error: string | null;
}
```

---

## 3. Trigger point

The trigger is the **staff-only save** of the submission's answers — the existing
`PUT /api/submissions/:publicId/values` in `server/src/routes/submissions.ts`
(handler `handleSaveStaff` in the client).

The route already resolves the submission and enforces staff/admin + school
ownership. We hook generation **after** `updateSubmissionValues(...)` succeeds,
and only when the save was an explicit staff-only batch.

### 3.1 Idempotent guard (approach B)

Do **not** regenerate on every save. The documents service checks: if a
`Pending`/`Completed` row already exists for this submission, skip; otherwise
create one. This tolerates re-saves without duplicate docs and needs no extra
pre-read.

### 3.2 Locating the "Generate document" field

The checkbox is a **staff-only** field of `type = "checkbox"` whose label is
**"Generate document"**. Find it from the form's field list:

```ts
const fields = await listFormFields(submission.form_id);
const gen = fields.find(
  (f) => f.staff_only && f.type === "checkbox" && f.label.trim().toLowerCase() === "generate document"
);
```

### 3.3 Deciding whether to generate

Use the **submitted answer for that field_id** (fire the generation only if the
checkbox value is non-empty):

```ts
function readCheckbox(value: string | number | boolean | string[] | null): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value === null || value === undefined) return false;
  const s = String(value);
  return s !== "" && s !== "0" && s !== "false";
}
```

In the route handler, after `updateSubmissionValues`, call
`maybeGenerateDocument(submission, req.user!.id)`:
- If no `gen` field exists, no-op.
- If `readCheckbox` of the saved value is false, no-op.
- Otherwise, call `generateDocument(submission.id, req.user!.id)` (idempotent).

> The "Generate document" checkbox on form **CDM2** is field id **36**, options
> `["Yes"]`. Matching by **label** keeps the logic form-agnostic.

---

## 4. Google Docs integration — `server/src/google/docs.ts`

Authenticated as an **OAuth client using a refresh-token grant** (not a service
account). All Drive calls pass `supportsAllDrives: true`.

```ts
import { google } from "googleapis";
import { env } from "../config/env.js";

let authClient: ReturnType<typeof google.auth.OAuth2> | null = null;

export function getAuth() {
  if (!authClient) {
    authClient = new google.auth.OAuth2(
      env.google.clientId,
      env.google.clientSecret
    );
    authClient.setCredentials({ refresh_token: env.google.refreshToken });
  }
  return authClient;
}

const SCOPE = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive",
];
```

### 4.1 Copy the template

Documents are saved into a **per-school subfolder** of the configured Drive
parent (e.g. "WCPSS/Documents/Broughton High School"). The folder is created on
first use and reused thereafter. The file name follows the convention
`<Submission ID>-<Student Name>-<Did Student meet criteria?>`, e.g.
`CDM2-00001-Amy Anderson-Met`.

```ts
// Resolve (create if needed) a per-school folder under the Drive parent.
async function ensureSchoolFolder(drive, schoolName) {
  if (!env.google.docFolderId) return null;
  if (!schoolName) return env.google.docFolderId;
  const folderName = schoolName.trim();
  if (!folderName) return env.google.docFolderId;
  const existing = await findFolderByName(drive, folderName, env.google.docFolderId);
  if (existing) return existing;
  const res = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [env.google.docFolderId],
    },
    supportsAllDrives: env.google.isSharedDrive,
    fields: "id, name",
  });
  return res.data.id ?? null;
}

export async function copyTemplate(name: string, parentId: string | null): Promise<string> {
  const drive = google.drive({ version: "v3", auth: getAuth() });
  const res = await drive.files.copy({
    fileId: env.google.docTemplateId,
    requestBody: {
      name: sanitizeFileName(name),
      ...(parentId ? { parents: [parentId] } : {}),
    },
    supportsAllDrives: env.google.isSharedDrive,
  });
  return res.data.id!;
}
```

### 4.2 Fill inline `Label:` placeholders (the key logic)

The template uses **inline label-dot pairs**, e.g. `Student Name:`. We scan the
copy's paragraphs; for each paragraph whose text contains a known label, replace
the value **after** the colon with the answer.

```ts
export async function replacePlaceholders(
  docId: string,
  mappings: { label: string; value: string }[]
): Promise<void> {
  const docs = google.docs({ version: "v1", auth: getAuth() });
  const doc = await docs.documents.get({ documentId: docId });
  const requests = [];

  for (const el of doc.data.body?.content ?? []) {
    const para = el.paragraph;
    if (!para) continue;
    const text = (para.elements ?? [])
      .map((e) => e.textRun?.content ?? "")
      .join("");

    for (const m of mappings) {
      const idx = text.toLowerCase().indexOf(`${m.label.toLowerCase()}:`);
      if (idx === -1) continue;

      const valueStart = idx + m.label.length + 1; // after "Label:"
      // Replace from just after the colon to the end of the paragraph text.
      requests.push({
        deleteContentRange: {
          range: {
            startIndex: el.startIndex! + valueStart,
            endIndex: el.endIndex! - 1, // keep trailing newline
          },
        },
      });
      requests.push({
        insertText: {
          location: { index: el.startIndex! + valueStart },
          text: m.value,
        },
      });
      break; // one replacement per paragraph
    }
  }

  if (requests.length > 0) {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests },
    });
  }
}
```

> **Important:** The simple `replaceAllText` approach from the earlier draft does
> **not** work with inline label-dot pairs — the value after the colon is variable
> text, not a fixed `{{token}}`. We must compute string ranges from the paragraph
> indices. The implementation should **trim** existing whitespace after `:`,
> preserve the trailing paragraph newline, and handle a label whose paragraph has
> already been edited.

### 4.3 Putting it together — `generateDocument`

```ts
export async function generateDocument(submission, values, createdBy) {
  const mappings = buildLabelMappings(submission, values); // see §5

  // Per-school folder + `<Submission ID>-<Student Name>-<Did Student meet criteria?>` name.
  const school = submission.school_id ? await getSchool(submission.school_id) : null;
  const schoolName = school?.name ?? null;
  const drive = google.drive({ version: "v3", auth: getAuth() });
  const parentId = await ensureSchoolFolder(drive, schoolName);
  const docName = buildDocumentName(submission.public_id, values);

  const docId = await copyTemplate(docName, parentId);
  await replacePlaceholders(docId, mappings);
  return docId;
}
```

---

## 5. Label → value mapping

The template's inline labels and their **confirmed** answer sources are:

| Template label | Source | Notes |
| -------------- | ------ | ----- |
| `Date:` | **Generation time** (when the doc is created / the checkbox is checked) | Format `M/D/YY h:MMAM`, e.g. `8/29/26 3:00PM`. NOT the submission timestamp. |
| `Student Name:` | Submission answer — field labeled **`Student Name`** | Parent (non-staff) field. |
| `School Name:` | Submission answer — field labeled **`School`** | Parent (non-staff) field. |
| `Course Title:` | Staff-only field labeled **`Next Course in Sequence`** | E.g. `Math II`. |
| `Phase 1 Result:` | Staff-only field labeled **`Did Student meet criteria?`** | E.g. `Met` / `Not Met`. |

> The template also contains static paragraphs (`Definition of MET and NOT MET:`
> and the MET / NOT MET definitions) that are **not** replaced — they are boilerplate.

### 5.1 Mapping builder

Build `mappings` by matching the template label to the **field label** in the
submission's answers. Match case-insensitively and tolerantly:

```ts
const LABEL_TO_FIELD: Record<string, string> = {
  "Student Name": "Student Name",
  "School Name": "School",
  "Course Title": "Next Course in Sequence",
  "Phase 1 Result": "Did Student meet criteria?",
};

function buildLabelMappings(
  submission: SubmissionDetail,
  values: { field_id: number; field_label: string; value: string | number | boolean | string[] | null }[]
): { label: string; value: string }[] {
  const toText = (v: string | number | boolean | string[] | null): string =>
    Array.isArray(v) ? v.join(", ") :
    v === null || v === undefined ? "" :
    String(v);

  const byLabel = new Map(values.map((v) => [v.field_label.trim().toLowerCase(), v.value]));

  return Object.entries(LABEL_TO_FIELD).map(([label, field]) => {
    const value = byLabel.get(field.trim().toLowerCase());
    return { label, value: toText(value ?? null) };
  });
}
```

### 5.2 The `Date:` value

`Date:` is **not** an answer field. It's the generation time. Format the current
local time as `M/D/YY h:MMAM` (e.g. `8/29/26 3:00PM`), appended as an extra mapping:

```ts
const now = new Date();
const dateLabel = formatShortDate(now); // "8/29/26 3:00PM" — helper TBD
mappings.push({ label: "Date", value: dateLabel });
```

> The `date the document was created / when the user checks Generate document`
> semantics mean we use **generation time**, not `submission.submitted_at`.

---

## 6. New query helpers — `server/src/db/documents.ts`

Follows the `queries.ts` conventions (uses `execute`, `executeInTransaction`).

```ts
export async function createDocument(submissionId: number, createdBy: number): Promise<Document> {
  const rows = await execute<Document>(
    `INSERT INTO dbo.documents (submission_id, created_by)
     OUTPUT INSERTED.id, INSERTED.submission_id, INSERTED.document_id,
            INSERTED.status, INSERTED.created_by, INSERTED.created_at,
            INSERTED.updated_at, INSERTED.error
     VALUES (@submissionId, @createdBy)`,
    { submissionId, createdBy }
  );
  return rows[0];
}

export async function getDocumentBySubmission(submissionId: number): Promise<Document | null> {
  const rows = await execute<Document>(
    "SELECT * FROM dbo.documents WHERE submission_id = @submissionId",
    { submissionId }
  );
  return rows[0] ?? null;
}

export async function listDocuments(submissionId: number): Promise<Document[]> {
  return execute<Document>(
    "SELECT * FROM dbo.documents WHERE submission_id = @submissionId ORDER BY created_at DESC",
    { submissionId }
  );
}

export async function updateDocumentStatus(
  id: number, status: DocumentStatus, documentId: string | null, error: string | null
): Promise<Document> {
  const rows = await execute<Document>(
    `UPDATE dbo.documents
     SET status = @status, document_id = @documentId, error = @error, updated_at = SYSUTCDATETIME()
     OUTPUT INSERTED.id, INSERTED.submission_id, INSERTED.document_id,
            INSERTED.status, INSERTED.created_by, INSERTED.created_at,
            INSERTED.updated_at, INSERTED.error
     WHERE id = @id`,
    { id, status, documentId, error }
  );
  return rows[0];
}
```

---

## 7. Orchestrator

```ts
export async function maybeGenerateDocument(submissionId: number, createdBy: number): Promise<void> {
  // Idempotent: skip if a Pending/Completed row already exists.
  const existing = await getDocumentBySubmission(submissionId);
  if (existing && existing.status !== "Failed") return;

  let doc: Document;
  const pending = existing ?? await createDocument(submissionId, createdBy);
  doc = pending;

  try {
    const detail = await getSubmissionDetailForDoc(submissionId); // ids + values
    const docId = await copyTemplate(detail.public_id);
    await replacePlaceholders(docId, buildLabelMappings(detail));
    await updateDocumentStatus(doc.id, "Completed", docId, null);
  } catch (err) {
    await updateDocumentStatus(doc.id, "Failed", null, (err as Error).message);
    // Fire-and-forget: do NOT rethrow — the staff save already returned 200.
  }
}
```

---

## 8. API surface

| Method | Route | Auth | Purpose |
| ------ | ----- | ---- | ------- |
| `PUT` | `/api/submissions/:publicId/values` | staff/admin | Existing trigger — calls `maybeGenerateDocument` after a staff-only save. |
| `GET` | `/api/submissions/:publicId/documents` | staff/admin | List document rows for a submission. |
| `POST` | `/api/documents/:id/retry` | staff/admin | Re-attempt a `Failed`/`Pending` doc. |

### 8.1 New router — `server/src/routes/documents.ts`

```ts
export const documentsRouter = Router();
documentsRouter.post("/:id/retry", requireAuth, requireRoles("staff", "admin"), async (req, res, next) => {
  // resolve doc, validate ownership, set Pending, re-run orchestrator
});
```

Mount in `server/src/index.ts`:

```ts
app.use("/api/documents", documentsRouter);
```

---

## 9. Client UI

### 9.1 `client/src/types/index.ts`

```ts
export type DocumentStatus = "Pending" | "Completed" | "Failed";
export interface Document {
  id: number;
  submission_id: number;
  document_id: string | null;
  status: DocumentStatus;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  error: string | null;
}
```

### 9.2 `client/src/lib/api.ts`

```ts
export async function listDocuments(publicId: string): Promise<Document[]> {
  return apiRequest(`/api/submissions/${publicId}/documents`);
}
export async function retryDocument(id: number): Promise<Document> {
  return apiRequest(`/api/documents/${id}/retry`, { method: "POST", auth: true });
}
```

### 9.3 `StaffSubmissionDetail.tsx`

- After `handleSaveStaff`, call `listDocuments(publicId)` and render a small
  **status badge** next to the "Generate document" field (Pending / Completed /
  Failed).
- When `Completed`, render a link:
  `https://docs.google.com/document/d/{document_id}/edit`.
- When `Failed`, render a **Retry** button that calls `retryDocument(id)`.

---

## 10. `.env` / `env.ts`

Already implemented (verified working). No further changes needed.

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
GOOGLE_GRANT_TYPE=refresh_token
GOOGLE_DOC_TEMPLATE_ID=1WWV6DZLxCmIsNVkLQD6rMhz3NJ-GS1-Pz0qkqaRyj8s
GOOGLE_DOC_FOLDER_ID=0AMopBbRk6De5Uk9PVA
GOOGLE_IS_SHARED_DRIVE=true
```

`env.google` exposes `clientId`, `clientSecret`, `refreshToken`, `grantType`,
`docTemplateId`, `docFolderId`, `isSharedDrive`. The old `GOOGLE_SERVICE_ACCOUNT_*`
vars are now unused.

---

## 11. Files to create / modify

**Create**
- `server/src/google/docs.ts` — Google client + `copyTemplate` / `replacePlaceholders` / orchestrator.
- `server/src/db/documents.ts` — document row helpers.
- `server/src/routes/documents.ts` — `GET /documents`, `POST /:id/retry`.
- `docs/plans/google-doc.md` — **this plan**.

**Modify**
- `server/src/db/schema.ts` — `dbo.documents` DDL + `Document` interface + `DOCUMENT_STATUS`.
- `server/src/db/queries.ts` — any shared reads (e.g. `listSubmissionValues` used by orchestrator).
- `server/src/routes/submissions.ts` — hook `maybeGenerateDocument` into `PUT /values`; add `GET /:publicId/documents`.
- `server/src/index.ts` — mount `documentsRouter`.
- `server/src/config/env.ts` — already done.
- `server/src/schemas.ts` — any retry body schema.
- `server/src/swagger.ts` — document the new endpoints.
- `client/src/types/index.ts` — `Document`, `DocumentStatus`.
- `client/src/lib/api.ts` — `listDocuments`, `retryDocument`.
- `client/src/pages/staff/StaffSubmissionDetail.tsx` — status badge + link + retry.
- `client/package.json` / `server/package.json` — `googleapis` is already added.

---

## 12. Open questions (need user input)

✔ **Label → answer mapping — RESOLVED.** See §5 — `Date:` = generation time,
`Student Name:` = `Student Name`, `School Name:` = `School`, `Course Title:` =
`Next Course in Sequence`, `Phase 1 Result:` = `Did Student meet criteria?`.

1. **Failure UX.** On `Failed`, show a manual **Retry** button, or silently sweep in
   the background? Default for MVP: manual Retry.
2. **Access control on generated docs.** Keep them private to the authored OAuth
   Google account (staff open via the in-app link + a shared/anyone-with-link
   permission), or share with a school Drive? Default: copy is private to the
   account; set a "reader" sharing permission so the link works for staff.
3. **Blocking vs. fire-and-forget.** Default: **fire-and-forget** — the staff save
   returns `200` immediately, and the doc is `Pending` until the Google call
   completes.

---

## 13. Verification

- Server + client typechecks pass.
- Against live Azure SQL: after a staff-only save with "Generate document"
  checked, `GET /api/submissions/:publicId/documents` returns a row; after the
  Google call, `document_id` is populated and `status = 'Completed'`.
- The generated Google Doc exists in the shared drive folder and contains the
  filled inline `Label:` values on a fresh copy.
- If Google creds are missing/invalid, the row is `Failed` with a message and the
  staff save still returns `200`.
- End-to-end on a browser: check "Generate document" → Save staff fields →
  badge shows `Pending` then `Completed`, and the doc link opens.
