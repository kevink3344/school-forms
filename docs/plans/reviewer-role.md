# Plan — Reviewer role (a fourth system role)

**Status:** ⏸️ **Superseded by [`roles-settings.md`](./roles-settings.md)** — the user asked for admin-authored roles
(`"admins can add roles"`), which makes Reviewer **seeded data** rather than a code edit. This
document is retained because its census is the *evidence* the new plan rests on, not because the
approach is still live.
**Date:** 2026-09-30
**Area:** Roles / Access control
**Supersedes:** [`user-roles.md`](./user-roles.md) for the immediate need — per-form role scoping is **deferred**, not rejected (see §10.2)
**Recommended first:** [`access-groups.md`](./access-groups.md) §4 — the duplicated-role-list refactor (see §7 P1)
**§5's S1–S7 confirmed still live 2026-10-01** — see [`staff-only-field-access-toggles.md`](./staff-only-field-access-toggles.md) §6: S1/S2 are a **redirect cycle** at sign-in, and §4.1's read routes still refuse `reviewer` with a 403 because the capability guards are defined but unwired.

> **What survives into [`roles-settings.md`](./roles-settings.md):**
> - **§4's route split** — the 11 read sites vs 10 write sites *is* the capability map (§4.3 there).
> - **§5's silent-gate catalogue (S1–S7)** — these stop being Reviewer-specific problems and
>   become the general reason a hard-coded client role list cannot be half-migrated.
> - **The measurement tables in §3 and §4** — unchanged, and cited there.
>
> **What is dropped:** the premise that the fix is *editing route lists and client constants*.
> Under `roles-settings.md`, capability comes from a `dbo.roles` row and the route guards read it,
> so **R4** ("something completes the list and grants a write path") — the single most dangerous
> risk in this document — has no list left to complete. That is the whole argument for paying for
> runtime capabilities instead of a fourth constant.

---

## 1. What was asked

> "Would it be easier to add System Roles only, instead of roles per form? For example:
> Admin, Staff, School Contact, Reviewer. This way admins can control the roles and it's a lot
> easier."

Yes, and by a wide margin. This plan adds **one more value to the existing role set** — there is
no new table, no new token claim, and no new enforcement primitive. That is the whole reason it
is the right shape for now.

---

## 2. Decisions taken (2026-09-30)

| # | Question | Decision |
| --- | --- | --- |
| **D1** | Is a role the same everywhere in the org? | **Yes.** No per-form scoping. |
| **D2** | Can one person hold two roles? | **No.** `users.role` stays single-valued — a person is a Reviewer **or** Staff, not both. |
| **D3** | Who assigns it? | **An admin**, from Settings → Users, exactly as the existing three are assigned. |
| **D4** | What may a Reviewer do? | **✅ Confirmed 2026-09-30: read + export + report, no writes** — and confirmed as a **seeded built-in**, not an admin-authored role (`roles-settings.md` §13 Q2). See §4. |

### Why D4 is the load-bearing assumption

**✅ D4 is confirmed** (2026-09-30). The analysis below is retained because it is the *rationale* for the
seeded row's `can_view=1, can_edit=0` — `roles-settings.md` §3.5 is what makes seeding the only way to
deliver it, so this section is evidence for that plan rather than an open question in this one.

There are three existing roles and each has a distinct job:

| Role | Scope | Can write? | Can administer? |
| --- | --- | --- | --- |
| `admin` | whole org | yes | **yes** |
| `staff` | whole org | yes | no |
| `cdm_contact` | **own school** | yes | no |
| `reviewer` *(proposed)* | whole org | **no** | no |

If `reviewer` could write, it would be **`staff` under a second name** — org-wide, full write,
no administration. A fourth role that duplicates an existing one earns nothing, so the only
definition that adds value is **read-only + export + report**. That also matches the original
phrasing that started this thread ("School Reviewer, **Report Viewer**").

**If D4 is wrong** — if a Reviewer must edit submissions — then Reviewer really is a synonym for
`staff` and the honest move is not to add a role at all. Confirm before implementing.

---

## 3. Why this is much smaller — the measurement

Measured on 2026-09-30, not estimated.

| | **Reviewer as a system role** | **Per-form roles** (`user-roles.md`) |
| --- | --- | --- |
| New tables | **0** | 3 |
| DDL statements | **2 `CHECK` edits** (both have a template) | 3 tables + indexes × **both** dialects |
| Files holding a hard-coded role list | ~13, most a one-liner | ~13 **plus** all the new machinery |
| Files branching on `role === "…"` | ~8 (each needs a decision) | ~8 |
| Route guards | add `"reviewer"` to the sites that admit it | same decision, new primitive |
| Token change | **none** — `users.role` *is* the claim | new `roles[]` claim |
| Field-level access | **works with no change** | explicitly out of scope |
| Message audiences / `documents_link` / `menu_items` | **works with no change** | out of scope |
| Same access on different forms? | no | yes |
| One person, two roles? | **no** | yes |
| Phases | **2** | 6 |

### 3.1 The surprising part: several features improve *for free*

`ROLES` (in `server/src/db/schema.ts` L4) is already the **single derivation source** for four
separate features. Adding a member flows into all four with no edit:

| Feature | Derives from `ROLES` at | Effect of adding `reviewer` |
| --- | --- | --- |
| Field-level access defaults | `schema.ts` L142 `fieldAccessRoles()` → `[...ROLES]` | an unset `staff_only` field admits Reviewers |
| `menu_items` defaults | `routes/settings.ts` L70 `out[k] = [...ROLES]` | Forms / Reports menus visible by default |
| `documents_link` default | `routes/settings.ts` L58 `[...ROLES]` | Documents menu visible by default |
| User create/update payloads | `schemas.ts` L70, L84 `z.enum(ROLES)` | Reviewer is an acceptable `role` value |

This is the axis on which the simple design is **strictly more capable** than the per-form one:
per-form custom roles have to be kept *out* of field-level access (`user-roles.md` §11.2),
because a key-based match in that hot path would be a second, silently-diverging copy of the
rule. A system role has no such problem — it is a member of the one list everything reads.

### 3.2 The widening migration is copy-paste, not design

`schema.ts` L647-666 already widens the `users.role` `CHECK` for `cdm_contact`: find any CHECK
naming `role` + `admin` but not the new key, drop it, re-add with the full set. Widening a CHECK
is **additive** — no existing row is invalidated, so there is **no backfill**. §6.

---

## 4. What a Reviewer can do, route by route

The 21 `requireRoles(...)` call sites that name all three staff-ish roles split cleanly in two.
**Every decision is visible in the route table below** — nothing else changes.

### 4.1 Read sites — gain `reviewer` (11 call sites + 1 constant)

| File | Line | Route | Why |
| --- | --- | --- | --- |
| `routes/forms.ts` | 81 | `GET /` | the forms list drives the whole staff UI |
| `routes/forms.ts` | 371 | `GET /:id/columns` | column visibility for the grid |
| `routes/submissions.ts` | 136 | `GET /` | the queue |
| `routes/submissions.ts` | 170 | `GET /archive/counts` | the archive tab's badge |
| `routes/submissions.ts` | 181 | `GET /:publicId` | the detail page |
| `routes/submissions.ts` | 411 | `GET /:publicId/documents` | attached documents (read) |
| `routes/submissions.ts` | 432 | `GET /:publicId/adhoc` | ad-hoc fields (read) |
| `routes/export.ts` | 25 | `GET /preview` | preview grid |
| `routes/export.ts` | 81 | `GET /csv` | export *(D4: "Report Viewer")* |
| `routes/documents.ts` | 47 | `GET /` | documents list |
| `routes/documents.ts` | 172 | `GET /:id/pdf` | the PDF viewer |
| `routes/reports.ts` | 40 | `REPORT_ROLES` const | every reports route |

### 4.2 Write sites — **do not** gain `reviewer` (10 call sites)

| File | Line | Route |
| --- | --- | --- |
| `routes/submissions.ts` | 202 | `PATCH /:publicId/status` |
| `routes/submissions.ts` | 250 | `POST /:publicId/archive` |
| `routes/submissions.ts` | 287 | `POST /:publicId/restore` |
| `routes/submissions.ts` | 375 | `PUT /:publicId/values` |
| `routes/submissions.ts` | 453 | `POST /:publicId/adhoc` |
| `routes/submissions.ts` | 489 | `PUT /:publicId/adhoc/:fieldId` |
| `routes/submissions.ts` | 526 | `DELETE /:publicId/adhoc/:fieldId` |
| `routes/forms.ts` | 391 | `PUT /:id/columns` |
| `routes/documents.ts` | 62 | `POST /:id/retry` |
| `routes/documents.ts` | 103 | `POST /:id/regenerate` |

11 + 10 = 21 = every site that names the staff trio. **Left alone:** `submissions DELETE
/:publicId` (admin-only), `forms GET /:id` + all of `POST`/`PUT`/`DELETE` on forms, and every
route under `users` / `schools` / `settings` / `organizations` / `systemMessages` /
`webhookEvents`.

### 4.3 An existing test already guards this split

`server/src/db/submissions-archive.test.ts` L580-595 pins the archive/restore guard **verbatim**:

```ts
expect(line).toContain('requireRoles("staff", "cdm_contact", "admin")');
```

with a message explaining that *adding* a role there "a role that should not see other schools'
rows gained a write path". Under D4 this test **must not be edited** — leave it, and it becomes
the evidence that Reviewer is genuinely read-only rather than merely intended to be. If the
implementation has to change this test to pass, D4 has been violated.

---

## 5. ★ The gates — one is a compile error, seven are silent

This is the section to read twice. The role keys are stored in **four** file formats and
matched in **~8 branches**, and TypeScript catches almost none of it.

### 5.1 Compiler-protected (1)

| File | Site | Behaviour if omitted |
| --- | --- | --- |
| `client/src/lib/settings.ts` | L15 `ROLE_AUDIENCE_LABELS: Record<Role, string>` | **`tsc --noEmit` fails** — exhaustive map |

That is the *only* site that cannot silently rot.

### 5.2 Silent (7) — no error, no warning, wrong behaviour

| # | File | Site | What happens if `reviewer` is missed | Sev |
| --- | --- | --- | --- | --- |
| **S1** | `client/src/pages/HomeRedirect.tsx` | L7 | `reviewer` matches no branch → redirected to `/login` **while authenticated** → login page sends it back → **the role cannot sign in at all** | 🔴 |
| **S2** | `client/src/components/layout.tsx` | L323 | the entire staff nav block is gated on `staff \|\| cdm_contact` → **sidebar is empty**; the pages exist and are reachable by URL only | 🔴 |
| **S3** | `client/src/pages/admin/AdminSettings.tsx` | L1726 | `<option value="…">` list → **the role cannot be assigned to anyone** | 🔴 |
| **S4** | `client/src/pages/admin/AdminSettings.tsx` | L47 `roleBadge()` | if-chain with a `return {cls:"badge-blue", label:"Staff"}` fallback → a Reviewer is rendered **as "Staff"**, in the wrong badge colour | 🟠 |
| **S5** | `server/src/routes/settings.ts` | L93 `parseMenuItems()` | `ROLES.filter(r => v.includes(r))` — an **already-stored** `menu_items` value (written before Reviewer existed) filters Reviewer out → Forms/Reports hidden. Note the *default* (key absent) includes it, so behaviour differs between "never configured" and "configured earlier" | 🟠 |
| **S6** | `client/src/pages/admin/AdminFormDesigner.tsx` | L26 `roleLabel()` | falls back to the raw string → the field-access chip reads `reviewer`, not `Reviewer` | 🟡 |
| **S7** | `client/src/pages/LoginPage.tsx` | L353 | the demo-account line reads `reviewer` | 🟡 |

**S1 and S2 together are the headline risk.** Both are enumerated comparisons with a fallback,
so the failure is *nothing renders* — no exception, no 403, no log line. This is the same shape
as the `Role` union having a second, hand-written copy in `settings.ts` and `AdminFormDesigner.tsx`,
and it is the concrete argument for §7 P1.

### 5.3 Already correct, and must be *left* correct

These enumerate roles too, and for a read-only Reviewer the existing expression already yields
the right answer — **do not "fix" them by adding `reviewer`**:

| File | Site | Expression | For `reviewer` |
| --- | --- | --- | --- |
| `server/src/auth.ts` | L167 `isSchoolScoped()` | `role === "cdm_contact"` | `false` → **org-wide**, which D1 wants. **No change needed.** |
| `client/src/pages/staff/StaffSubmissionDetail.tsx` | L40 | `admin \|\| staff \|\| cdm_contact` | `false` → **no write affordances**. Correct — add a comment saying so. |
| `client/src/pages/reports/ReportsPage.tsx` | L105 | `role === "cdm_contact"` | `false` → org-wide view |
| `client/src/pages/staff/StaffDocuments.tsx` | L26 | `role === "cdm_contact"` | `false` → org-wide view |
| `client/src/pages/staff/StaffQueue.tsx` | L195 | `role === "cdm_contact"` | `false` → org-wide view |

Each one is *accidentally* right. That is worth a one-line comment apiece, or the next person
adding a role will "complete the list" and silently give Reviewers a write path.

### 5.4 Verified automatically (no action)

`system-messages.test.ts` asserts `messageAudienceRoles(null)` equals `[...ROLES]` — it spreads
the constant, so it adapts on its own. Likewise `fieldAccessRoles()`. Neither needs editing;
both will keep passing, which is the point.

---

## 6. DDL

### 6.1 SQL Server — `server/src/db/schema.ts`

Three edits, all in one place:

1. **L4** — `export const ROLES = ["admin", "staff", "cdm_contact", "reviewer"] as const;`
   The `Role` type (L23) derives from it, so it updates itself.
2. **L609** — the `CREATE TABLE dbo.users` CHECK, for brand-new databases.
3. **L647-666** — copy the `cdm_contact` widening block, changing the sentinel from
   `NOT LIKE '%cdm_contact%'` to `NOT LIKE '%reviewer%'` and the re-added list to all four.
   **Do not edit the existing block** — it is already applied on production, and rewriting an
   applied migration is how a ladder stops being idempotent.

The new block must go **after** the `cdm_contact` one (the ladder is ordered) and needs no extra
batch split, since it references no newly added column.

### 6.2 libSQL / Turso — `server/src/db/dialect/turso.ts` L77

`role TEXT NOT NULL CHECK (role IN ('admin','staff','cdm_contact'))` → add `'reviewer'`.

**⚠️ This only affects databases created after the change.** The Turso dialect ports none of the
ladder (`schema.ts` L359-364), and **SQLite cannot drop or alter a `CHECK` constraint** — it
requires a full 12-step table rebuild. So on an existing Turso deployment this role cannot be
inserted at all.

The active mode is `DB_MODE=sqlserver`, so this is *know it before you need it*, not a blocker.
Options when it matters: a table-rebuild migration, or accept that Turso environments created
before the change need recreating. **Do not discover this by getting a `CHECK constraint failed`
on a Turso box.**

### 6.3 No backfill, no data change

Nobody holds `reviewer` on the day this ships, so there is nothing to migrate. Existing users
keep their role. Existing forms are untouched.

---

## 7. Phasing

| Phase | Content | Risk |
| --- | --- | --- |
| **P1** *(recommended first)* | [`access-groups.md`](./access-groups.md) §4 — one `ROLE_DEFS` descriptor, `GET /api/roles`, client fetches it instead of re-declaring. | Low — behaviour-preserving; verified by a diff probe |
| **P2** | Add `reviewer`: constants, the two CHECKs, the route lists of §4, and the UI sites of §5. | Medium — S1/S2 are silent |

**Why P1 first.** P1 and P2 edit *the same 13 files*. Doing P1 first means P2 becomes a
handful of edits in one descriptor instead of 13 files, and — more importantly — **deletes
class S1/S2/S5 failures outright**, because there is no second list left to forget. Doing it in
the other order means paying for the duplicate list twice.

**Why you can skip P1.** If the role is needed this week, P2 alone ships it. P1 is an
amortisation play for role #5, not a prerequisite. Say which you want; the plan works either way.

**P1 is also the prerequisite for `user-roles.md`**, so choosing it now keeps that door open at
no extra cost.

---

## 8. Risks

| # | Risk | Why it bites | Mitigation |
| --- | --- | --- | --- |
| **R1** | D4 is wrong — a Reviewer is meant to edit | The role ships read-only and the users it was built for cannot do their job | **✅ Closed 2026-09-30 — D4 confirmed read-only as a seeded built-in.** §10.3 assertion 4 remains the check |
| **R2** | S1 — an authenticated Reviewer cannot sign in | Redirect loop; looks like an auth bug, is a missing list entry | In the P2 checklist; §10.4 asserts a Reviewer reaches a rendered page |
| **R3** | S2 — empty sidebar | App is "broken" with no error anywhere | Same |
| **R4** | Something "completes the list" in §5.3 and grants a write path | Reviewer silently gains archive/restore; no test fails | Existing pin at `submissions-archive.test.ts` L595 **must stay green**; comments in §5.3 |
| **R5** | S5 — `menu_items` already stored on production | Reviewer sees an empty nav if the stored value predates it, because S5 filters it out | Audit the stored `app_settings.menu_items` value; either re-save it or document. **⚠️ Corrected:** this read *"per org"* — `dbo.app_settings` is `PRIMARY KEY ([key])` with **no organization column** (`db/schema.ts` L971-976) and `getSetting(key)` selects on `[key]` alone (`db/queries.ts` L194-201), so `menu_items` is **one row for the whole installation**, not one per org |
| **R6** | The CHECK migration is placed before the `cdm_contact` block | Two migrations racing to drop the same auto-named constraint | Append after it; the guards are ordered |
| **R7** | A Turso environment is expected to gain the role | `CHECK constraint failed` at insert, with no obvious remedy (§6.2) | Documented; active mode is SQL Server |
| **R8** | `reviewer` is added to `z.enum(ROLES)` and self-registration silently offers it | Anyone can sign up as a Reviewer | It cannot — `routes/auth.ts` L137 hard-codes `cdm_contact`. **But see §9 — `ALLOWED_ROLES` suggests otherwise and is wrong.** |

---

## 9. Found while measuring: `ALLOWED_ROLES` is documented but dead

Not part of this feature, but it is a role-configuration decoy that this plan's reader will
trip over, so it is recorded here rather than silently passed.

| Source | Claim |
| --- | --- |
| `.env` L47 | `ALLOWED_ROLES=admin,staff` |
| `.env.example` L103 | `ALLOWED_ROLES=admin,staff` |
| `docs/plans/access-groups.md` L52 (row 13) | "Roles allowed to self-register" |
| `server/src/config/env.ts` L116 | parsed into `config.auth.allowedRoles` |

Measured: **no code in `server/src` reads `config.auth.allowedRoles`** (grep for `allowedRoles`
returns exactly one hit — the definition). And the documented value **contradicts what
registration does**: `routes/auth.ts` L137 hard-codes `createUser(..., "cdm_contact", ...)`, so
self-registration creates a School Contact — a role that is *not* in `admin,staff`.

So this variable is (a) unused and (b) describes the opposite of the real behaviour. Two
consequences for this plan:

- **Do not add `reviewer` to it.** It would look like it had an effect. It would not.
- It is a candidate for deletion (or a comment marking it dead) in a separate change — doing it
  inside this one would mix an unrelated cleanup into a security-adjacent diff.

If `git log -S "allowedRoles"` shows a commit that once read it, the honest description is
"stopped being read at some point" rather than "never worked" — worth settling before writing
any comment about it.

---

## 10. Verification

### 10.1 Static (all must be clean)

`server npm run typecheck` · `server npx vitest run` · `client npx tsc --noEmit` ·
`client npm run build` · `get_errors` on every touched file.

**A green `vitest` run is not sufficient evidence for this change**: `submissions-archive.test.ts`
L595 and `system-messages.test.ts` both assert against `ROLES` by spreading it, so they pass
whether or not `reviewer` was added correctly to anything else.

### 10.2 The route-diff probe — P1's safety argument, and P2's

A throwaway `server/tmp-role-probe.ts` (a file, **never** `npx tsx -e`, which eats backticks in
template-literal SQL) that, for each of `admin` / `staff` / `cdm_contact`, records the HTTP
status of every route in §4.1 and §4.2 and diffs before vs after.

- For **P1**: every status must be **identical** — the refactor is behaviour-preserving, and
  this is what proves it.
- For **P2**: the only permitted differences are the **read** routes of §4.1, and only for a
  `reviewer` token. Any change in an existing role's status is a bug.

The probe must include **controls that are guaranteed to fail** (a deliberate syntax error, and a
request to a route that does not exist) — otherwise a table of all-PASS results cannot be
distinguished from a harness that is not running.

### 10.3 Live assertions

| # | Assertion |
| --- | --- |
| 1 | `admin`, `staff`, `cdm_contact` each get **byte-identical** statuses to pre-change on every route (§10.2) |
| 2 | A `reviewer` token: **200** on every route in §4.1 |
| 3 | A `reviewer` token: **403** on every route in §4.2 — asserted per route, **not** as a count |
| 4 | A `reviewer` token on `PATCH /:publicId/status` and `PUT /:publicId/values` → 403 *(this is D4, and it is the check that proves the role is not just `staff` renamed)* |
| 5 | An admin can set a user's role to `reviewer` via `PUT /api/users/:id` → 200 |
| 6 | A `reviewer` token on every admin route (`/api/users`, `/api/schools`, `/api/settings`, `POST /api/forms`) → **403** |
| 7 | A `reviewer` token is **org-wide**: it sees submissions from more than one school in its org (contrast a `cdm_contact`, narrowed to one) |
| 8 | `GET /api/forms` for a `reviewer` returns the same form set as for `staff` |
| 9 | A `cdm_contact` is still narrowed to one school after the change — the `isSchoolScoped` regression |

Assertion 3's "per route, not as a count" matters: a count of 403s cannot tell "every write
route refused" from "one route refused ten times".

### 10.4 Browser

Sign in as a Reviewer and confirm — **by rendering, not by asserting a selector exists**:

1. **It reaches a page at all** (S1). If it bounces to `/login`, stop: that is R2.
2. **The sidebar is not empty** (S2) — count the rendered links.
3. The queue, a submission detail, the Export modal and Reports all render.
4. **No write control is visible**: no archive/restore, no status change, no editable cell, no
   Save. Enumerate the buttons and read the list — a *disabled* or *hidden-by-CSS* button is
   still a defect, and a **duplicated control is invisible to a count** (assert the list, not
   the length).
5. Settings → Users shows the new user's badge as **"Reviewer"**, not "Staff" (S4).

Two standing environment facts: **Vite binds IPv4 only — use `http://127.0.0.1:5173/`**, and
**`tsx watch` does not reload `.env`** (an env change needs a full backend restart, not a save).

---

## 11. What this plan deliberately does not do

**11.1 No per-form scoping.** A Reviewer is a Reviewer everywhere in the org (D1). The design for
per-form attachment is written up in [`user-roles.md`](./user-roles.md) and remains valid; it is
deferred, not refuted.

**11.2 No multi-role users.** `users.role` stays single-valued (D2), so Reviewer is an
*alternative* to Staff. Making it additive is a separate change — it needs an extra table and a
token claim, which is most of the per-form plan's cost without the per-form benefit.

**11.3 No administrative capability.** Nothing here reaches Settings, Users, Schools, form
design, or submission deletion.

**11.4 No change to school scoping.** `isSchoolScoped` / `scopedSchoolId` / `canAccessSchool` keep
their exact meaning. Reviewer is org-wide purely because it is *not* `cdm_contact` — no edit.

**11.5 No per-workspace role.** `workspaces.md` §13.2 / §14.3 ask the same shape of question one
level up. Untouched.

**11.6 No fix for `ALLOWED_ROLES`.** Recorded in §9; fixed in a separate change, if at all.

---

## 12. Open questions

1. **✅ D4 — is Reviewer read-only?** (§4) **Answered 2026-09-30: yes** — and seeded as a built-in
   (`roles-settings.md` §13 Q2). The fallback this question guarded against ("if a Reviewer must edit,
   adding a role achieves nothing") did not apply. Retained so the question is visibly answered rather
   than silently dropped.
2. **Is `reviewer` the right key and "Reviewer" the right label?** `access-groups.md` §2 notes the
   key is a permanent identifier stored in `form_fields.roles`, `system_messages.audience` and
   `menu_items` JSON. Renaming it later means rewriting stored data — **choose deliberately**.
   (Labels are free to change; keys are not.)
3. **Should a Reviewer see staff-only fields?** `fieldAccessRoles()` returns `[...ROLES]` for an
   unset field, so it will see them by default (§3.1). If a Reviewer should see *fewer* columns
   than Staff, that is a per-field decision and needs an explicit narrower default.
4. **Should a Reviewer be school-scoped instead?** One line — `role === "cdm_contact" ||
   role === "reviewer"` — but then `users.school_id` must be set for every Reviewer, and
   "School Reviewer" starts to look like a *second* School Contact rather than a distinct role.
5. **Does `reviewer` need a landing page?** `HomeRedirect` sends it to `/staff` under this plan,
   which is correct only while it has `view`. If a future variant is report-only, it needs
   somewhere else to land.
6. **P1 now or later?** (§7) Changes P2 from ~13 files to ~3, and removes the S1/S2/S5 class.

---

## 13. File-by-file change list

### Server

| File | Change |
| --- | --- |
| `server/src/db/schema.ts` | **L4** add `"reviewer"` to `ROLES`; **L609** the `CREATE TABLE` CHECK; **L647-666** a new widening block copied from the `cdm_contact` template. `Role` derives itself. |
| `server/src/db/dialect/turso.ts` | **L77** add `'reviewer'` to the CHECK (new databases only — §6.2) |
| `server/src/routes/forms.ts` | **L81**, **L371** add `"reviewer"`. **L391 stays.** |
| `server/src/routes/submissions.ts` | **L136, 170, 181, 411, 432** add `"reviewer"`. **L202, 250, 287, 375, 453, 489, 526 stay.** |
| `server/src/routes/export.ts` | **L25**, **L81** add `"reviewer"` |
| `server/src/routes/documents.ts` | **L47**, **L172** add `"reviewer"`. **L62, L103 stay.** |
| `server/src/routes/reports.ts` | **L40** add `"reviewer"` to `REPORT_ROLES` |
| `server/src/routes/settings.ts` | **L93** — reviewed for S5; no code change, but audit the stored `menu_items` value — installation-wide, not per org (§8 R5) |
| `server/src/auth.ts` | **no change** — `isSchoolScoped` already excludes it (§5.3) |
| `server/src/schemas.ts` | **no change** — `z.enum(ROLES)` picks it up (§3.1) |
| `server/src/swagger.ts` | the 10 `enum: ["admin","staff","cdm_contact"]` lists + the description at L25 |
| `server/src/db/submissions-archive.test.ts` | **no change — and it must stay green.** It is the guard that Reviewer is read-only (§4.3) |
| `server/src/db/system-messages.test.ts` | **no change** — spreads `ROLES` (§5.4) |

### Client

| File | Change |
| --- | --- |
| `client/src/types/index.ts` | **L3** — `Role` union gains `"reviewer"` |
| `client/src/lib/settings.ts` | **L5** `ROLES`; **L15** `ROLE_AUDIENCE_LABELS` (**compiler-forced** — §5.1) |
| `client/src/pages/HomeRedirect.tsx` | **L7** add `reviewer` → `/staff` — **S1, app is unusable without it** |
| `client/src/components/layout.tsx` | **L323** add `reviewer` to the staff nav gate — **S2** |
| `client/src/App.tsx` | **L137, 147, 157, 167** — add `reviewer` to the four `/staff*` `ProtectedRoute` lists |
| `client/src/pages/admin/AdminSettings.tsx` | **L47** `roleBadge` branch (**S4**); **L1726** the `<option>` (**S3**) |
| `client/src/pages/admin/AdminFormDesigner.tsx` | **L22** local `ROLES`; **L26** `roleLabel` branch (**S6**) |
| `client/src/pages/LoginPage.tsx` | **L353** the label ternary (**S7**) |
| `client/src/pages/staff/StaffSubmissionDetail.tsx` | **no behavioural change** — comment L40 as deliberately excluding `reviewer`, or it will be "completed" later (§5.3) |
| `client/src/pages/staff/StaffQueue.tsx` · `StaffDocuments.tsx` · `reports/ReportsPage.tsx` | **no change** — comment each `role === "cdm_contact"` check as deliberate (§5.3) |

### Docs

| File | Change |
| --- | --- |
| `docs/plans/user-roles.md` | superseded banner for the immediate need; retained as the per-form design |
| `docs/plans/access-groups.md` | note this role as the first consumer of §4; §9's open decisions gain the answers in §2/§4 here |
| `docs/plans/feature-backlog.md` | §7.4 ("worth doing *before* the fourth role is needed") → **this is that moment** |
| `docs/plans/workspaces.md` | §15 relationship table gains a row |
| `docs/guides/user-guide.md` | a Reviewer section, once shipped |
