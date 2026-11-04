# Staff-Only Column Bulk Edit — Plan

> **Status:** ✅ **Implemented and verified 2026-11-03** — client + server, 402 server tests
> passing, exercised end-to-end in the browser against form #2's `Toggle Probe` column.
> **Date:** 2026-11-03
> **Area:** Submissions grid (`SubmissionsGrid` / `StaffCell`), the inline-edit state machine
> (`useCellEdit`), and one new server route
> **Relation to other docs:**
> - Builds directly on the in-place staff-only cell editor described in
>   [`submission-view.md`](./submission-view.md) (superseded in part by
>   [`view-designer.md`](./view-designer.md)) — this plan does **not** change the storage or
>   the column picker.
> - Reuses the staff-only save contract (`PUT /api/submissions/:publicId/values` with
>   `staff_only: true`) documented there and in [`staff-only-field-access-toggles.md`](./staff-only-field-access-toggles.md).
> - The per-field role grants (`form_fields.roles`) are the authorization source of truth; see
>   [`roles-settings.md`](./roles-settings.md) §2 for the `null`-means-unrestricted sentinel.

---

## 1. What was asked

> "When staff selects a form, let them edit the **entire column** for a Staff Only field.
> Possibly a pencil in the header (on hover), each cell becomes editable instead of one by one,
> and a save icon to save the entire column when changes are made."

Today a staff-only cell is edited **one at a time**: click the value → inline editor → Enter/blur →
one `PUT /values` per cell, each one re-stamping `staff_fields_updated_by/_at` and each one able to
fire the "Generate document" hook. Filling a column of 40 rows means 40 clicks.

The screenshot shows the target: a staff-only column (`TOGGLE PROBE`) whose header carries a pencil
on hover, and whose cells are all editable at once.

---

## 2. Current behavior (research baseline)

| Piece | Where | What it does today |
| --- | --- | --- |
| Grid + header | [SubmissionsGrid.tsx](../../client/src/components/SubmissionsGrid.tsx) `SubmissionsGrid()`, `<thead>` | Renders one `<th>` per column; staff-only headers only carry `grid-col-staff` + `title`/`aria-label`. No controls. |
| Cell | [SubmissionsGrid.tsx](../../client/src/components/SubmissionsGrid.tsx) `StaffCell()` | Read-only for parent fields; click-to-edit for `column.staff_only`. Renders `renderEditor` inline, commits on Enter/blur, flashes `.grid-cell-saved`. |
| Edit state | [useCellEdit.ts](../../client/src/lib/useCellEdit.ts) `useCellEdit()` | **One** editor at a time (`editing: EditingCell \| null`), one draft, one save. Returns `CellEditApi`, which is threaded into the grid and into `ReportsPage`. |
| Save | [api.ts](../../client/src/lib/api.ts) `updateSubmissionValues()` → [submissions.ts](../../server/src/routes/submissions.ts) `PUT /:publicId/values` | One submission per request, `answers: [{field_id, value}]`, `staff_only: true`. |
| Persistence | [queries.ts](../../server/src/db/queries.ts) `updateSubmissionValues()` | Upsert per answer, then touch `submissions.updated_at`; when `staffOnly`, stamp `staff_fields_updated_by/_at`. |
| Doc hook | [docs.ts](../../server/src/google/docs.ts) `maybeGenerateDocument()` | If the batch contains a ticked staff-only "Generate document" checkbox, fire generation. |
| Access checks | [submissions.ts](../../server/src/routes/submissions.ts) `submissionAccessError()` | `canAccessSchool` + `canAccessForm` per submission — reused as-is by the new route. |
| Columns | [queries.ts](../../server/src/db/queries.ts) `getExportColumns()` | `key: field_N`, `staff_only`, `roles`, `type`, `options`; staff-only columns partitioned to the end. |
| Consumers | `AdminDashboard`, `StaffQueue`, `ReportsPage` | All three pass `edit={edit}`; the first two via `useSubmissionGrid`, the third via its own `useCellEdit`. |

**Constraints this baseline imposes**

1. `useCellEdit` is shared by three pages — its `CellEditApi` shape is a de-facto interface.
   Changing it means touching `ReportsPage` too.
2. The save contract must stay `PUT /values` with `staff_only: true` — that is what writes the
   audit stamp and what fires the document hook. A bespoke bulk endpoint that skips it would
   silently lose both (the same reason `useCellEdit` already refuses to use a per-cell endpoint).
3. Staff-only columns are role-filtered server-side; the grid only ever receives columns the
   caller may **see**. Seeing a column is not the same as being allowed to **write** it — the
   write path must re-check.
4. `ReportsPage` has no form selection, so "when staff selects a form" maps to the **Submissions
   grid** (admin dashboard + staff queue). Reports is a follow-on, not part of this change.

---

## 3. Proposed design

### 3.1 Interaction model

```
        ┌──────────────────────────────────────────────┐
 hover  │  TOGGLE PROBE            ✏️                   │  ← pencil appears on header hover
        ├──────────────────────────────────────────────┤
        │  [ Yes ▾ ]                                   │  ← every cell is a control
        │  [ No  ▾ ]                                   │
        │  [ Yes ▾ ]                                   │
        └──────────────────────────────────────────────┘
        ┌──────────────────────────────────────────────┐
        │  3 unsaved changes   [ Cancel ]  [ ✓ Save ]  │  ← sticky bar, only while dirty
        └──────────────────────────────────────────────┘
```

- **Enter mode** — the header pencil (visible on hover, and on focus for keyboard users, exactly
  like the existing `.cell-edit-hint`) turns the whole column into editors. Only **staff-only**
  columns get it; parent columns stay read-only.
- **Cell controls** — each cell renders the same `renderEditor` control the single-cell path
  already uses, so every field type behaves identically in both modes (`select` → dropdown,
  single-option `checkbox` → switch, `toggle` → switch, text → input, `radio`/multi-option
  `checkbox` → the existing portalled menu).
- **Draft, not save** — typing in a cell changes a **draft map** only. Nothing is written until
  Save. A cell that differs from its saved value gets a `.grid-cell-dirty` marker (dot / left
  border) so the changed rows are visible while scrolling.
- **Save** — the save icon (✓) commits the whole column in **one** request and shows a toast
  ("12 values saved"). On failure the bar stays with the error and the drafts are **kept**, so
  nothing typed is lost.
- **Exit** — `Esc` cancels the mode. If there are unsaved changes, a confirm ("Discard 3 unsaved
  changes?") is required, same pattern as the existing delete confirmations. Clicking the pencil
  again re-opens the mode with the drafts still in place.
- **Row scope** — the mode covers the rows **currently loaded and shown** (the grid's `rows`),
  i.e. the current school / status / search filter. It does not silently write to rows the user
  cannot see. The bar states the count so this is not a surprise.
- **Disabled rows** — archived submissions (and any row the server would refuse) are shown
  disabled with a tooltip, not silently skipped. Reuses the same "don't render a control that
  will always refuse" rule the Delete button already follows.

### 3.2 Why a separate state machine, not a change to `useCellEdit`

`useCellEdit` is a **one-editor** machine and its `CellEditApi` is consumed by three pages. Bulk
editing is a different machine: N drafts, one save, dirty tracking, discard confirmation. Rather
than widening `CellEditApi` (and forcing `ReportsPage` to care), add a sibling hook:

```
client/src/lib/useColumnEdit.ts   →  useColumnEdit({ rows, formId, onSaved }) : ColumnEditApi
```

```
interface ColumnEditApi {
  activeFieldId: number | null;          // the column in edit mode, if any
  drafts: Map<string, AnswerValue>;      // key = cellKey(publicId, fieldId)
  dirtyKeys: Set<string>;                // drafts whose value differs from the row's value
  saving: boolean;
  error: string | null;
  savedKeys: Set<string>;                // for the post-save flash, like today
  begin: (fieldId: number) => void;
  change: (publicId: string, value: AnswerValue) => void;
  save: () => void;
  cancel: () => void;                    // confirms when dirty
}
```

- The single-cell `edit: CellEditApi` prop **stays** on `SubmissionsGrid` and `StaffCell`. When
  `columnEdit.activeFieldId === field.id`, `StaffCell` renders the bulk control instead of the
  click-to-edit span — so a row's cell is never both.
- Picking a value in bulk mode goes through `change`, not `edit.commit`. The two modes therefore
  cannot race: one `PUT` per column, not one per cell.
- The value → draft seed is the same `toAnswerValue()` already in `SubmissionsGrid.tsx`; reuse it
  rather than writing a second narrowing function.

### 3.3 Client wiring

| File | Change |
| --- | --- |
| `client/src/lib/useColumnEdit.ts` | **New.** The machine in §3.2. |
| `client/src/components/SubmissionsGrid.tsx` | New optional prop `columnEdit?: ColumnEditApi`. Staff-only `<th>` renders the pencil when supplied. `StaffCell` takes `columnEdit` and renders the bulk control when the column is active. Reuse `toAnswerValue`, `renderEditor`, `commitsOnChange` helpers. |
| `client/src/lib/useSubmissionGrid.ts` | Instantiate `useColumnEdit` next to `useCellEdit`; expose it. `onSaved` patches `valuesByPublicId` for every saved cell (same shape as the single-cell `onSaved`). |
| `client/src/pages/admin/AdminDashboard.tsx`, `client/src/pages/staff/StaffQueue.tsx` | Pass `columnEdit={columnEdit}` to `<SubmissionsGrid>`; render the sticky save bar + `<Toast>` above/below the grid. |
| `client/src/pages/reports/ReportsPage.tsx` | **Unchanged in this phase.** Its `edit={edit}` keeps working. Follow-on (§7). |
| `client/src/styles/global.css` | `.grid-col-edit-hint` (header pencil, hover/focus reveal, same rule shape as `.cell-edit-hint`), `.grid-bulk-editor` (compact control sized to the cell, reusing `.grid-editor` metrics), `.grid-cell-dirty`, `.grid-bulk-bar` (sticky, `position: sticky; bottom: 0` inside the grid card). |

The pencil is an icon **button** with `aria-label="Edit all {label} values"` and
`aria-pressed={active}` — not a bare `<svg>` — so it is reachable by keyboard and announced.

### 3.4 Server — one batch endpoint

`PUT /api/submissions/:publicId/values` stays exactly as it is (single-submission contract, used
by the single-cell path, the detail page and Reports). Add one route beside it:

```
PUT /api/submissions/values/batch
  requireAuth, requireRoles("staff", "cdm_contact", "admin")
  body: { staff_only: true, updates: [{ public_id: string, answers: [{ field_id, value }] }] }
  → 200 { saved: number, failed: [{ public_id, error }] }
```

Rules, in order:

1. **Validate** with a new `bulkUpdateSubmissionValuesSchema` in
   [schemas.ts](../../server/src/schemas.ts): `updates` `.min(1).max(500)`; each `answers` reuses
   the existing `submissionAnswerSchema`. The cap is the guard against a single request writing an
   unbounded number of rows.
2. **Field allow-list** — resolve the form's columns once (`getExportColumns`) and reject any
   `field_id` that is not `staff_only` for that form. Bulk mode is a **staff-only** feature; a
   request that tries to write a parent field is a 400, not a silent write. This is the one place
   the bulk path is deliberately narrower than the single-cell path (which also edits parent
   fields from the detail page).
3. **Per-submission authorization** — loop the updates through the existing
   `submissionAccessError(req, submission)` (`canAccessSchool` + `canAccessForm`) and through the
   field's role grant (`form_fields.roles`), exactly as the preview's `filterColumnsForRole` does
   for reads. A row the caller may not write is reported in `failed[]` and **not** written.
4. **Write** — call the existing `updateSubmissionValues(submission.id, answers, { staffOnly: true, updaterId })`
   per submission. Reusing it is what keeps the audit stamp (`staff_fields_updated_by/_at`) and
   the "Generate document" hook (`maybeGenerateDocument`) intact — the same reason the client
   hook already refuses a bespoke endpoint.
5. **Partial failure is normal** — one row failing (archived mid-edit, moved school, deleted) must
   not roll back the other 39. The response reports `saved` + `failed[]`; the client keeps the
   drafts for the failed rows and shows them inline.
6. **Ordering / idempotency** — updates are independent upserts, so a retried request is safe.
   No transaction across submissions: they live in different rows and the audit stamp is
   per-submission anyway.
7. **Swagger** — add the route to [swagger.ts](../../server/src/swagger.ts) with the same
   `staff_only` semantics note the single route carries.

### 3.5 Client API method

```ts
// client/src/lib/api.ts
async updateSubmissionValuesBatch(
  updates: { public_id: string; answers: SubmissionAnswer[] }[]
): Promise<{ saved: number; failed: { public_id: string; error: string }[] }>
```

`useColumnEdit.save()` calls it once with one entry per dirty row, then:
- patches `valuesByPublicId` for every `saved` row via `onSaved`,
- flashes `.grid-cell-saved` on those cells (reuse `SAVED_FLASH_MS`),
- leaves the mode **open** if `failed[]` is non-empty, with the failed rows marked and the error
  text in the bar; closes it and shows the toast when everything succeeded.

---

## 4. Edge cases

| Case | Behaviour |
| --- | --- |
| No changes | Save is disabled; the bar shows "No changes". |
| Column has a single option (`toggle`, single-option checkbox) | Bulk editor is the existing switch — the screenshot's `Yes/No` column. |
| Multi-option `radio` / `checkbox` | The existing portalled `GridOptionMenu` is reused; only one menu may be open at a time (same portal rule: `.grid-scroll` clips absolutely-positioned children). |
| Field is `google_doc` / `textarea` | Renders the existing editor; the bulk cell is allowed to grow the row (the row-height constraint applies to read mode only). |
| Row archived / deleted / moved school between load and save | `failed[]` entry; draft kept; row flagged in the grid. |
| Caller's role lost the grant mid-session | 403 per row → `failed[]`; the column header shows a warning and the mode closes on the next load. |
| "Generate document" ticked in bulk | Fires once per affected submission through `maybeGenerateDocument` — same as today, just batched. |
| 40+ rows, `max(500)` cap | The client chunks by 200 per request and concatenates results, so the cap is never hit from the UI. |
| Mobile (rows become cards) | The header pencil is hidden on mobile (`.grid-scroll-top` precedent) — bulk editing is a desktop affordance; single-cell editing stays available. |
| Concurrent single-cell save while bulk mode is open | Bulk mode suppresses `StaffCell`'s click-to-edit for that column; other columns stay individually editable. |
| Form switched / filter changed while dirty | Discard confirmation, same as `Esc`. |

---

## 5. Files to change

**Client**
- `client/src/lib/useColumnEdit.ts` *(new)*
- `client/src/lib/useSubmissionGrid.ts`
- `client/src/lib/api.ts` — `updateSubmissionValuesBatch`
- `client/src/components/SubmissionsGrid.tsx` — header pencil, `StaffCell` bulk branch, save bar
- `client/src/pages/admin/AdminDashboard.tsx`, `client/src/pages/staff/StaffQueue.tsx`
- `client/src/styles/global.css`

**Server**
- `server/src/routes/submissions.ts` — `PUT /values/batch`
- `server/src/schemas.ts` — `bulkUpdateSubmissionValuesSchema`
- `server/src/swagger.ts` — the new route

**Docs**
- this plan; a line in `docs/guides/user-guide.md` (staff section) once shipped.

---

## 6. Testing

- **Unit (server)** — `bulkUpdateSubmissionValuesSchema` bounds; a request naming a parent field
  → 400; a row outside the caller's school → `failed[]`, others saved; audit stamp written once
  per saved submission; `maybeGenerateDocument` fires per ticked submission.
- **Unit (client)** — `useColumnEdit`: dirty tracking, discard confirmation, partial-failure keeps
  drafts, chunking at 200.
- **Manual** — the screenshot's flow: select form → hover header → pencil → change 3 rows → Save →
  toast → values persist after reload → audit line on the detail page shows the saving user.
- **Regression** — the three existing single-cell consumers (`AdminDashboard`, `StaffQueue`,
  `ReportsPage`) still edit one cell at a time with no new prop.

---

## 7. Open questions / follow-ons

1. **Reports page** — same affordance is possible there (it already renders `StaffCell`), but the
   page has no form selection and edits an overlay, not `valuesByPublicId`. Proposed as a
   follow-on once the grid version is proven.
2. **"Fill down"** — a "set every row to X" control on the bulk bar is the natural next step for
   `select`/`toggle` columns; deliberately out of scope here.
3. **Undo** — not proposed. The audit stamp records who and when; a bulk undo would need a
   before-image store the schema does not have.
4. **Parent fields** — the bulk path is staff-only by design (§3.4 rule 2). If admins later want
   to bulk-correct parent answers, the allow-list is the single line to revisit.
