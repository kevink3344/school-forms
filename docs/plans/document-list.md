# Document List + Document-ID on Submission — Implementation Plan

> **Status:** Design proposal (implement)
> **Date:** 2026-08-29
> **Goal:** Give staff an easy, in-app way to see the Google Docs that were
> generated — no need to open Google Drive — plus surface each submission's
> generated document id right on the staff detail page.

---

## 1. Purpose

Today a generated Google Doc lives in Drive and is only visible if staff leave
the app and search Drive. We want:

1. A **"Documents"** menu link in the sidebar (under **Submissions**) that opens
   a page listing all generated documents, each row showing:
   **Date · Student Name · School Name · Course Title · Phase I Result ·
   Document ID · Status**.
2. On the **staff submission detail page**, the generated document id is captured
   and displayed **underneath the "Last save by"** line in the *Staff-only
   fields* card, as:
   `Document <id> generated on <date>`.

This reuses the `dbo.documents` table already speced in
[`docs/plans/google-doc.md`](../plans/google-doc.md) — no new storage. This plan
only adds the **read/display** layer (a list query + list page + detail-card line).

---

## 2. Data model — what each list row needs

The `dbo.documents` table only stores `id`, `submission_id`, `document_id`,
`status`, `created_by`, `created_at`, `updated_at`, `error`. **It does not** store
Student Name / School Name / Course Title / Phase I Result — those come from the
**submission's answers**.

So the list query must **join `documents → submissions → submission_values +
form_fields`** and pull the answers by field label:

| Display column | Source | Notes |
| -------------- | ------ | ----- |
| `Date` | `documents.created_at` | When the doc was generated. |
| `Student Name` | submission answer, field labeled **`Student Name`** | Non-staff field. |
| `School Name` | submission answer, field labeled **`School`** | Non-staff field (or `submissions.school_id → schools.name` when no answer). |
| `Course Title` | submission answer, staff-only field labeled **`Next Course in Sequence`** | E.g. `Math II`. |
| `Phase I Result` | submission answer, staff-only field labeled **`Did Student meet criteria?`** | E.g. `Met` / `Not Met`. |
| `Document ID` | `documents.document_id` | Google Doc id (may be `null` while `Pending`). |
| `Status` | `documents.status` | `Pending` / `Completed` / `Failed`. |

> The label-based columns reuse the same convention as `listSubmissions` (which
> pulls `student_name` via a `TOP 1 ... ORDER BY sort_order` subquery over
> `submission_values`). We extend that pattern with a small, reusable
> "get answer value by label" subquery.

---

## 3. Backend

### 3.1 New enriched row type (in `server/src/db/schema.ts`)

```ts
// A document row enriched with the labels shown on the Documents list page.
// The non-column fields are derived from the submission's answers.
export interface ListDocumentRow extends Document {
  public_id: string;     // submission public id (link through)
  school_id: number | null;
  school_name: string | null;
  student_name: string | null;
  course_title: string | null;
  phase1_result: string | null;
}
```

### 3.2 New query — `server/src/db/documents.ts`

```ts
export async function listDocuments(opts: {
  organizationId?: number | null;
  schoolId?: number | null;
  submissionId?: number | null;
}): Promise<ListDocumentRow[]> {
  const p: Record<string, unknown> = {};
  const clauses: string[] = [];
  if (opts.organizationId !== undefined && opts.organizationId !== null) {
    clauses.push("s.organization_id = @organizationId");
    p.organizationId = opts.organizationId;
  }
  if (opts.schoolId !== undefined && opts.schoolId !== null) {
    clauses.push("s.school_id = @schoolId");
    p.schoolId = opts.schoolId;
  }
  if (opts.submissionId !== undefined && opts.submissionId !== null) {
    clauses.push("d.submission_id = @submissionId");
    p.submissionId = opts.submissionId;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return execute<ListDocumentRow>(
    `SELECT d.id, d.submission_id, d.document_id, d.status,
            d.created_by, d.created_at, d.updated_at, d.error,
            s.public_id, s.school_id,
            sch.name AS school_name,
            (SELECT TOP 1 sv.value FROM dbo.submission_values sv
              JOIN dbo.form_fields ff ON ff.id = sv.field_id
              WHERE sv.submission_id = s.id AND LOWER(ff.label) = 'student name'
              ORDER BY ff.sort_order) AS student_name,
            (SELECT TOP 1 sv.value FROM dbo.submission_values sv
              JOIN dbo.form_fields ff ON ff.id = sv.field_id
              WHERE sv.submission_id = s.id AND LOWER(ff.label) = 'next course in sequence'
              ORDER BY ff.sort_order) AS course_title,
            (SELECT TOP 1 sv.value FROM dbo.submission_values sv
              JOIN dbo.form_fields ff ON ff.id = sv.field_id
              WHERE sv.submission_id = s.id AND LOWER(ff.label) = 'did student meet criteria?'
              ORDER BY ff.sort_order) AS phase1_result
     FROM dbo.documents d
     JOIN dbo.submissions s ON s.id = d.submission_id
     LEFT JOIN dbo.schools sch ON sch.id = s.school_id
     ${where}
     ORDER BY d.created_at DESC`,
    p
  );
}

// Convenience for the detail page (one submission's documents).
export async function listDocumentsBySubmission(submissionId: number): Promise<ListDocumentRow[]> {
  return listDocuments({ submissionId });
}
```

> **Note:** `School Name` uses `sch.name` (the submission's resolved school) —
> this is simpler and always correct for scoped forms. If a district form's
> "School" answer differs from `school_id`, swap the `school_name` subquery to
> match the `school name`/`school` label like `student_name` does. Flag for review
> during implementation.

### 3.3 Include documents in the submission detail payload

So the staff detail page can show `Document <id> generated on <date>` without an
extra round-trip, add `documents` to `getSubmissionDetail` in `queries.ts`:

```ts
export interface SubmissionDetail extends SubmissionRow {
  // ...existing values/comments/adhocFields/staffOnlyFields/parentFields...
  documents: ListDocumentRow[]; // added — the submission's generated docs
}
```

In `getSubmissionDetail`:

```ts
const documents = await listDocumentsBySubmission(submission.id);
return { ...submission, values, comments, adhocFields, staffOnlyFields, parentFields, documents };
```

### 3.4 Routes — `server/src/routes/documents.ts` (new)

Mirrors the ownership pattern already used in `submissions.ts`: staff are scoped
to their `school_id`, admin to their org.

```ts
export const documentsRouter = Router();

// STAFF: GET /api/documents — the Documents list page
documentsRouter.get("/", requireAuth, requireRoles("staff", "admin"), async (req, res, next) => {
  try {
    const rows = await listDocuments(
      req.user!.role === "staff"
        ? { schoolId: req.user!.school_id }
        : { organizationId: req.user!.organization_id }
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
```

Mount in `server/src/index.ts`:

```ts
app.use("/api/documents", documentsRouter);
```

> **Note:** `login-mode.md`/existing code may already mount `/api/documents` if the
> forward-declared endpoints landed. Confirm during implementation and avoid a
> duplicate mount. The existing forward-declared `GET /api/submissions/:publicId/documents`
> path (swagger) is the natural home for the per-submission read.

### 3.5 Swagger (`server/src/swagger.ts`)

Replace the **forward-declared** documents paths (currently marked "planned") with
real ones:

- `GET /api/documents` → `{ type: "array", items: { $ref: "#/components/schemas/ListDocumentRow" } }`
- `GET /api/submissions/{publicId}/documents` → array of `ListDocumentRow`
- Update the `Document` schema (or add `ListDocumentRow`) to include the enriched
  fields: `public_id`, `school_name`, `student_name`, `course_title`,
  `phase1_result`.

---

## 4. Client

### 4.1 Types — `client/src/types/index.ts`

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

// Row returned by the Documents list endpoint.
export interface DocumentRow extends Document {
  public_id: string;
  school_id: number | null;
  school_name: string | null;
  student_name: string | null;
  course_title: string | null;
  phase1_result: string | null;
}
```

Also add `documents: DocumentRow[]` to the existing `SubmissionDetail` interface
(`client/src/types/index.ts`).

### 4.2 API — `client/src/lib/api.ts`

```ts
async listDocuments(): Promise<DocumentRow[]> {
  return request<DocumentRow[]>("/api/documents", { auth: true });
},
```

(The per-submission documents arrive inside `getSubmission` via the `documents`
field added in §3.3 — no new method needed for the detail card.)

### 4.3 New page — `client/src/pages/staff/StaffDocuments.tsx`

Model it after `StaffQueue.tsx` (table + PageHead + StatusBadge + loading). Columns:

| Column | Value | Notes |
| ------ | ----- | ----- |
| Date | `row.created_at` | formatted `toLocaleString()`. |
| Student Name | `row.student_name` | |
| School Name | `row.school_name` | |
| Course Title | `row.course_title` | |
| Phase I Result | `row.phase1_result` | |
| Document ID | `row.document_id` | render as a clickable `<a target="_blank">` to `https://docs.google.com/document/d/{id}/edit`. |
| Status | `StatusBadge` | map `Pending`/`Completed`/`Failed` to badge colors. |

Each row links to the submission via `/staff/${row.public_id}` (click the Student
Name or a chevron).

```tsx
export default function StaffDocuments() {
  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  // load() via api.listDocuments() ...
  return (
    <div>
      <PageHead title="Documents" subtitle="Generated Google Docs from submissions" />
      {/* table ... */}
    </div>
  );
}
```

### 4.4 Route — `client/src/App.tsx`

Add inside the staff `ProtectedRoute` block:

```tsx
<Route
  path="/staff/documents"
  element={
    <ProtectedRoute roles={["staff"]}>
      <AppShell>
        <StaffDocuments />
      </AppShell>
    </ProtectedRoute>
  }
/>
```

> Order matters: register `/staff/documents` **before** `/staff/:publicId`, or a
> publicId of `documents` would match the detail route. (React Router v6 ranks
> static segments higher than dynamic ones, so `/staff/documents` wins anyway —
> but ordering it first is defensive.)

### 4.5 Sidebar link — `client/src/components/layout.tsx`

Add a **"Documents"** `NavLink` inside the staff `<>...</>` fragment, **after**
the Submissions link:

```tsx
<NavLink to="/staff/documents" className="sidebar-link" title={collapsed ? "Documents" : undefined} onClick={() => setMobileOpen(false)}>
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
  </svg>
  <span className="s-label">Documents</span>
</NavLink>
```

### 4.6 Submission detail card — `client/src/pages/staff/StaffSubmissionDetail.tsx`

Below the existing "Last saved by ..." line (the `muted-note`), render each of
the submission's documents:

```tsx
{detail.documents?.length > 0 && (
  <div className="muted-note" style={{ marginTop: 8 }}>
    {detail.documents.map((d) => (
      <div key={d.id} style={{ marginTop: 4 }}>
        Document{" "}
        {d.document_id ? (
          <a href={`https://docs.google.com/document/d/${d.document_id}/edit`} target="_blank" rel="noreferrer">
            {d.document_id}
          </a>
        ) : (
          <span>[{d.status.toLowerCase()}]</span>
        )}{" "}
        generated on {new Date(d.created_at).toLocaleString()}
      </div>
    ))}
  </div>
)}
```

This satisfies the requested line: **`Document <id> generated on <date>`**. When
the doc is still `Pending`/`Failed`, show `[pending]`/`[failed]` instead of a
link, and keep the manual **Retry** affordance from the google-doc plan.

---

## 5. Files to create / modify

**Create**
- `server/src/db/documents.ts` — `listDocuments`, `listDocumentsBySubmission`, `ListDocumentRow`.
- `server/src/routes/documents.ts` — `GET /api/documents`.
- `client/src/pages/staff/StaffDocuments.tsx` — the list page.
- `docs/plans/document-list.md` — **this plan**.

**Modify**
- `server/src/db/schema.ts` — `ListDocumentRow` interface (+ `SubmissionDetail.documents` if typed there).
- `server/src/db/queries.ts` — add `documents` into `getSubmissionDetail`.
- `server/src/index.ts` — mount `documentsRouter`.
- `server/src/swagger.ts` — real documents endpoints + `ListDocumentRow` schema.
- `client/src/types/index.ts` — `Document`, `DocumentRow`, `documents` on `SubmissionDetail`.
- `client/src/lib/api.ts` — `listDocuments()`.
- `client/src/App.tsx` — `/staff/documents` route.
- `client/src/components/layout.tsx` — Documents sidebar link.
- `client/src/pages/staff/StaffSubmissionDetail.tsx` — "Document [id] generated on [date]" line under "Last saved by".

---

## 6. Access control

- **Staff** → documents scoped to their `school_id` (and org). `GET /api/documents?school_id=...` under the hood; the backend filters, never trusting a query param alone.
- **Admin** → documents scoped to their `organization_id` (or all, per existing admin scope convention).
- The per-submission list (`GET /api/submissions/:publicId/documents`) reuses the
  existing staff `school_id === submission.school_id` ownership check.

---

## 7. Verification

- Server + client typechecks pass (`npx tsc --noEmit`).
- Seed a document row (or generate one) → `GET /api/documents` returns an enriched
  row with `student_name`, `school_name`, `course_title`, `phase1_result`,
  `document_id`, `status`.
- Staff sidebar shows **Documents** under **Submissions**; clicking it loads the
  list page with all 7 columns.
- On `/staff/:publicId`, the Staff-only fields card shows
  `Document <id> generated on <date>` under "Last saved by", and the id is a
  clickable Drive link when `Completed`.
- A staff user from a different school sees **no** documents for another school's
  submissions (403 / empty list).

---

## 8. Open questions (need user input)

1. **"School Name" source.** Use the submission's resolved `school_id → schools.name`
   (simple, always present for scoped forms), or read the parent-typed `School`
   answer field (matches what the parent entered)? Default: `schools.name`.
2. **Document ID copyability.** On the list page, should each Document ID be
   clickable (open in Drive) and/or have a "copy" button? Default: clickable link.
3. **Retry affordance.** Should `Failed`/`Pending` rows on the list page include an
   in-row **Retry** button (calls `POST /api/documents/:id/retry`), or keep retry
   only on the detail card? Default: both.
