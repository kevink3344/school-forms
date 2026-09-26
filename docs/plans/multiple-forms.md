# Multiple forms per user — visibility plan

| | |
|---|---|
| **Status** | Draft for review — **no code written yet** |
| **Date** | 2026-09-23 |
| **Area** | `dbo.users` / `dbo.forms` visibility, `GET /api/forms`, every form picker |
| **Touches** | `server/src/{auth,routes/forms,routes/users,routes/submissions,routes/export,routes/reports,schemas}.ts`, `server/src/db/{schema,queries,dialect/turso}.ts`, `client/src/lib/forms.ts`, `client/src/pages/{admin,staff,reports}/*` |

---

## 1. The request

> I need a plan for multiple forms. User A may need to see Form 1 and Form 2, while User B may
> only need to see Form 2. Right now the app defaults to Form 1. How do we handle this?

Restated as two separate problems, because they are:

1. **Visibility** — "which forms may *this person* see" is today a property of the **organization**,
   not the user. Every staff member and every School Contact in an organization sees every form in it.
2. **The default** — the app guesses a single form when it should not have to. The guess is
   `reportable[0]`, i.e. *the most recently updated published form* (§2.5). It is not "Form 1"; it is
   "whichever form somebody edited last".

Problem 2 is largely **solved by** problem 1: once visibility is narrowed, the common restricted
user can see exactly one form, and the existing rule *"a lone form is not a choice, select it"* —
already implemented in all three pickers — produces the right answer with no new default logic at all.

---

## 2. What happens today

### 2.1 One list query, scoped by organization only

`GET /api/forms` (`server/src/routes/forms.ts`, `requireAuth` + `requireRoles("staff","cdm_contact","admin")`):

```ts
const isStaff = req.user!.role !== "admin";
const schoolId = !isStaff && req.query.school_id ? Number(req.query.school_id) : undefined;
const forms = await listForms(schoolId, req.user!.organization_id);
res.json(forms);
```

`listForms` (`server/src/db/queries.ts` ~587) adds `f.organization_id = @organizationId` and, only when
`schoolId` is given, `f.school_id = @schoolId` — then `ORDER BY f.updated_at DESC`. Its own comment
explains why the school filter is not applied for staff: *"templates are org-wide and shared across
schools, so school-scoping would hide forms their school contributes to."*

**There is no per-user narrowing anywhere on this path.** Confirmed by measurement: no
`users.form_ids` column exists, and no `form_access`-style table exists (§2.4).

### 2.2 Who may see what, as the code stands

| Caller | Sees |
|---|---|
| `admin` | every form in the org (`/admin/forms` is the management surface — deliberately unrestricted) |
| `staff` | every form in the org |
| `cdm_contact` | every form in the org. School scoping (`isSchoolScoped`) narrows **submissions**, never the form list |
| parent (anonymous) | `GET /api/forms/public` and `GET /api/forms/:id/public` — published forms only, `staff_only` fields stripped |

Note the "Test User" login (`login_mode = select`) shows three active accounts in three different
roles — System Admin, Sammy Watkins (staff), Tom Jones (cdm_contact) — and **all three currently see
both forms**. That is the whole problem in one sentence.

### 2.3 Every place a form is chosen, and how each one lands on a form

| # | Selector | Source | Lands on |
|---|---|---|---|
| 1 | `ReportsPage.tsx` | `api.listForms()` → `selectableForms(f)` | **`reportable[0].id`** — first *published* form in `updated_at DESC` order |
| 2 | `StaffQueue.tsx` | `api.listForms()` | a form **only if `f.length === 1`**, deliberately off the **raw** list (*"so that one live form beside an archived one does not silently scope the queue"*) |
| 3 | `AdminDashboard.tsx` | `Promise.all([api.listForms(), api.listSchools()])` | a form **only if `selectableForms(f).length === 1`** |
| 4 | `ExportModal.tsx` | forms passed in as a prop | no default of its own |
| 5 | `WebhookLog.tsx` | `api.listForms()` | every form, by design (*"most failures in this log are responses that arrived while their form was unpublished"*) — route is `requireRoles("admin")` |
| 6 | `AdminForms.tsx` | `api.listForms()` | the management list — deliberately **not** filtered by `selectableForms` |

`selectableForms(forms)` (`client/src/lib/forms.ts`) = `forms.filter(f => f.status === "published")` and is
the **one** shared client-side selector filter; every picker is required to go through it rather than
filtering inline, because the three lists previously drifted apart.

### 2.4 Measurements (live database, `DB_MODE=sqlserver`, org 1)

Read-only probe, with two deliberately failing controls (unknown table → `Invalid object name`;
`SELECT FROM WHERE ((` → `Incorrect syntax near the keyword 'FROM'`) — both failed as required, so the
harness was executing statements and reporting errors rather than swallowing them.

| Surface | Measured |
|---|---|
| Forms | **2** — id **2** `CDM Google Form`, `status=published`, `code=CDM2`, org 1, school 1, updated `2026-09-21T15:14:01Z`; id **1** `Test Form`, `status=draft`, `code=CDM`, org 1, school 1, updated `2026-09-14T01:45:25Z` |
| Forms by status | draft 1, published 1 |
| Users | **6** total — admin **1**, `cdm_contact` **3**, `staff` **2**; all `organization_id = 1` |
| Active users | **3** — System Admin (admin, school NULL); Tom Jones (`cdm_contact`, school 38); Sammy Watkins (`staff`, school 38) |
| Submissions | **24** — form 1 → **6** (0 archived), form 2 → **18** (0 archived) |
| `users.form_ids` | **does not exist** (`sys.columns` → 0 rows) |
| `dbo.report_views` | per-user already: `user_id`, `organization_id`, `form_id`, `is_default`, `last_used_at`. **It has no `owner_id`** — my first probe assumed one and failed with `Invalid column name 'owner_id'` |

Two facts fall out of this table that shape the design:

- **Only one form is published**, so today's pickers do not show a *choice* at all — the singular-form
  rule in `StaffQueue`/`AdminDashboard` fires, and `ReportsPage`'s `reportable[0]` has exactly one
  candidate. The "default to Form 1" behaviour the request describes becomes visible the moment a
  **second** form is published, and it will then be the wrong default for most users (see §2.5).
- **24 submissions are already distributed across two forms** — so narrowing is not cosmetic. A user
  restricted to form 2 must not be able to list, open, export, archive or build a report from form 1's
  6 submissions.

### 2.5 Why "Form 1" is really "whatever was edited last"

`ReportsPage.tsx` lands on `reportable[0]`, and the list is ordered `updated_at DESC`:

```
id 2  CDM Google Form   published   updated 2026-09-21   ← reports default here today
id 1  Test Form         draft       updated 2026-09-14
```

Note this is **not** the form with id 1, and note that saving a form moves it to the front of the list,
which moves the default. A user who opened "Reports" yesterday and again today can be looking at a
different form with no action of their own. That is the real defect behind "the app defaults to Form 1":
the default is *derived from an edit timestamp*, an ordering nobody intends to be meaningful.

There is also a **partial default mechanism already in the codebase**: `report_views.is_default`
plus the `viewAutoApplied` ref effect in `ReportsPage` — *apply a configured default when there is one,
otherwise apply a lone item, never guess among several*. §4.8 reuses that shape and that reasoning.

---

## 3. The shape of the fix

1. **Store a visibility grant per user**, tri-state, defaulting to *unrestricted* so that deploying the
   column changes nothing for the 6 existing users (§4.2).
2. **Narrow on the server, at the seam that already exists** — `listForms`, plus a `canAccessForm`
   guard mirroring the existing `canAccessSchool` (§5). The client keeps hiding; it never decides.
3. **Let the existing singular-form rule do the defaulting.** A restricted user with one grant gets that
   form selected in every picker, because every picker already selects a lone form.
4. **Fix the remaining guess** (`reportable[0]`) so that when several forms really are visible the app
   stops picking one silently (§4.8).

---

## 4. Decisions

### 4.1 Where the grant lives

| | Option | Pros | Cons |
|---|---|---|---|
| **A** | **`dbo.users.form_ids` `NVARCHAR(MAX)` NULL**, JSON array of form ids, read and written as `number[] \| null` | One column; no new table, no FK, no cascade path; identical to the four existing JSON-array columns (`forms.view_columns`, `form_fields.roles`, `report_views.columns`/`filters`) using the **already-documented NULL/`[]` convention**; one inert default (NULL) so the deploy is a no-op | No referential integrity — a deleted form leaves a dangling id (harmless: it matches no row); "who can see form X" is not a query |
| B | Join table `dbo.form_access(user_id, form_id)` | Real FK + `ON DELETE CASCADE`; "who can see form X" is a `SELECT`; the natural place to grow an `expires_at` or an `assigned_by` | A new table in **both** dialects; SQL Server's *one cascade path* rule (error 1785) has already bitten this schema twice — `submissions.school_id` and `submission_values.field_id` both had to become `NO ACTION`; needs its own ladder + a Turso `CREATE TABLE IF NOT EXISTS` |
| C | Reuse `docs/plans/access-groups.md` | No new storage if groups land | That plan is about **roles** being hard-coded in ~12 places; it defines no *user groups*, so this would mean inventing group membership as well. Bigger than the problem |
| D | `app_settings` key holding `{ role: [ids] }` (the `documents_link` pattern) | Zero schema change; role-level defaults come free | Cannot express *"User A yes, User B no"* — `documents_link` is per-**role**, and the request is explicitly per-user. Per-user keys in `app_settings` are a users table hiding in a key/value store |
| E | `dbo.forms.visible_user_ids` (the grant on the form side) | Reads naturally in the form editor — *"assign this form to…"* | Same storage, worse query (`OPENJSON` per form row), and a form with no assignment cannot distinguish *"everyone"* from *"nobody"* without inventing a sentinel |

**Recommendation: (A)**, with the enforcement shape deliberately *independent* of the storage choice
(§4.3), so migrating to (B) later touches the helper only.

What would change the recommendation to (B): a real group/team requirement, a need to query "who can
see form X" in SQL, or enough forms and users that a one-row-per-grant inventory earns its keep.

### 4.2 The tri-state is the whole safety story

Following the convention this codebase has already been burned by getting wrong
(`fieldAccessRoles` in `server/src/db/schema.ts:140`, and the removed duplicate `menu_items.documents` gate):

| Value | Means |
|---|---|
| **NULL** | unrestricted — this user sees every form their organization/role already allows. **This is what every existing user gets**, so the deploy is behaviour-preserving |
| **`[]`** | **deliberately no forms** — *not* "all forms". This is the trap: `[]` must produce `WHERE 1 = 0`, never a dropped clause |
| **`[2]`** | forms 2 (and only 2) |

Two hazards to write into the implementation, both of which this project has already hit:

- **A derived filter that collapses when absent silently widens scope.** The query builder must take
  `number[] | null` and treat `null` as "add nothing" and `[]` as "add `1 = 0`" — explicitly, with a
  test for each (§11). The failure mode is invisible: `[]` renders as "you can see everything",
  which is exactly backwards.
- **A grant narrows; it must never widen.** The grant is ANDed with the organization filter in
  `listForms`, never substituted for it. A form id belonging to another organization in someone's list
  must still be invisible.

### 4.3 Where the server learns the grant — and why the JWT is the wrong place

`requireAuth` (`server/src/auth.ts`) does **no database query**; `req.user` is built entirely from the
access-token claims (`sub`, `email`, `role`, `school_id`, `organization_id`). So the grant has to come
from somewhere:

| | Approach | Verdict |
|---|---|---|
| i | **Read `users.form_ids` on the narrowing request** in a small helper (`visibleFormIds(user)`), returning `number[] \| null`, cached in memory per user id with invalidation on `PUT /api/users/:id` | **Recommended.** Correct on the *next request*; the extra read is one indexed lookup by primary key, and every page here already issues several queries per load (the dashboard fires 5 in one `Promise.all`) |
| ii | Put `form_ids` in the **access-token claim** (minted in the login, select and refresh paths) | Consistent with how `school_id`/`organization_id` work, and free at request time — but the token lives **15 minutes**, so a change of grant is invisible until then. That asymmetry is the problem: a **stale grant** is an annoyance, a **stale revoke is a leak**. Reject it for revokes |
| iii | Cache the grant for the process lifetime | No |

Because of (ii)'s asymmetry, the narrowing must not depend on a claim. If token-minted grants are ever
wanted as an optimisation, they can only be a *cache in front of* the DB read, never the source.

### 4.4 Admin stays unrestricted

`admin` sees every form in the organization, always — matching `canSeeField`'s admin bypass, the
`canDesignForms` capability in `access-groups.md`, and `/admin/forms`'s deliberate refusal to filter by
`selectableForms`. Two reasons beyond consistency: an admin must be able to administer a form they did
not create, and a grant is not an ownership record. (The webhook log is also admin-only, so it needs no
narrowing — one fewer surface to change.)

### 4.5 The client hides; it does not decide

No second gate. `selectableForms` stays a **status** filter and `GET /api/forms` remains the only thing
that decides visibility — one policy, one place. The failure mode this avoids is the one this repo has
already produced twice: two overlapping gates for one feature (`documents_link` vs `menu_items.documents`),
where the second one drifts.

Client-side consequences are presentation only: the pickers simply have fewer options, and the
singular-form rules (§2.3 rows 1–3) do the defaulting.

### 4.6 The parent path is untouched

`GET /api/forms/public` and `GET /api/forms/:id/public` are anonymous and must **not** narrow. A form id
is load-bearing outside the app — an Apps Script bound to a Google Form is configured with that exact
number, and the numeric id is why `formLabel` renders `#id title`. Restricting a staff member's *view*
must never take a form offline for the families filling it in. The narrowing helper is therefore not
called from the public routes at all, and §11 has a test asserting that.

### 4.7 Refusal style: 403 for an action, empty for a list

- **List endpoints** (`GET /api/forms`, `GET /api/submissions?form_id=…`) — narrow in SQL. Asking for a
  form you were not granted returns *nothing*; it must not return another form's rows and must not leak
  the existence of the form via a count.
- **Row and action endpoints** (`GET /api/submissions/:id`, export, report build/save, archive/restore)
  — resolve the form and answer **404** (`Form not found`) rather than 403. A 403 confirms the form
  exists, and every one of these routes already answers 404 for "not in your organization"; matching that
  keeps the two indistinguishable.

And the invariant `auth.ts` already states for school scoping applies verbatim to forms:
**whatever filter governs the list must also govern the row**, so a row that appears in a list can never
404 on open. Both must be derived from one function.

### 4.8 The default form

| Situation | Behaviour |
|---|---|
| Exactly one form is visible | Select it (already implemented in all three pickers) |
| Several visible, one is the configured default | Select the default |
| Several visible, no default | **No selection** — show "All forms" / a `— Select —` prompt. No guessing from `updated_at` |
| Zero visible | The intentional empty state (§9) |

Phase 1 is the first and last rows plus removing `reportable[0]`'s silent pick; phase 2 adds an explicit
`default_form_id` (form-level, or per-user alongside the grant) using `report_views.is_default` and the
`viewAutoApplied` "apply a configured default, never guess among several" effect as the precedent.

The minimum change to fix the complaint: **delete the `reportable[0]` fallback** and let a real choice or
a lone form decide. Everything else about the default is a preference, and it is a question for review
(§15 Q4).

### 4.9 Should there be a login page per form? No — and what you can do today

**A per-form login page would be authentication for a problem that is authorization.** Sign-in answers
*"who are you"* (already answered, once, by one page); this request is about *"which forms may you read"*,
which is a grant checked per request.

| Why not | Detail |
|---|---|
| The people filling in forms never log in | Parents submit anonymously at `/submit`, `/submit/:formId`, `/org/:slug/submit`, `/org/:slug/forms/:formId`. A login page per form would put an authentication gate in front of the one path that deliberately has none — and would break the Apps Script bound to the form's numeric id (§4.6) |
| Login is already one page with three global modes | `login_mode ∈ {select, password, maintenance}`, stored in `app_settings` with a `LOGIN_MODE` env override. N forms would mean N pages all reading the same one setting |
| **A session carries no form** | The access token is `sub, email, role, school_id, organization_id` — forms are not in it. Signing in "at form 2's page" would restrict nothing: after login the SPA has its full route table and `/reports?form_id=1` is one click away. The restriction must hold on **every request**, not at the door |
| Sign-in page ≠ landing page | `HomeRedirect` lands admin on `/admin`, staff/`cdm_contact` on `/staff`. Per-form entry would need a per-form landing plus a `?next=` redirect target to validate on every login — a new open-redirect surface, for no benefit |
| It multiplies the surfaces to get right | The mode switcher, the org picker, the forced-password redirect and the refresh-cookie path all live on that one page today |

**The correct precedent already exists:** form-scoped **URLs** (`/org/:slug/forms/:formId`) without
form-scoped **auth**. Keep it that way.

**So, concretely: today there is no way to restrict someone from viewing a form in the app.** Measured —
6 users, all `organization_id = 1`, no `users.form_ids` column, and `GET /api/forms` narrows only by
organization. Every active staff member and every `cdm_contact` sees both forms (submissions: form 1 → 6
rows, form 2 → 18).

The only two levers that work right now:

| Lever | Blast radius |
|---|---|
| **Unpublish the form** (`status` → `draft` / `archived`) | Removes it from **every** selector (`selectableForms`) *and* blocks submissions — `GET /:id/public` answers 400 when `status !== "published"`. Blunt: it hides the form from the parents and from your own pickers too |
| **A separate organization** | `organization_id` is the one *enforced* isolation boundary — `listForms`, `getFormWithFields`, submissions, documents and the rest all filter on it. Put Form 2 and its staff in a second organization and they cannot see Form 1. Cost: a duplicated organization, and admins see only their own |

One common misconception worth naming, because it looks like it should already do this:
**school scoping does not restrict viewing a form.** `isSchoolScoped()` is true only for `cdm_contact`, and
`scopedSchoolId` filters **submissions**, never the form list — so a School Contact sees every form in the
organization and only their own school's rows *inside* each one.

That gap is exactly what §4.1–§4.3 close: **visibility is a grant read per request — not a property of
which page you signed in on.**

### 4.10 Registration codes — "register, enter a code, get matched to a form and to your records"

This is a good instinct, and it fits this application far better than it fits most — but not for the
reason it first appears. The code's real job here is not convenience. It is **replacing an unverified
claim with a verified assignment.**

#### 4.10.1 What a code actually fixes

Registration is already open and self-service, and it currently trusts the caller twice:

```ts
// server/src/routes/auth.ts — POST /api/auth/register   (auth: "none", public)
const targetOrg = await getDefaultOrganization();        // ← org: server-chosen, GOOD
const user = await createUser(email, passwordHash, "staff", school_id, displayName, true, targetOrg.id);
//                                                            ↑ school_id: CALLER-chosen, unverified
```

| Claim | Today | With a code |
|---|---|---|
| **Organization** | server-chosen (`DEFAULT_ORG_REGISTRATION`); the body cannot name a tenant — already correct, and must stay that way | the code carries it; the body still cannot name it |
| **School** | **caller picks any of 235 schools from a public dropdown and is never asked to prove it** | comes from the code the admin issued for that school |
| **Role** | fixed to `staff` by the route (deliberately — see the comment) | may be set by the code, but only within `staff` \| `cdm_contact` (§4.10.5) |
| **Forms** | every form in the organization (§2.1) | the forms the code names — §4.1 |

Measured: **235 schools exist, only 3 have ever had a user** (and 2 a submission), 2 organizations
(`academics`, `technology-services` — all 6 users are in the first). So the realistic shape of this app is
*many schools × a few people each*, which is exactly the case where an admin hand-creating accounts does
not scale and a code does. If the user set were 6 known people, the admin panel (§10) would be strictly
better; at 235 schools it is the wrong tool.

The registration form's school dropdown is the thing to notice: it is a list of 235 schools, the choice is
never verified, and picking one is what sets a user's scope. **A code replaces that dropdown.** That is the
argument for building this, and it is a security argument, not a convenience one.

#### 4.10.2 Where the code is entered — and the default that must change

| | Variant | Verdict |
|---|---|---|
| **A** | **The code gates registration** — a required field on the register form; `POST /api/auth/register` resolves it, sets org/school/role/form-grants **from the code**, ignores the body's `school_id`, and mints the session only after the code validates | **Recommended.** One atomic step: no window in which an account exists with no scope, the unverified school pick disappears, and the public door is closed by the same change |
| B | Register first, then redeem (an authenticated `POST /api/auth/redeem`) | Shows a clean "you have 3 forms" confirmation screen, but it needs the fix below. Otherwise **the gap between registering and redeeming is an open door**: a fresh `staff` account sees every org form (§2.1) until they redeem |

**If (B) is chosen, the registration default must become `[]`** — a self-registered account starts able to
see *nothing* until a code grants something. Note this is deliberately **different** from §4.2's `NULL`
default, and the two must not be collapsed into one constant:

| Row | Default | Why |
|---|---|---|
| Existing users, and the migration | `NULL` = unrestricted | The deploy must be behaviour-preserving for the 6 rows already there |
| Newly self-registered users, if redeem is a separate step | `[]` = nobody | Otherwise registering *is* the grant, and the code restricts nothing |

That asymmetry is the whole security story of variant (B) and the easiest thing to get wrong.

#### 4.10.3 What a code carries

A code is a **pre-authorized scope**, resolving to fields the app already stores — plus the new grant:

```
{ organization_id, school_id, role, form_ids[], max_uses, expires_at, note }
```

It is not a parallel permission system; it is a *front door to `dbo.users`*. After redemption the code is
history and the per-request path is §5 unchanged. **This is the key design constraint:** the code must
never be evaluated on the request path, or you have built a second authorization gate — the thing §4.5
exists to prevent, and a failure this repo has already had twice (`documents_link` vs `menu_items.documents`).

#### 4.10.4 "and the records they are supposed to see" — three different questions

This phrase hides three levels, and only two of them need anything built. Getting the third wrong is a
privacy incident, so it is worth separating:

| Level | Means | Mechanism | Work |
|---|---|---|---|
| **1. Form scope** | "you can see Form 2" | `form_ids` grant | §4.1 — already planned |
| **2. Record scope by school** | "…only Broughton High's submissions inside Form 2" | **already built**: `role = cdm_contact` + `school_id` → `isSchoolScoped()` + `scopedSchoolId()` filter submissions | **none** — the code just sets `role` and `school_id` |
| **3. Record scope per person** | "…only *my own* submission" | `submission.public_id` served at `/submission/:publicId` | **do not build a code for this, and never match on names** (below) |

**Level 2 is the important one and it is free.** The app already enforces school-level record scoping for
`cdm_contact`, so a code that says *"you are the CDM contact for school 38"* narrows that person's
submissions to school 38 with no new mechanism at all. Note the corollary: a code granting plain `staff`
gets level 1 only — staff carry a `school_id` (measured: 38 and 11) but it is **not used for scoping**, so
a staff code means every submission of the granted forms, org-wide. If a code is meant to restrict records,
it must grant `cdm_contact`, not `staff`. That is a one-word difference with opposite meanings.

**Level 3 must not be built by matching personal data.** The obvious implementation — "the person
registers their name/email/child and we match it against submission field values" — produces false
positives (*seeing another family's records*, the actual harm) and false negatives (*your own record not
found*, which reads as a bug), on data entry that is free-text and unnormalised. The app already has the
right primitive: an unguessable server-issued `public_id` per submission, already served anonymously at
`/submission/:publicId`. If a person needs to see their own submission, that link is the mechanism; there
is no matching step and nothing to leak. **A code for level 3 is the wrong tool** — say so plainly rather
than building it.

#### 4.10.5 Code design (the parts that decide whether this is safe)

| Decision | Recommendation | Why |
|---|---|---|
| Entropy | **8+ characters of base32 (~40 bits)**, server-generated | Guessing is hopeless regardless of the limiter, so the limiter is defence in depth rather than the control. A human-chosen `BROUGHTON2026` is guessable and must instead be short-lived and multi-use-capped |
| Storage | **Hash it** (bcrypt, cost 12 — the same call already used for passwords), keep a short plaintext **label/prefix** for the admin list | A stolen DB row must not be an access credential. Consequence: **show the full code once at creation**; a lost code is *regenerated*, not recovered. If an admin truly must re-print it, that is a deliberate downgrade for a PII store — recommend against |
| Use count | **Multi-use with `max_uses` and `expires_at`**, not unlimited | A per-school code must onboard several people, but "unlimited and never expires" means one leak is permanent access and you cannot tell a legitimate join from an attacker's |
| Redemption record | **Every redemption recorded**: `code_id, user_id, redeemed_at, ip` | This is the only thing that makes a code revocable or investigable. Without it "who can see what" is unanswerable and §10's `N of M` view is a lie |
| Role ceiling | **`staff` or `cdm_contact` only — never `admin`** | Same reasoning as the existing comment on `/register` ("honouring a caller-supplied role would let anyone self-register as an admin"). An admin invite is a privilege-escalation token; use `seed-admin` / the Users panel |
| `show_on_test_screen` | **must stay 0** for any code-redeemed account | **★ The sharpest trap here.** Select-mode login (`POST /api/auth/select`, `selectLoginSchema = { userId, organizationId? }`) is **passwordless** — it is gated *only* by `show_on_test_screen = 1`. A redeemed account that landed in that dropdown would be loggable-in as by anyone, making the code bypassable entirely. The existing register path is safe because it never sets the flag; new code must preserve that |
| Rate limiting | a **dedicated tight limiter** on the redeem/register-with-code endpoint | The `changePasswordLimiter` in `server/src/routes/auth.ts` is the precedent (10 / 15 min) and its comment states why the global limiter is too loose: *"far too loose for something a caller could otherwise use as a password-guessing oracle."* The global 1000 / 15 min is ~100× looser |
| Error messages | **identical** for "no such code", "expired", "already used" | An oracle that distinguishes them tells an attacker whether a code exists, and lets a legitimate failure be misread as a typo |
| Revocation | **state both actions in the UI:** revoking a code stops *further* redemptions; it does **not** revoke grants already issued | Because redemption writes the grant (§4.10.3), a revoked code leaves existing holders with access. That is the correct model (grants are durable, revoke per user) but it is a genuine surprise if unstated — an admin who revokes a code expecting immediate lockout will believe they have secured something they have not |
| Public path | **never on `/submit*`** | Parents submit anonymously (§4.6); a code prompt there would gate the one path that must stay open |

#### 4.10.6 Schema

Two tables (both dialects — §7's checklist applies unchanged, including the Turso `addColumns`/`TURSO_DDL`
pair and the `libsql.test.ts` exact-index-set comparison):

```
dbo.access_codes        id, code_hash, label, organization_id, school_id, role,
                        form_ids NVARCHAR(MAX) NULL, max_uses, use_count,
                        expires_at, revoked_at, note, created_by, created_at
dbo.access_code_uses    id, code_id, user_id, redeemed_at, ip
```

Note `form_ids` here is **not** nullable-means-unrestricted — a code with no forms is a code that grants
no forms. The tri-state lives on `dbo.users` (§4.2); a code is always a positive statement of scope. The
two must not share a helper that assumes the same meaning for `NULL`. `dbo.report_views` shows the
established per-user FK + index shape to follow, and the cascade lesson repeats: `code_id` cascades from
`access_codes`, but `user_id` must be `NO ACTION` if another path already reaches `users` (SQL Server
error 1785 has already forced two `NO ACTION` downgrades in this schema).

#### 4.10.7 Verdict

**Build it — but as an alternative front door to §4.1, not instead of it.** The code has nowhere to put
its answer without the grant column, so §4.1 is a prerequisite. Order: §4.1 enforcement → the admin grant
editor (§10) → codes. Even if codes land, the admin panel stays, because a code cannot revoke, cannot
cover the users whose scope changes, and cannot answer "who can see Form 2" on its own.

**Which to reach for first, given 6 users today?** The admin panel. It is smaller, has no shared secret,
and is fully revocable. The code earns its keep at the moment onboarding stops being something an admin can
do by hand — and 235 schools with 3 used says that moment is coming, not that it has arrived.

---

## 5. Enforcement surface (server)

One new helper module — `server/src/forms/visibility.ts`, or a section in `server/src/auth.ts` next to
the school helpers — with the mirror-image pair:

```ts
export function visibleFormIds(user: ScopedUser & { id: number }): number[] | null  // null = all
export function canAccessForm(user, formId: number | null): boolean               // admin → true; null → true
```

`canAccessForm` must be derived from `visibleFormIds` exactly as `canAccessSchool` is derived from
`scopedSchoolId` (that file's comment explains why: *a row that appears in the list can never 403 on open*).

| File | Site | Today | Required |
|---|---|---|---|
| `routes/forms.ts` | `GET /` | `listForms(schoolId, org)` | pass `visibleFormIds`; narrowed in SQL |
| `routes/forms.ts` | `GET /:id`, `POST /`, `PUT /:id`, `POST /:id/drive-validate` | `requireRoles("admin")` | unchanged — admin unrestricted |
| `routes/forms.ts` | `GET /public`, `GET /:id/public` | published only | **unchanged — must not narrow** |
| `routes/submissions.ts` | `GET /` (`?form_id=`) | form filter applied verbatim | AND the grant |
| `routes/submissions.ts` | `GET /:id`, archive/restore, documents | `canAccessSchool(user, row.school_id)` | add `canAccessForm(user, row.form_id)` |
| `routes/export.ts` | preview / csv | form resolved through the query | AND the grant (a form id in the body must not widen it) |
| `routes/reports.ts` | build / save view / list views | `getForm(formId, org)` | AND the grant; a saved view pointing at a lost form must refuse, not render empty |
| `routes/documents.ts`, `routes/inventory.ts` | per-form surfaces | org-scoped | audit each; AND where a form id is accepted from the caller |
| `routes/webhookEvents.ts` | log, stats, replay | `requireRoles("admin")` | unchanged — admin unrestricted |
| `routes/users.ts` | `GET /`, `POST /`, `PUT /:id` | hand-built DTOs | read/write `form_ids` in **all three** (a field missing from any one of them saves but never displays — the documented failure mode of this file's hand-built DTOs) |

Every site that accepts a `form_id` from the caller is a candidate for the same bug: **a caller-supplied
form id that is trusted rather than intersected with the grant.** The grant must be applied in the query
or the guard, never inferred from the request.

## 6. Client touchpoints

| File | Change |
|---|---|
| `client/src/pages/reports/ReportsPage.tsx` | remove the `reportable[0]` fallback; render a prompt when several forms are visible and none is configured; render the empty state when `reportable` is empty |
| `client/src/pages/staff/StaffQueue.tsx` | no logic change (the `f.length === 1` rule already handles a narrowed list); keep the comment and add a note that the raw-list rule now also protects against a grant |
| `client/src/pages/admin/AdminDashboard.tsx` | no logic change; the singular-form rule already handles it |
| `client/src/pages/staff/*`, `reports/*` | an empty state naming the reason ("No forms are assigned to your account") |
| `client/src/pages/admin/AdminSettings.tsx` (Users panel) | the grant editor (§10) |
| `client/src/types/index.ts` | `AdminUser.form_ids: number[] \| null` |
| `client/src/lib/api.ts` | `createUser` / `updateUser` accept `form_ids` |
| `client/src/lib/forms.ts` | unchanged — `selectableForms` stays a status filter (§4.5) |

## 7. Schema work (must be done in **both** dialects)

For `users.form_ids`, following the established checklist:

1. **SQL Server** (`server/src/db/schema.ts`): add the column to `CREATE TABLE dbo.users` **and** add a
   separate `IF COL_LENGTH('dbo.users','form_ids') IS NULL ALTER TABLE dbo.users ADD form_ids NVARCHAR(MAX) NULL;`
   batch for existing databases. It must be **its own batch** — SQL Server compiles each batch before
   executing it, so a statement referencing a just-added column cannot share a batch (error 207).
2. **Turso** (`server/src/db/dialect/turso.ts`): the final shape in `TURSO_DDL`'s `CREATE TABLE IF NOT EXISTS users`,
   **and** an `AddColumn` entry in the `addColumns` array (~line 307) so an existing libSQL database is
   upgraded. SQL Server's `addColumns` stays `[]`.
3. **No** `BOOLEAN_COLUMNS` entry (not a boolean) and **no** `TIMESTAMP_COLUMNS` entry.
4. **No index.** The column is never queried by value — it is read by primary key. Worth stating
   explicitly because `db/libsql.test.ts` compares the two dialects' **exact index-name sets**, so an
   index added on one side only is an immediate test failure.
5. **Default is NULL** — meaning "unrestricted" — so existing rows behave identically and the column is
   backward compatible. That compatibility is what makes it safe to ship through a shared-database
   staging slot, where `initDb()` runs the whole cumulative DDL ladder against **production** on the
   slot's first request. A rename, a type change or a dropped column would need its own database; a new
   nullable column does not.
6. **Data migration needed only if** a "grant everything" backfill is wanted — `NULL` already means it,
   so no backfill is required. Where a grant is written, remember the SQL Server driver returns ids as
   **strings**: the writer must normalise (`Number(...)`) before `JSON.stringify`, and the reader must
   tolerate both (the `Number.isInteger("1")` incident in `auth.ts` is the same hazard).

**Deleting a form** (`deleteForm`) leaves its id in any grant. Harmless — a dangling id matches no row —
but `deleteForm` should prune it so the admin editor never renders a chip for a form that no longer
exists.

## 8. API, validation, and the route-registration rule

**Do not add a route for this.** Extend the existing user surfaces:

- `createUserSchema` / `updateUserSchema` (`server/src/schemas.ts`) gain
  `form_ids: z.array(z.number().int().positive()).nullable().optional()` — `.nullable()` because `null`
  and `[]` are different answers (§4.2), `.optional()` so an untouched field is not written.
- `POST /api/users` and `PUT /api/users/:id` persist it; all three hand-built DTOs in
  `server/src/routes/users.ts` return it.
- Because no path is added or changed, `server/src/routes/inventory.ts` and `server/src/swagger.ts`
  need no new entries — **but if review asks for a dedicated route** (e.g. `PUT /api/users/:id/forms`),
  it must be registered in **both** files or `swagger.test.ts` fails, and its auth type must be
  `staff`/`admin` (which *must* set `security`; only `none|secret|cookie` omit it).

## 9. Empty states, deep links, and saved views

These are the cases a naive implementation gets wrong, and three of them are new *because* grants exist:

- **Zero visible forms.** A deliberate empty state — the page explains that no forms are assigned and who
  to ask — not an empty picker that looks broken, and not a silent fallback to another form. This is the
  "the empty state is the feature" precedent: a destination that always looks empty should say why.
- **A stale `form_id` in the URL.** `/reports?form_id=1` or `/staff?form_id=1` for a form the user lost
  access to must not render form 2's data under a stale selection. The server narrows (§5); the client
  must notice that its pinned id is absent from the returned list and fall back to the picker with a note.
- **A saved report view pointing at a lost form.** `ReportsPage` deliberately does **not** re-check a
  saved view's `form_id` against the published list on mount (documented in the file). With grants that
  becomes a real hole: `report_views.form_id` is per-user, so a user whose grant was narrowed can apply a
  view for a form they may no longer read. The server must refuse (404, §4.7) and the client must degrade
  to the picker rather than render an empty grid that looks like "this form has no data".
- **A deep link to a submission of a lost form.** `GET /api/submissions/:id` must refuse (§4.7).

## 10. Admin UX

Where does an admin assign forms to a user? Three candidate places, in order of cost:

1. **The Users panel in `AdminSettings.tsx`** (recommended) — a checkbox list of the organization's forms
   in the user editor, with two explicit states above it: **"All forms (unrestricted)"** and
   **"None"**, matching the tri-state rather than pretending it is a yes/no. A `N of M forms` column in
   the user table makes restrictions visible without opening each user, which matters once there are more
   than a handful of forms.
2. **The form designer** — a read-only line (*"visible to 3 of 6 users"*) so an author can see who their
   form reaches, deferring to (1) for editing.
3. **Bulk assignment** — deferred; a per-role default (*"all staff see this form"*) is the group story
   and belongs with `access-groups.md` if it is wanted at all.

Guard rails worth building in from the start: warn (do not block) when a restriction would leave a user
with **zero** forms, and make restricting a user **sticky** in the sense that a form created afterwards
is **not** automatically visible to them — which is the correct, secure default for a restricted account
and the opposite of what a "grant" screenshot usually implies. Say it in the UI: *"new forms are not
assigned automatically while this account is restricted."*

## 11. Testing and verification

**Unit / integration (vitest — the suite is currently 103 tests in 6 files):**

1. `visibleFormIds` — the tri-state, three tests: `null` → no filter, `[]` → **zero rows** (not all),
   `[2]` → exactly form 2.
2. **The mandatory failing control** for any "this works" assertion — a syntax error and an unknown
   object must both be reported as failures before a pass is trusted (the standard used for the probe in §2.4).
3. `GET /api/forms` per role: admin unrestricted; a restricted staff user sees only granted forms; an
   unrestricted one is unchanged.
4. **The grant narrows, never widens**: a grant holding another organization's form id does not expose it.
5. `GET /api/forms/public` is **not** narrowed by any grant.
6. `GET /api/submissions?form_id=<ungranted>` → empty; `GET /api/submissions/:id` for an ungranted form → 404
   (`Form not found`), indistinguishable from a cross-organization id.
7. Export and report build against an ungranted form id → refused.
8. `GET /api/users` returns `form_ids` for a user with a grant, `null` for one without — and the same
   field survives `POST` then `GET` (the hand-built-DTO trap).
9. `libsql.test.ts` still passes (the dialect index-name sets and the new `addColumns` entry).

**Commands:** `cd server && npm run typecheck && npm test`, `cd client && npm run typecheck && npm run build`.

**Browser walkthrough, per role** (dev server on `http://127.0.0.1:5173/`, `tsx watch` does **not** reload
on `.env` changes):

| User | Account | Expect |
|---|---|---|
| admin | System Admin (`/login?admin=1` picker) | both forms everywhere; `/admin/forms` lists both |
| restricted staff | Sammy Watkins | only the granted form in Reports, the staff queue **and** the dashboard; it is *selected* (lone form) |
| unrestricted staff | a fresh account | unchanged from today |
| zero grants | a temporary account | the explained empty state, no form rendered |

Notes for whoever runs this: inject a token via `page.evaluate(() => fetch('/api/auth/select', …))` then set
`localStorage.school_forms_access_token`; **`locator.click()` fails constantly in the VS Code embedded
browser — use `locator.dispatchEvent('click')`**; the global rate limiter is 1000 requests / 15 minutes.

## 12. Risks

| Risk | Mitigation |
|---|---|
| `[]` read as "all forms" — the failure would look like a permissive default | Explicit `1 = 0` branch with its own test (§11.1); the phrase "`[]` means nobody" in the helper's doc comment |
| A second, client-side visibility gate drifting from the server's | Do not add one (§4.5); `selectableForms` stays a status filter |
| A caller-supplied `form_id` trusted on some surface | Audit every site that accepts one (§5); test the ungranted value on each |
| The parent path narrowed by accident, taking a live form offline | Type/test separation: the narrowing helper is simply not reachable from the public routes, plus test §11.5 |
| An existing user *loses* access on deploy | Impossible with a NULL default; assert it in the migration test |
| New forms invisible to restricted users and nobody notices | The "sticky restriction" line in the editor (§10) and the `N of M forms` column |
| Staging deploy mutating production | The change is a nullable column — backward compatible by construction, so the shared-database ladder is safe this time (§7.5) |
| `report_views` applied by `form_id` after a revoke | §9: server refuses, client degrades to the picker |
| **A code-redeemed account becomes selectable in the passwordless test login** — the code would then be bypassable entirely | Force `show_on_test_screen = 0` on every code path that creates a user, and assert it (§4.10.5) |
| **The register→redeem window (variant B) leaves a new account able to see every org form** | Self-registered default is `[]`, explicitly different from the migration's `NULL` (§4.10.2) |
| **A code grants `admin`** | Codes may never set `admin`; assert the ceiling in the redemption schema, not just the UI (§4.10.5) |
| **An admin revokes a code and believes access stopped** | Revocation stops further redemptions only. Two explicit actions in the UI, with the distinction in the confirm text (§4.10.5) |
| A code stored in plaintext leaking an access credential | bcrypt the hash, keep a label for the admin list, show once and regenerate (§4.10.5) |

## 13. Options summary

| Option | Effort | Meets the request | Risk |
|---|---|---|---|
| **1. Do nothing but stop the guessing** (drop `reportable[0]`, keep org-wide visibility) | ~1 file | No — User B still sees form 1 everywhere else | Low |
| **2. Per-user grant column + server narrowing** (**recommended**) | ~10 files, one nullable column, no new table | Yes | Low — deploy is behaviour-preserving |
| 3. Per-user grants + join table `form_access` | ~13 files, new table in two dialects, cascade-path care | Yes | Medium — error 1785 territory |
| 4. Role/group-level rules (`documents_link` pattern) | ~6 files, no schema change | Partially — cannot express *"User A yes, User B no"* | Low, but wrong shape for the ask |
| 5. Full group/permission model with `access-groups.md` | Large | Yes, and more | Medium — scope far beyond the request; land it as phase 3 if groups are ever needed |
| **6. Registration code that gates sign-up** (§4.10 variant A) — a code sets org/school/role/form grants and registration completes only if it validates | ~6 files on top of option 2 (two tables, both dialects) | Yes, **and** closes the unverified school pick | Medium — a shared secret; needs hashing, expiry, use caps, a redemption record, and a tight limiter. **Requires option 2 first** |
| 7. Code redeemed after registering (variant B) | as 6, plus a two-step UI | Yes | Medium-high — the register→redeem window is an open door unless the self-registered default is `[]` (§4.10.2) |
| 8. Code that matches a person to *their own* records | — | No | **Reject** — means matching names/emails against free-text submission fields, producing both false positives (seeing another family's data) and false negatives. Use the existing `public_id` link instead (§4.10.4) |

**Recommendation: option 2**, delivered in two steps — (a) the grant column, the narrowing helper and the
enforcement table in §5; (b) the admin editor, the empty states and the default-form rule. Step (a)
alone makes the request true on the server; step (b) is what makes it legible to the people using it.

**Option 6 is the right answer if onboarding is meant to scale past what an admin can do by hand** — and
235 schools with 3 ever used suggests it is. But it sits *on top of* option 2, never instead of it (§4.10.7).

## 14. Files to change

| File | Work |
|---|---|
| `server/src/db/schema.ts` | `users.form_ids` — `CREATE TABLE` + its own `IF COL_LENGTH` batch |
| `server/src/db/dialect/turso.ts` | `TURSO_DDL` users shape + `addColumns` entry |
| `server/src/db/queries.ts` | `listForms` grant intersection; `getUser*` read/write of the column; the user-payload mapper |
| `server/src/forms/visibility.ts` *(new, or a section of `auth.ts`)* | `visibleFormIds`, `canAccessForm` |
| `server/src/routes/forms.ts` | `GET /` narrowing |
| `server/src/routes/submissions.ts` | list filter + per-row guard |
| `server/src/routes/export.ts`, `routes/reports.ts`, `routes/documents.ts`, `routes/inventory.ts` | grant intersection / guard where a form id is accepted |
| `server/src/routes/users.ts` | `form_ids` in all three DTOs + persistence |
| `server/src/schemas.ts` | `createUserSchema` / `updateUserSchema` |
| `client/src/types/index.ts`, `client/src/lib/api.ts` | transport the field |
| `client/src/pages/admin/AdminSettings.tsx` | the grant editor |
| `client/src/pages/reports/ReportsPage.tsx` | default rule, empty state, stale-view fallback |
| `client/src/pages/staff/StaffQueue.tsx`, `client/src/pages/admin/AdminDashboard.tsx` | empty state only |
| `server/src/db/schema.ts` *(if codes ship)* | `dbo.access_codes` + `dbo.access_code_uses`, each behind its own `IF OBJECT_ID` guard; `user_id` FK as `NO ACTION` if another path already reaches `users` |
| `server/src/db/dialect/turso.ts` *(if codes ship)* | both tables in `TURSO_DDL` + the matching indexes |
| `server/src/routes/auth.ts` *(if codes ship)* | resolve the code inside `POST /register` (variant A); a dedicated limiter modelled on `changePasswordLimiter`; `show_on_test_screen` stays 0 |
| `server/src/schemas.ts` *(if codes ship)* | `accessCodeSchema` with the `staff\|cdm_contact` role ceiling; `registerSchema` gains the code field |
| `client/src/pages/RegisterPage.tsx` *(if codes ship)* | the code field replaces the 235-school picker |
| `client/src/pages/admin/AdminSettings.tsx` *(if codes ship)* | a Codes panel: create (show once), copy, revoke, and the redemption list with `used N of M` |
| `server/src/**/*.test.ts` | §11 |

## 15. Questions for review

**Q1 — Is visibility per user, or always by group?** The request is per user ("User A", "User B"). If
the real rule is *"the CDM contacts at school 38 see these forms"*, the design should key on role+school
instead of a user list, and option 4/5 replaces option 2.

**Q2 — Storage: a nullable JSON column on `users` (recommended), or a `form_access` join table?** The
column is a no-op deploy; the table buys referential integrity and a "who can see form X" query at the
cost of a new table in two dialects and SQL Server's cascade-path rule.

**Q3 — Does a restricted user keep **submit-free read** access to a form's submissions?** Concretely:
User B sees form 2 in the queue — do they also see form 2's 18 submissions, exports and documents?
(I assume yes: the grant is a read grant.)

**Q4 — Default form:** is "no selection when several forms are visible and none is configured" (a
`— Select —` prompt) acceptable, or does the app need a per-user/per-org `default_form_id` in phase 1?
And is `All forms` the right multi-form default for the staff queue?

**Q5 — Should a *new* form be assigned automatically?** Recommended: no for restricted users (sticky
restriction), yes for unrestricted users by definition. Confirm that is the intended product behaviour.

**Q6 — Who can set a grant — admin only, or the organization's own staff?** Recommended admin only, to
match `/admin/forms`.

**Q7 — Do the existing six users need any grant on day one?** Recommended: no — they all stay
unrestricted (NULL), so the only visible change on deploy is the removal of the silent `reportable[0]`
default.

**Q8 — Phase boundary:** ship step (a) (server enforcement) before (b) (admin editor)? Enforcement
without an editor means grants are set by SQL until (b) lands — safe, but say so explicitly rather than
letting the UI imply a control that does not exist yet.

**Q9 — Who is the code for, and does the admin know who they are?** If the set of people is known and
small (6 users today), the Users panel (§10) is smaller, has no shared secret and is fully revocable —
the code is the harder tool for the same outcome. The code wins when accounts cannot be hand-made: 235
schools in the directory with 3 ever used points that way. **Which is it here** — a handful of known
people, or self-onboarding across many schools?

**Q10 — Is the code per *school* or per *person*?** A per-school code (`BROUGHTON-CDM`, multi-use,
capped, expiring) is easy to distribute and matches how a school's staff arrive. A per-person single-use
code is a real invite, gives the strongest audit, and makes revocation meaningful. Per-school is more
practical; per-person is safer. Related: **should the code be reusable across all of a school's people, or
one code per person?**

**Q11 — Does the school dropdown on `/register` disappear?** If a code supplies the school, the public
picker of 235 unverified schools should go (it is today's main weakness). That changes registration for
everyone, including anyone currently using it.

**Q12 — For "the records they are supposed to see", is school-level enough?** A `cdm_contact` code is
narrowed to one school's submissions **by existing code, for free**. A plain `staff` code is *not* — it
sees every submission of the granted forms, org-wide. If a code is meant to restrict records, it must
grant `cdm_contact`. Confirm that is the intended mapping, and that per-*person* record access is handled
by the existing `public_id` link rather than by any matching (§4.10.4).

**Q13 — Revoking a code does not revoke access already granted (§4.10.5).** Is that acceptable, or does
revoking a code need to also revoke the grants it issued? The latter is expressible (the redemption table
knows who used it) but it is a destructive action, so it should be an explicit second button, never a
side effect.
