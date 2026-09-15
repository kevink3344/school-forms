# Plan — Feature Backlog & Roadmap

**Status:** Draft for review
**Date:** 2026-09-14
**Area:** Whole application
**Purpose:** A ranked, evidence-backed list of *candidate* features, so the next piece of
work can be chosen deliberately instead of by whoever asks loudest.

---

## 1. How to read this doc

This is a **backlog, not a spec.** Each item states what it is, why it matters, where the
evidence is, and roughly how big it is. Nothing here is approved or scheduled.

Nothing in this file is implemented. When an item is picked up, it should get its own plan
doc (the way `change-password.md` is structured), and this file should be updated to point
at it. Several items below already have their own plan doc — those are cross-referenced
rather than duplicated.

**Effort scale**

| Tag | Meaning |
| --- | --- |
| **S** | One sitting. One or two files, no schema change, no new route shape. |
| **M** | A focused day. Usually a new endpoint + a new panel, or a small schema addition. |
| **L** | Multi-part. New table(s), new page(s), possibly a new dependency or an external service. |

**Risk** flags items where the *cost of getting it wrong* is high — data loss, a security
hole, or a broken existing invariant. These need care, not necessarily more time.

---

## 2. Guiding principles

Before adding anything, these constraints come from how the app is actually built. A
feature that violates one of these should be reconsidered, not just estimated.

1. **Minimal dependencies.** The client ships `react`, `react-dom`, `react-router-dom`,
   `lucide-react` and nothing else. Any feature needing a charting library, a rich-text
   editor or a date-picker library is a real decision, not a detail.
2. **"What you see is what you export."** The Reports grid and its export are fed by one
   `buildReportQuery`. The new **Group by** feature is deliberately preview-only for
   exactly this reason. Anything that visually transforms the grid must state whether the
   export follows it.
3. **Every mounted API route goes in three places** — the Express router,
   `server/src/routes/inventory.ts` (`ROUTES`), and `server/src/swagger.ts` (`paths`).
   `swagger.test.ts` fails the build otherwise. Adding an endpoint is never a one-file change.
4. **One gate per feature.** This project has twice grown *two* overlapping gates for one
   feature (the `schools` menu item, then the `documents` menu item). When adding a toggle,
   check whether an equivalent one already exists.
5. **DDL must be idempotent.** `schema.ts` `DDL_STATEMENTS` runs on every boot.
6. **Staff-only data is a security boundary**, enforced by `filterColumnsForRole`
   server-side — never by hiding things in the client.
7. **The Electron browser can't render PDFs.** Unrelated to features, but it has already
   sent one investigation down a false path. See §9, item 9.6.

---

## 3. Recommended sequence

If nothing else in this doc is read, this is the argument:

| Order | Item | Why first |
| --- | --- | --- |
| 1 | **Status history / audit trail** (§5.1) | A real accountability gap in a system that drives course placement. You currently cannot answer "who changed this, and when?" |
| 2 | **Dashboard / analytics** (§5.2) | Biggest visibility win. The admin landing page is a filtered grid with a total absence of counts, trends, or "who's behind". |
| 3 | **Email notifications** (§5.3) | The research is already written (`mailjet-setup.md`), the notifier pattern already exists (`slack.ts`), and a failed document is currently *silent*. |

Those three move the app from *a good form-capture tool* to *something a district can run
and defend*. Everything after that is enlargement rather than correction.

---

## 4. The tiers at a glance

| Tier | Theme | Items | Read it if |
| --- | --- | --- | --- |
| **A** | The safety net — gaps, not extras | §5 | You are deciding what to build first. |
| **B** | Finish the CRUD | §6 | You are tired of doing things one row at a time. |
| **C** | Reach and scale | §7 | The app is going to real families, or real volume. |
| **D** | Report depth | §8 | You live in the Reports page. |
| **—** | Already diagnosed | §9 | You want something cheap to fix today. |

Tier order reflects *severity of the gap*, not size of the work. §9 is deliberately outside
the tiers because those items are defects with known causes, not undeveloped features.

---

## 5. Tier A detail

### 5.1 Submission status history / audit trail — **Effort M, Risk medium**

**Problem.** `PATCH /api/submissions/{publicId}/status` writes the new status and records
nothing else. There is no `changed_by`, no timestamp, no from→to.

**Evidence.**
- `server/src/routes/submissions.ts` — the PATCH handler updates and returns.
- Grep for `audit|history|changed_by|status_changed` across `server/src/db/` returns only
  `last_saved_by` (staff-only fields) and unrelated comment prose. **No status history exists.**
- `dbo.submissions` carries a single current `status` column.

**Why it matters.** If a School Contact marks a student's course selection **Completed** and
a parent disputes it weeks later, the app cannot say who did it, when, or what it was before.
For a district system that drives actual placement decisions, this is the largest genuine
risk in the codebase — larger than any missing feature on this list.

**Sketch.** One new table (`submission_status_history`: `submission_id`, `from_status`,
`to_status`, `changed_by`, `changed_at`), one insert in the existing PATCH, one read
endpoint, and a timeline card on the submission detail page. Extends naturally to
`submission_values` edits later, which is where the real value accrues.

**Note.** The vocabulary collision flagged in §9.5 makes this slightly more delicate than it
looks — see that item before naming anything.

---

### 5.2 Dashboard / analytics — **Effort L, Risk low**

**Problem.** `client/src/pages/admin/AdminDashboard.tsx` is a filter bar, a table, and an
export button. No counts, no trends, no coverage view.

**Evidence.** Filters are `school_id`, `form_id`, `status`, `from`, `to` — the same shape as
`listSubmissions`. The page computes nothing beyond the row list.

**What a district actually needs.**
- Completion funnel by school — submitted → in review → completed.
- **Which schools have not submitted** — the chase list. Probably the single most requested
  report in any district workflow.
- Aging / overdue submissions (time in state, which §5.1 makes possible).
- Volume trend by `school_year` — `school-year.md` already exists as a plan.

**Constraints.** Charts would mean a charting library, which cuts against principle 1. A
table-and-number first version needs no new dependency and may be sufficient; treat charts
as a separate decision.

**Depends on:** §5.1 for any "time in state" metric.

---

### 5.3 Email notifications — **Effort L, Risk low**

**Problem.** The app sends no email at all.

**Evidence.** Grep for `mailjet|sendMail|nodemailer|@sendgrid|resend` across `server/`
returns **zero hits**. The only notifier is `server/src/notify/slack.ts`.

**The work is already researched.** `docs/plans/mailjet-setup.md` is a complete, reusable,
step-by-step guide — account setup, sender verification, the `sendMail` helper, and the
Postman validation. It was written and never implemented.

**Highest-value triggers, in order.**
1. **Document generation failure.** A failed Doc is currently silent — it sits as a `Failed`
   badge until someone happens to look. This is a straight reliability win.
2. Receipt confirmation to the parent/student. `ParentConfirmation.tsx` already exists as the
   natural landing point for the link.
3. "Needs changes" / "Completed" back to the School Contact.
4. Reminder to schools that have not submitted before a deadline.

**Note.** Slack already proves the pattern (fire-and-forget after the write, never block the
request). Email is the same shape plus a vendor.

---

## 6. Tier B — finish the CRUD

Each of these is individually small and collectively removes a class of daily annoyance.

| # | Item | Effort | Missing today |
| --- | --- | --- | --- |
| 6.1 | **Delete a form** | S | `DELETE /api/forms/{id}` does not exist. **See the warning below.** |
| ~~6.2~~ | ~~**Deactivate a user**~~ | — | **CLOSED 2026-09-15.** The claim below was **stale**: Settings → Users → row → **Active** toggle has existed since the Organizations/Users work, and the grid renders an `Active` / `Inactive` badge. Same for **Show user on test screen** and, as of today, **Reset password** (`password-recovery.md`). |
| 6.3 | **Edit / delete a school** | M | `/api/schools` has `GET`, `GET /columns`, `GET /page`, `POST`, `POST /import` only. No update, no delete. |
| 6.4 | **Delete a submission** | S | No `DELETE /api/submissions/{publicId}`. Everyone eventually needs to remove a test row. |

**⚠️ 6.1 is the trap in this whole document.** `dbo.submissions.form_id` is declared
`ON DELETE CASCADE`. A naive `DELETE FROM dbo.forms WHERE id=@id` would **silently destroy
every submission for that form** — then every `submission_values`, `comments`,
`adhoc_fields` and `documents` row beneath it. There is no undo and no soft-delete.

`docs/plans/delete-form.md` already specifies the guard: **a form is deletable only when it
has zero submissions**, counted server-side. That guard is mandatory, not cosmetic. Do not
implement 6.1 without reading that plan.

**Note on 6.3:** schools are referenced by users, submissions and documents. Deleting one is
not symmetric with deleting a form; it likely needs the same "orphans nothing" guard, or
should be deactivate-only.

---

## 7. Tier C — reach and scale

### 7.1 Spanish translation of the parent-facing pages — **Effort M, Risk low**

The parent form and confirmation are the only pages *actual families* see. For a WCPSS
deployment this is an equity need, not a polish item — and on this list it is arguably the
highest user-facing impact per unit of effort.

**Scope note.** The admin/staff UI does not need translating; the parent flow does. That
narrows it considerably. The main decision is mechanism (a small `t()` helper and a
dictionary vs. a library) — a dictionary keeps principle 1 intact.

### 7.2 Free-text search — **Effort M, Risk low**

**Evidence.** `listSubmissions` accepts `school_id`, `form_id`, `status`, `from`, `to` — and
nothing else. There is no way to find a student by name or ID without exporting to CSV.

This is the most-felt missing filter once a district passes a few hundred submissions.

### 7.3 Bulk operations — **Effort M, Risk medium**

Every action in the admin grid is one row at a time. Bulk status change, bulk export, bulk
document generation.

**Interesting side effect:** the Reports grid used to render a **disabled placeholder
checkbox column** for exactly this, which was removed as dead UI. Bulk operations would give
that affordance a real purpose — and row selection would then need to survive the new
**Group by** view, which is a genuine design question, not a detail.

### 7.4 Data-driven roles — **Effort L, Risk medium**

Roles are hard-coded in ~12 places across server and client. `docs/plans/access-groups.md`
already enumerates every touchpoint.

Today, adding a `counselor`, `nurse` or `registrar` means editing all of them by hand — and a
miss means either a broken login or a **silent security hole**. The plan proposes making
`ROLES` data-driven.

**Judgement:** worth doing *before* the fourth role is actually needed, because the cost of
the manual change rises with every new role-check added in the meantime.

### 7.5 Form open / close windows — **Effort M, Risk low**

`PATCH /api/forms/{id}/status` controls publish state (`draft`/`published`/`archived`) but
there is no start or end date. A deadline that closes a form automatically is the natural
complement to the email reminder in §5.3.

### 7.6 Duplicate submission detection — **Effort M, Risk medium**

Nothing prevents the same student submitting twice against one form. Detection could be a
warning at submit time or a flag in the admin grid. Risk is medium because a false positive
that blocks a legitimate submission is worse than the duplicate.

---

## 8. Tier D — report depth

The Reports feature is the most developed part of the app, so these are refinements.

| # | Item | Effort | Note |
| --- | --- | --- | --- |
| 8.1 | **Group by multiple columns** | M | Grouping is currently single-column. Nested groups are a bigger design change than they look. |
| 8.2 | **Subtotal / total rows** | M | Nothing aggregates today. Pairs naturally with grouping. |
| 8.3 | **Shared saved views** | S | **`dbo.report_views.user_id` is `NOT NULL`** and the unique index is `(user_id, name)` — so views are strictly personal. `organization_id` exists but is nullable and unused. Sharing is a real gap and the column is already there. |
| 8.4 | **Scheduled / emailed exports** | L | Depends on §5.3. |
| 8.5 | **Save Group by into a saved view** | S | Grouping is intentionally reset on form/view change. Persisting it needs a `filters`-style JSON field, which `report_views` already supports. |

**8.5 is a direct follow-on from the Group by feature just built** — worth flagging as the
most likely "wait, why did that reset?" question.

---

## 9. Already diagnosed — quick wins, cheap and concrete

These are not new features. They are defects or hygiene items that have been identified and
are waiting on a decision. They are the cheapest items in this document.

| # | Item | Effort | Detail |
| --- | --- | --- | --- |
| 9.1 | `/api/export/csv` **ignores the column selection** | S | It never reads a `columns` param, so the Submissions export drawer's ticks change the preview but not the file. `/api/reports/export` *does* honour `columns`. Fixing this also removes the now-dead `api.exportCsv` in `client/src/lib/api.ts`. |
| 9.2 | **Google Doc ID leaks** to roles with Documents disabled | S | `getSubmissionDetail` (`server/src/db/queries.ts`) returns `documents[]` unconditionally, and `GET /api/submissions/{publicId}/documents` is gated by role + school ownership but **not** `documentsEnabled`. The client hides it; the REST layer does not. |
| 9.3 | PDF letterhead prints the **raw status value** | S | `buildSubtitle` (`server/src/routes/reports.ts:131`) → `Status: completed`. Needs a label map. |
| 9.4 | **Changing a password does not sign out other sessions** | M | JWTs are stateless and `dbo.users` has no `token_version`. Deliberately deferred in `change-password.md` §8, and deferred again for the admin reset in `password-recovery.md` §8. Requires a schema column — do not "fix" without it. Note the reset dialog now **says so explicitly** instead of claiming an instant sign-out. |
| 9.5 | **`DOCUMENT_STATUS` vocabulary collision** | — | `"Completed"` already means *document generation finished*, while `SUBMISSION_STATUS` now also has `"completed"`. Two unrelated meanings, one word. Relevant to §5.1 and §9.3; worth settling the naming before building on top of either. |
| 9.6 | **PDF preview does not render in the VS Code browser** | — | **Not a bug.** VS Code's integrated browser is Electron and does not bundle Chrome's PDF viewer. Verified correct in real Chrome. Fixing it for VS Code would require a JS renderer (pdf.js) — a real dependency. Decision needed: accept, or bundle pdf.js. |
| 9.7 | `.env.example` has real-looking `DB_SERVER`/`DB_USER` | S | No password present. Hygiene only. |
| ~~9.8~~ | ~~`docs/plans/view-designer.md` is an **empty file**~~ | — | **CLOSED 2026-09-15.** [view-designer.md](./view-designer.md) is now a full plan (644 lines) and its first phase has been **implemented**: the per-form column chooser on the Submissions dashboard, the frozen first column, staff-only columns pinned last, and inline editing of staff-only cells. See also §5.1 and the `configured` flag in `docs/features/swagger-ui.md` §4.4. **Extended 2026-09-16** to all roles — see the row below. |
| ~~9.9~~ | ~~The column chooser worked only for admins~~ | — | **CLOSED 2026-09-16.** Reported as *"I do not see the COLUMNS for staff or school contacts. This feature should be for all."* Three causes: `/staff` was a separate page with its own table, both `/api/forms/{id}/columns` routes were `admin`-only, and the store was per-form shared. Fixed by opening the routes to `staff`/`cdm_contact`, moving the store to per-user `user_form_view_columns`, and rebuilding the staff queue on the shared `SubmissionsGrid` + `useSubmissionGrid` + `ColumnsDrawer`. Full write-up in [view-designer.md](./view-designer.md) §9. |
| ~~9.10~~ | ~~Only the form's *fields* were removable; the standard columns were fixed~~ | — | **CLOSED 2026-09-16.** Reported as *"Except the first column, all columns should be removable. when you click on 'Columns'"*. Submission ID, Status, Submitted and Actions left the fixed set and joined `ColumnsPicker` as ordinary rows; only **Student / School** is locked (it names the row, links to the submission and is the frozen column). What the user turned off is stored as a `hidden` list beside the field ids — which is why nothing needed migrating and why a standard column added later defaults to visible. Full write-up in [view-designer.md](./view-designer.md) §11. |
| 9.12 | **Self-registration lets the caller choose any `school_id`** | S | `registerSchema` accepts `school_id: z.number().int().positive()` and `POST /api/auth/register` passes it straight into `createUser` with **no check that the caller belongs to that school** — the caller is anonymous and the school list is published by `GET /api/auth/schools`. The org *is* pinned server-side (`DEFAULT_ORG_REGISTRATION`) and the role is forced to `staff`, so this is not a tenant escape — but a self-registered account can claim to be staff at **any school in the district**, and school ownership is what scopes staff visibility of submissions. Worth either closing registration, or requiring an admin to approve/assign the school. Found while reviewing the reset feature's tenant guard (which does check org). |
| 9.13 | **The login page shows "No users available" when its fetch fails** | S | No retry, no error message, and the brand stats silently render `—`. A transient failure (e.g. the server restarting under `tsx watch`) is indistinguishable from an empty organization. Cost an hour of chasing a phantom bug on 2026-09-15 — the dropdown was fine on a fresh load. Low priority, but the failure mode is misleading. |
| ~~9.11~~ | ~~Clicking "Delete" on a form does nothing, and unpublished forms still appear in the dashboard's form selector~~ | — | **CLOSED 2026-09-15.** Reported as *"Clicking "Delete" on the form does not delete it. Acutally, this should say "Archive" and not delete. Also, when a form is "Unpublished", it should not show up in the form selector on the dashboard."* Two causes. **(1)** `DELETE /api/forms/{id}` refuses any form with submissions **and** the button was pre-disabled from `submission_count` — so with both live forms in use (16 and 6 submissions) every Delete read as broken. That was [delete-form.md](./delete-form.md)'s own guard working as designed, which is exactly why it looked like a bug. Fixed by keeping Delete for unused forms and adding **Archive** beside it — `PATCH /api/forms/{id}/status` with `{"status":"archived"}` / `{"restore":true}`, backed by a new `forms.pre_archive_status` bookmark so Restore returns a form to the status it *held* rather than blindly to `draft`. **(2)** The published-only filter had been copy-pasted into **five** form selectors and drifted — two filtered, three did not, the dashboard among them. All five now call one `selectableForms()` helper (`client/src/lib/forms.ts`); `AdminForms.tsx` stays deliberately unfiltered so Restore remains reachable. Full write-up in [delete-form.md](./delete-form.md) §10 and [swagger-ui.md](../features/swagger-ui.md) §8.3. |

---

## 10. Already drafted, never built

Plan docs that exist and are waiting:

| Doc | Status | Note |
| --- | --- | --- |
| `docs/plans/password-recovery.md` | **Implemented** | **Written and built 2026-09-15.** Admin-issued temporary password + `must_change_password` forced change. Closes the "no password recovery path exists at all" gap that `change-password.md` §2 and §10 both recorded. Self-service **forgot password** (email + signed single-use token) is the deferred half — see §12.8. |
| `docs/plans/delete-form.md` | **Implemented** | See §9.11. Shipped as planned, then **Archive** and **Restore** were added beside Delete and the five form selectors were unified on one helper. §4.5's "hard delete only" recommendation was **overruled**. The §6.1 cascade warning is still the point of the doc. |
| `docs/plans/access-groups.md` | Draft for review | See §7.4. |
| `docs/plans/organization-drive-folder.md` | Draft for review | Per-org `GOOGLE_DOC_FOLDER_ID`; today it is one global env value. Matters once there is more than one org. |
| `docs/plans/mailjet-setup.md` | Reusable guide | See §5.3. |
| `docs/plans/school-year.md` | — | Feeds §5.2. |
| `docs/plans/view-designer.md` | **Implemented** | See §9.8 and §9.9. Dashboard column chooser, frozen first column, staff-only inline editing — for **every role** since 2026-09-16. `submission-view.md` decisions 1 and 3 were superseded by it. |

---

## 11. Deliberately out of scope

Recording these so they are not re-proposed:

- **Real-time collaboration / presence.** No business need for a district submission form.
- **Native mobile app.** The parent flow is a web form; the responsive work is already done.
- **Approval workflows with multiple sequential reviewers.** Speculative — no requested
  chain exists. Revisit if §5.1 shows a real multi-step pattern in the status transitions.
- **A charting library.** Not rejected, but it is a principle-1 decision and should be made
  explicitly rather than as a side effect of §5.2.
- **Redesigning the existing Reports grid or Submissions grid.** Both work; change would be
  churn.

---

## 12. Decisions needed from you

Reviewing this doc means answering these. Nothing proceeds until then.

1. **Which tier first?** The recommendation is §3 (status history → dashboard → email).
2. **Charts or numbers?** Does the dashboard need graphs (§5.2), which means a new client
   dependency, or are tables and counts enough for v1?
3. **Email vendor.** Mailjet is researched and fits the free tier (6,000/month, 200/day). Is
   that the choice, or is there an institutional SMTP/Exchange route WCPSS would prefer?
4. **Is Spanish in scope for v1?** If it is a requirement rather than a nice-to-have, it
   changes the ordering in §3 considerably.
5. **§9.6 — accept the Electron PDF limitation**, or bundle `pdf.js` and take the dependency?
6. **§9.5 — settle the `Completed` vocabulary collision** before §5.1 and §9.3 build on it.
7. **§6.1 / §6.3 — should schools be deletable at all**, or deactivate-only? Forms are
   constrained by the cascade; schools are referenced by users, submissions *and* documents.
8. **Password recovery — is admin-issued enough?** Admin reset now exists
   (`password-recovery.md`), so nothing is permanently unrecoverable. The remaining question is
   whether a user should be able to recover **without** an admin: that is the "Forgot password?"
   flow, and it is gated on §5.3 (an email vendor) — there is still no mail transport in the app,
   so it cannot be built before that decision is made.
9. **§9.12 — should self-registration stay open**, and if so should the caller still pick their own
   `school_id`? This is the only place an anonymous request can choose data that scopes what a
   role later sees.

---

## 13. Change log

| Date | Change |
| --- | --- |
| 2026-09-14 | Initial backlog. Written after the Reports Group by feature; supersedes the informal list previously held in conversation. |
| 2026-09-15 | **Password recovery shipped** — admin-issued temporary password + forced change. Added to §10 as implemented; §9.4 extended to cover it; §12.8 added (is admin-issued recovery enough, and is it blocked on §5.3?). |
| 2026-09-15 | **§6.2 closed** — "deactivate a user" claimed no UI existed; the Active toggle has been there for a while. |
| 2026-09-15 | Added **§9.12** (self-registration lets the caller pick any `school_id`) and **§9.13** (the login page's silent empty Test User dropdown on a failed fetch), both found while building password recovery. |
