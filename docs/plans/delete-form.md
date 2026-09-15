# Plan — Delete an Unused Form

**Status:** Shipped — and extended; see §10.
**Date:** 2026-09-13
**Area:** Admin → Forms (`/admin/forms`)

> **⚠️ Partly superseded by §10 (2026-09-15).** §4.5 and §8 open decision 4 recommended
> **hard delete only**, waving archiving off as "a separate, already-existing concept". That was
> overruled. The guard this plan depends on is also *why the feature looked broken*: both live
> forms have submissions, so Delete was disabled on every row — and a disabled button that still
> reads "Delete" is indistinguishable from a broken one. **Delete is retained for
> submission-free forms, and Archive was built beside it** as the always-available,
> non-destructive option. Everything else here — the cascade warning in §2, the server-side
> zero-submission guard, the org scoping — stands, and §10 builds directly on it.

---

## 1. Goal

Let an admin **delete a form that has never been used** (no submissions), directly from the
Forms list, so test/abandoned drafts can be cleaned up instead of lingering forever.

A form is **deletable only when it has zero submissions**. Forms with any submission history
are **not** deletable — that data must be preserved.

---

## 2. Why the "unused" guard is mandatory (not just nice-to-have)

This is the single most important constraint in this plan.

`dbo.submissions.form_id` is declared:

```sql
CONSTRAINT FK_submissions_form FOREIGN KEY (form_id)
  REFERENCES dbo.forms(id) ON DELETE CASCADE
```

Because of `ON DELETE CASCADE`, a naive `DELETE FROM dbo.forms WHERE id=@id` would **silently
destroy every submission for that form** — and, cascading further, every
`submission_values`, `comments`, `adhoc_fields`, and `documents` row attached to those
submissions. There is no undo.

So the server **must** count submissions first and refuse the delete when the count is
non-zero. The cascade is a database-level safety net we never want to trigger.

### FK map (what cascades from a form)

| Child table | FK | On delete of form |
| --- | --- | --- |
| `form_fields.form_id` | → `forms.id` | CASCADE (fields go with the form — intended) |
| `submissions.form_id` | → `forms.id` | **CASCADE (dangerous — the guard prevents this)** |
| `submission_values.submission_id` | → `submissions.id` | CASCADE |
| `comments.submission_id` | → `submissions.id` | CASCADE |
| `adhoc_fields.submission_id` | → `submissions.id` | CASCADE |
| `documents.submission_id` | → `submissions.id` | CASCADE |

---

## 3. Current state

- **No delete route exists.** `server/src/routes/forms.ts` has GET/POST/PUT/PATCH only:
  `/public`, `/:id/public`, `/`, `/:id`, `POST /`, `PUT /:id`, `POST /:id/drive-validate`,
  `PATCH /:id/status`, `GET /:id/columns`, `PUT /:id/columns`.
- **No `deleteForm` query** in `server/src/db/queries.ts` (has `listForms`, `getForm`,
  `getFormWithFields`, `listFormFields`).
- **No `deleteForm` API client method** in `client/src/lib/api.ts` (has `createForm`,
  `updateFormStatus`).
- **Forms list UI** (`client/src/pages/admin/AdminForms.tsx`) shows Edit + Publish/Unpublish
  buttons per row. No delete affordance.
- **Ownership scoping** is already the established pattern: every admin route calls
  `getFormWithFields(id, req.user!.organization_id)` and 404s if the form isn't in the org.

---

## 4. Design decisions

### 4.1 Where the guard lives — server, always

The submission count check must be **server-side** (the client check is only UX sugar).
The client may hide/disable the button, but the API must independently enforce it. Never trust
the client for a destructive operation.

### 4.2 How to count submissions

Add a small query helper:

```ts
export async function countSubmissionsForForm(formId: number): Promise<number> {
  const rows = await execute<{ n: number }>(
    `SELECT COUNT(*) AS n FROM dbo.submissions WHERE form_id = @formId`,
    { formId }
  );
  return rows[0]?.n ?? 0;
}
```

### 4.3 Delete semantics

- **Zero submissions** → delete the form. `form_fields` cascade automatically (correct — the
  fields belong to the form and nothing else references them).
- **One or more submissions** → **409 Conflict** with a clear message and the count, e.g.
  `{ error: "This form has 12 submissions and cannot be deleted.", submission_count: 12 }`.

### 4.4 Should "published" forms be deletable?

Recommendation: **yes, if unused.** A published-but-never-submitted form is still "unused" and
should be cleanable. The submission count is the real gate, not the status. (If you'd rather
require unpublishing first, that's a one-line tightening — see §8 Open Decisions.)

### 4.5 Hard delete vs. soft delete (archive)

> **⚠️ Recommendation superseded by §10 (2026-09-15).** "Archive remains a separate,
> already-existing concept" is no longer the position — the user asked for Delete to *be*
> Archive, and the outcome was to keep both. Read this section as the analysis that was
> available at the time; §10 records what shipped and why.

The schema already has an `archived` status. Options:

- **Hard delete** (recommended for this plan): actually removes the row. Simple, matches the
  user's ask ("delete an unused form"), and the unused-guard makes it safe.
- **Soft delete**: set `status='archived'`. Preserves the row but doesn't remove it from the
  Forms list unless the list filters archived out — which changes existing behavior.

**Recommendation:** hard delete, gated on zero submissions. Archive remains a separate,
already-existing concept.

---

## 5. Backend changes

### 5.1 `server/src/db/queries.ts`

Add `countSubmissionsForForm(formId)` (see §4.2) and `deleteForm(id, organizationId?)`:

```ts
export async function deleteForm(id: number, organizationId?: number | null): Promise<boolean> {
  const clauses: string[] = ["id = @id"];
  const params: Record<string, unknown> = { id };
  if (organizationId !== undefined && organizationId !== null) {
    clauses.push("organization_id = @organizationId");
    params.organizationId = organizationId;
  }
  const result = await execute<{ id: number }>(
    `DELETE FROM dbo.forms OUTPUT DELETED.id WHERE ${clauses.join(" AND ")}`,
    params
  );
  return result.length > 0;
}
```

The `OUTPUT DELETED.id` returns the deleted row's id so the caller can tell whether anything
was actually deleted (distinguishing "deleted" from "not found / not in org").

### 5.2 `server/src/routes/forms.ts`

Add a DELETE route mirroring the existing `PATCH /:id/status` pattern:

```ts
// Admin: delete an UNUSED form (no submissions). Refuses with 409 when the form
// has submission history, because submissions.form_id cascades on delete and we
// must never silently destroy submission data.
formsRouter.delete("/:id", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid form id" });
      return;
    }
    const existing = await getForm(id, req.user!.organization_id);
    if (!existing) {
      res.status(404).json({ error: "Form not found" });
      return;
    }
    const submissionCount = await countSubmissionsForForm(id);
    if (submissionCount > 0) {
      res.status(409).json({
        error: `This form has ${submissionCount} submission${submissionCount === 1 ? "" : "s"} and cannot be deleted.`,
        submission_count: submissionCount,
      });
      return;
    }
    await deleteForm(id, req.user!.organization_id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
```

**Route ordering note:** `DELETE /:id` does not conflict with the existing GET `/:id/public`
(that's a GET), and Express matches by method — so placement is safe. Keep it grouped with the
other `/:id` admin routes.

### 5.3 `server/src/swagger.ts`

Add the `delete` operation to the `/api/forms/{id}` path documenting `204`, `404`, and `409`
(with the `submission_count` field). Keep it consistent with the existing path docs.

---

## 6. Frontend changes

### 6.1 `client/src/lib/api.ts`

Add:

```ts
async deleteForm(id: number): Promise<void> {
  return request<void>(`/api/forms/${id}`, { method: "DELETE", auth: true });
},
```

(Confirm `request` already supports a `method` option and handles a 204 with no body — if it
tries to `res.json()` on an empty body it will throw. If so, either return `204` with a small
JSON body, or make `request` tolerate an empty response. **Check this first** — it's the most
likely snag.)

### 6.2 `client/src/pages/admin/AdminForms.tsx`

Add a **Delete** button per row, next to Edit / Publish:

- Style: reuse `badge-button` with a danger tint (there's already a `.icon-btn.danger`
  precedent and `--danger` fallback used elsewhere).
- **Disabled when the form has submissions** — but the list endpoint doesn't return a
  submission count today. Two options:
  - **(a) Optimistic + server-enforced (recommended, smallest change):** leave the button
    enabled; on click, confirm, call the API, and surface the 409 message if it's in use.
  - **(b) Pre-computed counts:** extend `GET /api/forms` to include a `submission_count` per
    form so the button can be disabled up front with a tooltip. Nicer UX, more surface area.

  Recommend **(a)** for the first cut, with **(b)** as a follow-up if the disabled state is
  wanted.

- **Confirmation dialog** before calling the API. The app has no shared confirm component, so
  use a small inline modal (there's a `.modal` / `.modal-overlay` pattern already) or
  `window.confirm` for the first cut. Recommended: a proper modal that names the form and
  states it can't be undone.

- On success: reload the list (`load()`), show a success message.
- On 409: show the server's message (e.g. "This form has 12 submissions and cannot be
  deleted.").
- On other errors: show a generic failure message.

---

## 7. Verification plan

1. **Unused form deletes.** Create a throwaway form (no submissions) → Delete → confirm → it
   disappears from the list; `GET /api/forms/:id` returns 404.
2. **Used form is refused.** Pick a form with submissions → Delete → expect **409** and the
   count in the message; confirm the form and all its submissions are still intact.
3. **Cascade sanity.** After deleting an unused form, confirm its `form_fields` rows are gone
   (they cascade) and that no orphan rows remain.
4. **Org scoping.** Attempt to delete a form belonging to another organization → **404**.
5. **Auth.** Call `DELETE /api/forms/:id` as a non-admin / unauthenticated → **403/401**.
6. **UI states.** Confirm dialog shows; cancel does nothing; success refreshes the list; the
   409 message renders readably.
7. `npm run typecheck` (server + client).

---

## 8. Open decisions for review

1. **Published forms** — allow deleting an unused *published* form (recommended), or require
   unpublishing first?
2. **Button state** — optimistic + server-enforced (option a, recommended) vs. pre-computed
   `submission_count` to disable the button up front (option b)?
3. **Confirmation UX** — a proper modal (recommended) or `window.confirm` for the first cut?
4. **Hard delete vs. archive** — hard delete (recommended, matches the ask) or repurpose the
   existing `archived` status as a soft delete? → **Overruled 2026-09-15 (§10): both.** Delete
   stays, Archive was added. Neither alone was sufficient.
5. **Bulk delete** — out of scope for this plan; call out if wanted later.

> Decisions **1** (unused *published* forms are deletable), **2** (settled as option **(b)** —
> pre-computed `submission_count`, not optimism) and **3** (a proper modal, not
> `window.confirm`) were all settled during implementation as recommended. Decision 4 was
> settled **against** the recommendation. See §10.

---

## 9. Files to change

| File | Change |
| --- | --- |
| `server/src/db/queries.ts` | Add `countSubmissionsForForm` + `deleteForm`. |
| `server/src/routes/forms.ts` | Add `DELETE /:id` with the zero-submissions guard. |
| `server/src/swagger.ts` | Document the delete operation (204/404/409). |
| `client/src/lib/api.ts` | Add `deleteForm(id)`. |
| `client/src/pages/admin/AdminForms.tsx` | Add the Delete button + confirm + error handling. |
| `docs/plans/delete-form.md` | This plan. |

The table above describes the first cut. §10.6 lists the files touched by the Archive/Delete
extension, and §10.4 the five form-selector surfaces the second half of the follow-up request
affected.

---

## 10. Post-implementation change — Archive is added, Delete is kept (2026-09-15)

**Asked for as:** *"Clicking "Delete" on the form does not delete it. Acutally, this should say
"Archive" and not delete. Also, when a form is "Unpublished", it should not show up in the form
selector on the dashboard."*

Two defects in one report. The first turned out to be **this plan working exactly as designed**
— which is precisely why it read as a bug.

### 10.1 Why Delete looked like it did nothing

`DELETE /api/forms/{id}` refuses any form with submission history (§4.3), and the button was
disabled up front from the `submission_count` that `GET /api/forms` already returns — that is
§6.2 option **(b)**, not the option this plan recommended. Both live forms have submissions (16
and 6), so **every** Delete button in the list was `disabled`. The tooltip explaining it only
appears on hover.

The user's instinct was the right fix: the action they actually wanted is non-destructive.
Loosening the guard instead would have cascade-deleted real submissions — see §2. So **both**
actions now exist:

| Action | Enabled when | Effect |
| --- | --- | --- |
| **Delete** | `submission_count === 0` | Hard `DELETE`. `form_fields` cascade. Irreversible. |
| **Archive** | always | `status = 'archived'`. Every submission kept. Reversible. |

Delete's tooltip now names the alternative rather than only stating the refusal:
*"In use — 16 submissions. Use Archive to retire it without losing data."*

### 10.2 `pre_archive_status` — remembering what the form was

Restoring straight to `draft` would be wrong: a form that was **published** when it was archived
should come back published, which is what makes Archive safe to point at a live form. A new
nullable `forms.pre_archive_status` column records the status held at archive time.

| Choice | Why |
| --- | --- |
| Written by archive, cleared by restore and by an explicit `status` set | It is a **bookmark, not a history** — one nullable column instead of an audit table. |
| `NULL` means "not currently archived" | The invariant, maintained in one place per writer. |
| Deliberately **not** CHECK-constrained | It is a historical record, not an active state, and its only writer (`archiveForm`) copies `status` — itself already CHECK-constrained. A constraint here would duplicate a rule that cannot be violated. |
| Legacy rows restore to **`draft`** | `COALESCE(pre_archive_status, 'draft')` — a form archived before the column existed has no remembered status, so it comes back *hidden*, never silently re-published to parents. |
| Declared in **two** places under Turso | The `CREATE TABLE` in `dialect/turso.ts` **and** the dialect's `addColumns` list, which `pool.ts` applies only when `PRAGMA table_info` lacks the column. Declaring it in one place only is the known drift trap in `dual-db.md`. SQL Server needed a single `COL_LENGTH`-guarded statement instead, since its DDL ladder is cumulative. |

### 10.3 One route, three shapes

`PATCH /api/forms/{id}/status` already existed for publish/unpublish. Rather than add two
routes, it now accepts:

| Body | Meaning |
| --- | --- |
| `{ "status": "draft" \| "published" }` | Set it explicitly. Also how an archived form is brought back to a *chosen* status; clears the marker. |
| `{ "status": "archived" }` | Retire it. Recalls the status held at that moment. |
| `{ "restore": true }` | Return it to the status it held before archiving. **409** if the form is not archived. |

Restore is an **action, not a status**, so the client never names a target status — the server
reads it from the row. The route validates against `FORM_STATUS` imported from `schema.ts`
rather than an inline array, so it cannot accept a status the database would reject. Both
queries are org-scoped and both are **idempotent** — `archiveForm` carries
`status <> 'archived'`, `restoreForm` carries `status = 'archived'` — so a double-click cannot
overwrite the bookmark with `'archived'`, which would make Restore land back on archived and
appear to do nothing.

`updateForm` is the *other* writer of `status`, so it maintains the invariant too: an edit that
moves a form out of `archived` clears the marker, otherwise a stale value would survive to
mislead a later Archive → Restore pair.

**`GET /api/forms` stays unfiltered.** Archiving must not hide a form from the management
surface, or Restore would be unreachable. Filtering belongs to the consumers, not the source.

### 10.4 The second defect: unpublished forms in the dashboard selector

The published-only filter had been **copy-pasted into five places and drifted** — two filtered,
three did not, the dashboard's own selector among the three. That divergence is what the user
saw.

There is now one definition, `selectableForms()` in `client/src/lib/forms.ts`, and all five
surfaces call it:

| Surface | Behaviour |
| --- | --- |
| `AdminDashboard.tsx` — filter select | Published only |
| `StaffQueue.tsx` — report select | Published only |
| `ReportsPage.tsx` — report select **and** the default landing | Published only; also fixes a real bug where the first entry of the **unfiltered** list — potentially a draft — was auto-selected |
| `ExportModal.tsx` — form dropdown | Published only; falls back to the first selectable form if the chosen one stops being selectable while the modal is open |
| `AdminForms.tsx` — the list itself | **Deliberately unfiltered** — it is the management surface |

Two further deliberate exceptions, both commented in place:

- `StaffQueue`'s "is there more than one form?" gate reads the **raw** list, so one published
  form sitting beside an archived one does not silently scope the queue.
- `ReportsPage`'s saved-**View** auto-apply lands on the View's stored `form_id` without
  re-checking it, because a saved View is an explicit user configuration.

The vocabulary matters here: there is no `unpublished` status. `FORM_STATUS` is
`draft | published | archived`, and the UI's "Unpublish" sets `draft`. Both `draft` and
`archived` are therefore "not published", and one helper covers both. Parents were never
affected — they go through `GET /api/forms/public`, which the server has always filtered.

### 10.5 UI

- A **Show archived (N)** toggle above the list, **off by default**, disabled at 0. Archived
  rows render at `opacity: 0.6`, badged **Archived**, sorted below the live ones.
- Row actions — live: Edit / Publish-Unpublish / Archive / Delete (disabled when in use);
  archived: Edit / **Restore** / Delete (disabled).
- **One** confirmation modal for all three verbs, branching on which was clicked. Delete keeps
  the **danger** button; Restore uses the **primary** button. Archive states its submission
  count and that the form will disappear from the dashboard, staff queue and report selectors.

### 10.6 Files touched

| File | Change |
| --- | --- |
| `server/src/db/schema.ts` | `Form.pre_archive_status`; the column in the `dbo.forms` DDL; a `COL_LENGTH`-guarded migration. |
| `server/src/db/dialect/turso.ts` | The column in `CREATE TABLE forms` **and** in `addColumns`. |
| `server/src/db/queries.ts` | `archiveForm` / `restoreForm`; `pre_archive_status` added to the `listForms` and `getForm` projections; the invariant in `updateForm`. |
| `server/src/routes/forms.ts` | `PATCH /:id/status` handles all three shapes, with 400/404/409 paths. |
| `server/src/swagger.ts` | `pre_archive_status` on the schema; the three request shapes; a cross-reference from `DELETE`. |
| `client/src/lib/forms.ts` | **New** — `selectableForms()`. |
| `client/src/types/index.ts`, `client/src/lib/api.ts` | `pre_archive_status`; `archiveForm(id)` / `restoreForm(id)`. |
| `client/src/pages/admin/AdminForms.tsx` | Archive/Restore, the Show-archived toggle, the tri-purpose modal. |
| `AdminDashboard.tsx`, `StaffQueue.tsx`, `ReportsPage.tsx`, `components/ExportModal.tsx` | Share `selectableForms`. |
| `docs/plans/feature-backlog.md` §9.11, `docs/features/swagger-ui.md` §8.3 | Registered. |

### 10.7 Verified (live dev servers, Turso, admin role)

`npx tsc --noEmit` (server) and `npx tsc -b` (client) clean; `npx vitest run` **36/36**;
`npm run build` **1910 modules**.

| Check | Result |
| --- | --- |
| Both live forms' Delete buttons | ✅ `disabled`, titles *"In use — 16 submissions. Use Archive to retire it without losing data."* / *"… 6 submissions …"* |
| Archive round trip on the **draft** form (id 1, 6 submissions) | ✅ modal copy exact; confirm button computed `rgb(22, 87, 136)` — primary, not danger; the row left the list; the toggle read **Show archived (1)**; the revealed row carried `opacity` 0.6 and the **Archived** badge |
| Restore | ✅ came back to **Draft**, the status it actually held — not a blanket fallback — with `pre_archive_status` `NULL` again and **all 6 submissions intact** |
| Dashboard, Staff Queue, Reports and Export selectors | ✅ each listed only *CDM Google Form*; the draft form was absent from all four |
| **Zero** published forms (temporarily unpublished, then reverted) | ✅ every selector collapsed to its placeholder — the Reports select held no value and nothing was auto-landed in the selector. The saved-View path in §10.4 is the one by-design exception. |
| `pre_archive_status` on the wire | ✅ `GET /api/forms` returned `published / null` and `draft / null` |

The round trip was run on the **draft** form and the database was left exactly as found. Nothing
here archives a *published* form, so no parent-facing behaviour was exercised.
