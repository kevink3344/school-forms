# Generate Document — Feature Plan

> **Status:** Draft / design proposal (not yet implemented)
> **Goal:** When a staff member checks the **"Generate document"** checkbox on a
> submission (a staff-only field) and saves, the system creates a **Google Doc**
> from a template and records it in a new **Documents** table.

---

## 1. Purpose

Staff reviewing a submission can tick a per-submission staff-only checkbox,
**"Generate document"**. On save, the app should:

1. Create a row in a new `dbo.documents` table.
2. Call the **Google Docs API** (service account) to copy a **Google Doc
   template** and fill in placeholders from the submission's answers.
3. Store the resulting Google Doc id and status.

This keeps a permanent, auditable record of every generated document per
submission (who generated it, when, and what the final Google Doc id was).

---

## 2. New table: `dbo.documents`

The user specified these columns: `SubmissionID`, `DocumentID`, `DateCreated`,
`CreatedBy`, `Status` (`Pending`, `Completed`). We extend with a surrogate PK and
foreign keys, matching the existing SQL Server idioms in `server/src/db/schema.ts`.

### 2.1 Columns

| Column                | Type            | Notes                                                       |
| --------------------- | --------------- | ----------------------------------------------------------- |
| `id`                  | `INT IDENTITY(1,1) PRIMARY KEY` | Surrogate PK.                          |
| `submission_id`       | `INT NOT NULL`  | FK → `dbo.submissions(id)` `ON DELETE CASCADE`.              |
| `document_id`         | `NVARCHAR(512) NULL` | The Google Doc id returned by the API. `NULL` while `Pending`. |
| `status`              | `NVARCHAR(20) NOT NULL DEFAULT 'Pending'` | `CHECK (status IN ('Pending','Completed','Failed'))`. |
| `created_by`          | `INT NULL`      | FK → `dbo.users(id)` `ON DELETE SET NULL`. Staff who triggered it. |
| `created_at`          | `DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()` | `DateCreated`.       |
| `updated_at`          | `DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()` | Last change (for retries). |
| `error`               | `NVARCHAR(MAX) NULL` | Optional — reason for `Failed`.                              |

**Status enum:** `Pending` (creation in flight) → `Completed` (Google doc id
stored). Add `Failed` so a retryable failure is visible instead of hanging forever.

### 2.2 DDL (idempotent, matches `schema.ts` pattern)

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
  CONSTRAINT FK_documents_submission FOREIGN KEY (submission_id) REFERENCES dbo.submissions(id) ON DELETE CASCADE,
  CONSTRAINT FK_documents_creator FOREIGN KEY (created_by) REFERENCES dbo.users(id) ON DELETE SET NULL
);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_documents_submission')
  CREATE INDEX IX_documents_submission ON dbo.documents(submission_id);
```

> **Cascade note:** `submissions` already cascades from `forms`, and
> `submission_values.field_id → form_fields` is `NO ACTION`. `documents →
> submissions` cascading from `submissions` is **safe** — it's the child side
> (documents depends on submissions), so no "multiple cascade paths" error arises.
> `documents → users` uses `SET NULL` to avoid blocking user deletes.

### 2.3 Typed row interface (in `schema.ts`)

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

The trigger is the staff-only **save** of the submission's answers, i.e. the
existing route:

```
PUT /api/submissions/:publicId/values
```

in `server/src/routes/submissions.ts`. The route already:

- resolves the submission,
- enforces staff/admin + school ownership,
- calls `updateSubmissionValues(...)` with `{ staffOnly, updaterId }`.

### 3.1 Transition-on-check logic

We must only generate a document when the checkbox **transitions to checked**
(and not re-generate on every subsequent staff save). Two approaches:

- **A — Detect the transition in the route (recommended).**
  Before calling `updateSubmissionValues`, read the submission's current
  `"Generate document"` field value. After the upsert, if the saved value is
  checked **and** the previous value was not (or no document row exists yet),
  create the document.

- **B — Idempotent guard in the documents service.**
  Always attempt generation but **skip if a `Pending`/`Completed` document row
  already exists** for this submission. Simpler, tolerates re-saves without
  duplicate docs.

The plan uses **B (idempotent)**, because it needs no extra pre-read and is safe
under retries. A document row is only created once — if none exists, create one;
otherwise leave it alone.

### 3.2 Locating the "Generate document" field

The checkbox is a **staff-only** field of `type = "checkbox"` whose label is
**"Generate document"**. The route/service finds it via the form's field list:

```ts
const fields = await listFormFields(submission.form_id);
const gen = fields.find(
  (f) => f.staff_only && f.type === "checkbox" && f.label.trim().toLowerCase() === "generate document"
);
```

Then examine the submitted answer for that `field_id`. Because checkbox values are
serialized as JSON arrays, compare against the stored value:

```ts
const answer = parsed.data.answers.find((a) => a.field_id === gen.id);
const val = Array.isArray(answer?.value) ? answer.value : answer?.value ? [answer.value] : [];
const shouldGenerate = val.length > 0; // checked → has at least one option selected
```

> The "Generate document" checkbox on form **CDM2** is field id **36**, options `["Yes"]`.
> Matching by label keeps the logic form-agnostic (district-wide + school forms).

---

## 4. Google Docs integration

The user will supply the Google auth + template id in `.env`. We use a
**Google Service Account** (`googleapis` npm package), not OAuth, because it's a
server-to-server background job with no user consent flow.

### 4.1 Auth flow

1. Load a service-account JSON (or the key directly) from `.env`.
2. `google.auth.GoogleAuth` with the service account.
3. Scope: `https://www.googleapis.com/auth/documents` (read/write docs). If the
   template and generated doc live in Drive and need `files.copy`, also grant
   `https://www.googleapis.com/auth/drive`.

### 4.2 Template copy + placeholder replacement

Using the **Google Docs API**:

1. `drive.files.copy` the template (by `GOOGLE_DOC_TEMPLATE_ID`) → returns a new
   doc id (`document_id`).
2. `documents.batchUpdate` on the new doc to replace `{{PLACEHOLDER}}` tokens with
   the submission's answer values (see `docs.documents.batchUpdate` with
   `replaceAllText`).

Placeholder convention: `{{FieldLabel}}` or `{{FieldId}}`, e.g. `{{Student Name}}`,
`{{Student ID}}`, `{{School}}`, `{{DateSubmitted}}`. The user will confirm the
exact mapping (Student Name, Student ID, etc.).

### 4.3 New service file

**`server/src/db/documents.ts`** (or `server/src/google/docs.ts`):

- `generateDocument(submissionId, createdBy)` — the orchestrator.
  - idempotency check (does a doc row already exist?)
  - insert `Pending` row
  - copy template → `batchUpdate` placeholders → store `document_id`, set `Completed`
  - on error: set `Failed` + `error`, rethrow (do **not** break the staff save)

### 4.4 npm dependencies

```bash
npm i googleapis
# (document this in the plan; not installed yet)
```

> `googleapis` is large. Alternatively `@googleapis/docs` + `@googleapis/drive`
> (smaller, typed). Recommend the scoped packages.

---

## 5. Failure tolerance & robustness

Given the Azure SQL Serverless auto-suspend behavior already noted in this repo,
and the fact that a staff save should never hang or hard-fail because Google is
unreachable:

- **Fire-and-forget with status.** Create the `Pending` row, then attempt the
  Google call. If the call fails, set `Failed` + reason. The staff save returns
  `200` immediately — the UI shows the document status, not an error.
- **Do not `await` Google in the save path** unless the user wants a blocking UX.
  Default: kick off the async job and mark `Pending`; a later call (or a
  background sweep) can retry `Pending`/`Failed`. For a first cut, an `await` is
  acceptable since Google calls are usually < 2s.
- **Retryable:** a `POST /api/documents/:id/retry` (staff) or a periodic sweep
  processes rows stuck in `Pending`/`Failed`.

---

## 6. `.env` additions

The user said they'll provide these. Add to `env.ts` (`server/src/config/env.ts`)
and `.env`:

```env
# Google Docs / Drive service account
GOOGLE_SERVICE_ACCOUNT_JSON=          # full JSON string, or a path to the key file
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=      # alternative to the inline JSON
GOOGLE_DOC_TEMPLATE_ID=               # id of the template Google Doc
```

Expose on `env`:

```ts
google: {
  serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "",
  serviceAccountKeyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ?? "",
  docTemplateId: process.env.GOOGLE_DOC_TEMPLATE_ID ?? "",
},
```

---

## 7. API surface

| Method | Route | Auth | Purpose |
| ------ | ----- | ---- | ------- |
| `POST` | `/api/submissions/:publicId/documents` | staff/admin | Trigger generation (used internally; exposed for retry/manual trigger). |
| `GET`  | `/api/submissions/:publicId/documents` | staff/admin | List document rows for a submission. |
| `POST` | `/api/documents/:id/retry` | staff/admin | Re-attempt a `Failed`/`Pending` doc. |

The **main** trigger is the existing `PUT /values` staff-only save (see §3) — the
`POST .../documents` endpoint is the explicit/manual path.

---

## 8. Client UI

In `StaffSubmissionDetail.tsx`, after the staff-only save:

- If the "Generate document" field is checked, show a small **status badge**
  (Pending / Completed / Failed) next to it.
- Optionally render a link to the generated doc (`https://docs.google.com/document/d/{document_id}/edit`)
  when `Completed`.

Add types to `client/src/types/index.ts`:

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

---

## 9. Files to create / modify

**Create**
- `server/src/db/documents.ts` — table helpers + `generateDocument` (Google call).
- `server/src/google/docs.ts` — `googleapis` client + `copyTemplate`/`replacePlaceholders`.
- `client/src/components/DocumentStatusBadge.tsx` — small status UI (optional).
- `docs/features/create-doc.md` — **this plan**.

**Modify**
- `server/src/db/schema.ts` — `dbo.documents` DDL + `Document` interface + `DOCUMENT_STATUS`.
- `server/src/db/queries.ts` — `createDocument`, `listDocuments`, `updateDocumentStatus`.
- `server/src/routes/submissions.ts` — hook the trigger into `PUT /values` (idempotent §3.1-B); add `GET /documents`.
- `server/src/routes/documents.ts` — new router for `POST /documents`, `POST /documents/:id/retry`.
- `server/src/index.ts` — mount `documentsRouter`.
- `server/src/config/env.ts` — Google env vars.
- `server/src/schemas.ts` — any new Zod schemas (e.g. retry body).
- `server/src/swagger.ts` — document the new endpoints.
- `client/src/lib/api.ts` — `generateDocument`, `listDocuments`, `retryDocument`.
- `client/src/pages/staff/StaffSubmissionDetail.tsx` — status badge + link.

---

## 10. Open questions (need user input)

1. **Field → placeholder mapping.** The user will provide (Student Name, Student
   ID, etc.). Confirm the exact field labels and the template's `{{placeholder}}`
   token names.
2. **Auth delivery.** Inline JSON string vs. key-file path in `.env`?
3. **Blocking vs. fire-and-forget.** Should the staff save wait for the Google
   call, or return immediately with a `Pending` badge?
4. **Failure UX.** If Google fails, should the user see `Failed` (with a manual
   retry) or should it silently retry in the background?
5. **Access control on generated docs.** Keep them private to the service account
   (staff open via a shared link) or share with the school's Drive?

---

## 11. Verification

- Server + client typechecks pass (`npm run typecheck:server`, `npm run typecheck:client`).
- Against live Azure SQL: `GET /api/documents` returns the row; after a successful
  Google call, `document_id` is populated and `status = 'Completed'`.
- If Google creds are missing, the row is `Failed` with an error and the staff save
  still returns `200`.
- End-to-end on a browser: check "Generate document" → Save → badge shows status.
