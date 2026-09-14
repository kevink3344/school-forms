# Plan — Delete an Unused Form

**Status:** Draft for review
**Date:** 2026-09-13
**Area:** Admin → Forms (`/admin/forms`)

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
   existing `archived` status as a soft delete?
5. **Bulk delete** — out of scope for this plan; call out if wanted later.

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
