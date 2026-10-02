# Public and Private Forms — per-form access requests and approval

**Status:** ✅ **Implemented + verified 2026-10-02** — 31 gate tests, 32 live checks, both typechecks
and the client build clean. **Not committed.** All eight questions in §15 are answered (§15.1).
**Four of the answers changed the design**, and each changed passage is marked **⟵ §15 Qn** where it occurs:
Q1 (staff keep access — the predicate and the backfill set), Q3 (in-app only — §10.3), Q5 (a decline is
reversible only by an administrator — §8, §10.1) and Q7 (the decision history is wanted — §5.3).
**Date:** 2026-09-28, **revised 2026-10-02** (the **Available Forms** page — §16; the **production SQL script** — §17).
**Area:** `dbo.forms` visibility · `GET /api/forms` · every form picker and report · Admin → Settings (**Access Requests**) · **a new Available Forms page (§16)** · **a hand-run production SQL script (§17)**
**Related:** [`docs/plans/multiple-forms.md`](./multiple-forms.md) — the earlier, **unshipped** per-user
form-visibility design. This plan is the same problem approached from the other end (a flag on the *form*
plus a request/approval workflow) and it deliberately **supersedes** that plan's storage decision while
inheriting most of its reasoning. Read §4 first if you have read the other one.
[`docs/plans/system-messages.md`](./system-messages.md) — the admin-authoring section in Settings whose
panel shape and `PRIMARY KEY (a, b)` join table this feature reuses.
[`docs/plans/webhook-log.md`](./webhook-log.md) — the precedent for an admin surface that is a *section in
Settings* rather than its own page. [`docs/plans/dual-db.md`](./dual-db.md) §5.3 — the two-dialect rule.
[`docs/plans/restore-archived-submissions-2026-09-24.md`](./restore-archived-submissions-2026-09-24.md) —
the house pattern for a one-time data change.

---

## 1. What was asked

> I need a plan for Public and Private Forms. When someone registers and logs in, they currently see the
> 'CDM submissions' and the results for their school. However, once we add this feature, the person will
> need to 'request' access. Once they do, the admin will receive an message where they can 'approve' or
> 'decline' their request. If the current CDM Form is marked as 'Private', after the feature goes live, all
> persons who currently see the CDM form should retain access. Only new registrants should need to request
> access. Please provide a plan for me to review.

> **Added 2026-10-02:** *"I would like to add a menu item 'Available Forms' that shows all of the forms,
> the ones the user currently has access to and any new forms that they can request access to."*

Restated as five separate problems, because they are:

1. **A form needs a visibility of its own.** Today "which forms can this person see" is a property of the
   *organization* and the *role* — every staff member and every School Contact in an organization sees
   every form in it (§2). Nothing on the form says "this one is not for everyone". The narrowing this
   feature adds is itself **role-shaped** — it applies to School Contacts and to nobody else (§15 Q1,
   §3.1) — which is what makes it small: the audiences it can accidentally cut off are a set of one.
2. **A restricted form needs a way in.** A person who cannot see a private form must be able to *ask*, and
   the ask must be visible somewhere an administrator actually looks.
3. **An administrator needs to answer the ask.** Approve or decline, once, with a record of who did it.
4. **The transition must not lock anyone out.** Whoever can see the CDM form *now* must still see it after
   it is marked Private. Only accounts created *afterwards* should have to request.
5. **A person needs to see what exists — including what they cannot open yet.** ⟵ **added 2026-10-02,
   §16.** Today a `cdm_contact` who cannot see a form has no way to discover that it exists, so the
   "request access" affordance of problem 2 has **nothing to attach to**: the locked panel (§10.1) can
   only name a form the person already knows about. A new **Available Forms** page lists every form in the
   organization in three groups — *mine*, *requestable*, *requested* — which is what turns "you cannot see
   this" from an absence into a screen with a button on it. **This is the discovery half of the feature,
   and without it the request workflow is reachable only by deep link.**

---

## 1.1 ★ Re-measured 2026-10-02 — §2's live numbers were stale

The §2 table below carries its live figures forward from `multiple-forms.md` §2.4 (measured **2026-09-23**)
because the probe could not connect that day. **Re-measured against the live database on 2026-10-02**, and
several values have changed. **The plan's design does not depend on any of them** — but the differences are
worth recording, because two of them change how the feature will *look* on the day it ships:

| Fact | §2 said (2026-09-23) | Measured 2026-10-02 | Why it matters |
|---|---|---|---|
| Forms | 2 | **3** — `#1 Test Form` (draft, `CDM`), `#2 CDM Google Form` (published, `CDM2`), **`#5 Gov School Submissions` (published, `GOVS`)** | ★ **There are now TWO published forms, not one.** §16's Available Forms page is the first screen where a person sees more than one form listed, and §10.1's "the only published form is locked" case is no longer the only locked case. |
| Users in org 1 | 6, of which 3 active (1 admin, 1 staff, 1 cdm_contact) | **6, of which 3 active** (1 admin, 1 staff, **1 `cdm_contact`**) — plus 2 inactive `cdm_contact` and 1 inactive `staff` | Unchanged in shape. The backfill set (§6) is **3 `cdm_contact` accounts** (1 active + 2 inactive), not 1 — §6.4 grants to inactive accounts deliberately. |
| Submissions | 24 (form 1 → 6, form 2 → 18) | **25** (form 1 → 6, form 2 → 18, **form 5 → 1**) | The new form carries one submission. |
| Organizations | not stated | **2** — `academics` (active) and `technology-services` (active) | §16's page is **organization-scoped**, so the second org is the natural control for a cross-tenant leak. |
| `forms.visibility` | absent | **still absent** — 15 columns, none named `visibility` | Confirms §5.1 is greenfield. |
| `form_access` / `form_access_events` | absent | **still absent** — the only `form_*` tables are `form_fields`, `forms`, `user_form_view_columns` | Confirms §5.2/§5.3 are greenfield, and that `user_form_view_columns` is a **different, existing** per-user-per-form table — see §16.4, where it is the precedent for the page's storage shape. |

**★ The load-bearing change is the first row: there are two published forms now.** The original request was
written when "the CDM form" was the only thing anyone could see, which is why §10.1 could describe the
locked state as "the only published form in the organization is locked". With a second published form, a
`cdm_contact` who loses access to `#2` still has `#5` and lands on a **working queue**, not an empty one —
so the locked panel must be reachable from somewhere other than the zero-forms empty state. **§16 is that
somewhere**, which is a second, independent reason the page is needed rather than a nicety.

---

## 2. Current state

| Claim | How it was checked | Result |
|---|---|---|
| There is no per-form visibility anywhere in the server | `grep -nE "form_ids\|form_access\|visibility"` over `server/src/**/*.ts` | **No matches.** Nothing has implemented it. |
| `dbo.forms` has no visibility column | `CREATE TABLE forms` declaration, `server/src/db/schema.ts` | Columns are `id, title, description, school_id, designer_id, status, pre_archive_status, created_at, updated_at, organization_id, doc_folder_id, google_form_url, view_columns, code, submission_seq`. **No visibility flag.** |
| `dbo.users` has no per-user form grant | same file | Columns include `role, school_id, active, show_on_test_screen, must_change_password, organization_id`. **No `form_ids`.** |
| `GET /api/forms` narrows only by organization | `server/src/routes/forms.ts:80` | `listForms(schoolId, req.user!.organization_id)`. The only other narrowing is an optional `?school_id`, and `schoolId` is only read when the caller is an admin. |
| Every signed-in member of an organization sees every published form | `server/src/lib`… i.e. `client/src/lib/forms.ts` `selectableForms` + the route above | The single client filter is `f.status === "published"`. Nothing reads the user. |
| The only "private" concept that exists is `status` | same route + `PATCH /api/forms/:id/status` | `draft` / `published` / `archived` — *draft* and *archived* are hidden from parents and from the pickers, but **no role or user is ever filtered**. |
| Self-registration produces a School Contact with an unverified school | `POST /api/auth/register`, `server/src/routes/auth.ts` | Role is hard-fixed to `cdm_contact`; `school_id` comes from the body's public school picker and is **not verified**. So "every new registrant" means "every new `cdm_contact`". |
| There is no in-app message from a user to an administrator | `grep -nE "mailjet\|nodemailer\|sendEmail"` over `server/src/**/*.ts` | **No matches.** Email is *not* implemented; `docs/plans/mailjet-setup.md` is a plan only. |
| There *is* an outbound administrator alert | `server/src/notify/slack.ts`, used from `routes/submissions.ts`, `routes/users.ts`, `google/docs.ts`, `webhook/intake.ts` | `sendSlackAlert(...)` — fire-and-forget, admin-facing, **a silent no-op when no webhook URL is configured**. This is the existing precedent for "the admin is told". **This plan deliberately does not use it** — §15 Q3 answered *in-app only* (§10.3). |
| `docs/plans/multiple-forms.md` designs this and was never built | the same two greps as rows 1–2, plus a read of that file | The plan is dated 2026-09-23 and headed *"Draft for review — no code written yet"*. Its recommended storage (`dbo.users.form_ids`) **does not exist**. |
| `staff` is **not** school-scoped; `cdm_contact` is | `client/src/pages/RegisterPage.tsx` (the only self-registration form) + `isSchoolScoped` in `server/src/auth.ts` | Self-registration creates a **`cdm_contact`** and nothing else, and `isSchoolScoped(role)` returns true for that role alone. So "new registrants" (§6) *are* "School Contacts", which is the same population §15 Q1 named. |
| Who is affected, in numbers | **carried forward** from `multiple-forms.md` §2.4, measured against the live database on **2026-09-23** | 2 forms (id 2 `CDM Google Form`, `published`, code `CDM2`; id 1 `Test Form`, `draft`, code `CDM`); 6 users in org 1 — **3 active**, of which one is an admin, one a `staff`, one a `cdm_contact`; 24 submissions (form 1 → 6, form 2 → 18). |

> **★ These live numbers are carried forward, not re-measured today.** I wrote a read-only probe for them
> and it could not connect: the Azure SQL Serverless database (`wcpsssqlelasticpool.database.windows.net`)
> did not resume — `ECONNRESET` on the TDS login on **37 consecutive attempts over roughly 22 minutes**,
> while TCP 1433 accepted every connection. That is the documented auto-suspend signature, not a firewall
> or credential fault (a wrong service name gives `ORA`/`Cannot open database`-style errors, a wrong
> password gives a login failure, and a blocked IP gives a timeout rather than a reset). **The counts above
> should be re-measured before anyone acts on them** — but nothing in this plan depends on their exact
> values, only on the shape: *one* published form, *a handful* of internal users, and a set of submissions
> that a grandfathered account must keep seeing.

The shape that matters: **today there is exactly one published form and everyone internal can see it.** The
"audience" of the CDM form is, in effect, "anyone who registers". That is precisely what this feature
changes.

---

## 3. What this feature is — and what it is not

### 3.1 Two halves, named separately

The request mixes two mechanisms. They ship as one, but they are separate code:

- **(A) A visibility flag on the form** — `private` or `public`. `public` means *every internal member of
  the organization sees it, exactly as today*. `private` means *the **School Contacts** (`cdm_contact`) in
  the organization do not see it unless they hold an approved grant*. **Administrators and `staff` are
  unaffected** — they read a private form exactly as they read a public one. ⟵ **§15 Q1**
- **(B) A request / approve / decline workflow** — a person who cannot see a private form can ask for it,
  an admin can answer, and the answer is recorded and reversible.

Either one is useless alone. A flag with no way to grant leaves a private form permanently unreadable; a
request workflow with no flag has nothing to decide about.

**The narrowed audience is exactly one role, and that is the whole risk profile.** Because `staff` and
administrators keep access, a grant row is only ever consulted for a `cdm_contact` — and a `cdm_contact` is
precisely what self-registration creates (the row above in §2). So the set this feature can accidentally cut
off is *the School Contacts of the organization*, which is the same set as "the people who registered
themselves", and the feature is a complete no-op for every other account in the system.

It also means this is a **role carve-out, not a general permission system.** The role is named in exactly
one place — inside `server/src/access/formAccess.ts` (§7.1) — so if a form is ever meant to be hidden from
`staff` as well, that is a one-line change to the predicate; the `form_access` table, the request workflow
and the admin panel do not change at all. **Do not scatter the role test**: a second copy of it is the
"two overlapping gates" failure §13 traplists.

### 3.2 It is **not** a submission gate

The parent path stays completely untouched. `GET /api/forms/public`, `GET /api/forms/:id/public` and
`POST /api/submissions` are **anonymous** and must keep serving a private form's questions to families, and
keep accepting their answers. `multiple-forms.md` §4.6 records why this is load-bearing: an Apps Script is
bound to the form's numeric id and is configured with it, and a form going offline for families because a
staff member's *reading* rights were narrowed would be a catastrophic side effect of a permissions change.

**"Private" is about who may read the results, not about who may submit.** If you meant the other thing —
"only invited families may submit" — say so (§15 Q1), because that is a different feature with a different
threat model (a form URL is public by construction; the bound Apps Script posts to our webhook unauthenticated).

### 3.3 What changes on screen, and for whom

| Surface | Today | After |
|---|---|---|
| `GET /api/forms` (the pickers) | every published form in the org | **only forms the caller may read** |
| Dashboard / staff queue / Reports form selector, viewed as a **`cdm_contact`** | the CDM form | unchanged if they hold a grant; **absent** for a new registrant, who lands on the locked panel (§10.1) |
| The same screens viewed as **`staff`** or **admin** | the CDM form | **unchanged** — the predicate's first disjunct short-circuits for them (⟵ **§15 Q1**) |
| Admin Forms page and designer | every form, all statuses | **unchanged** — admins are unrestricted (§7.4) |
| Parent submission pages | the form | **unchanged** |
| Admin → Settings | no access section | **new "Access Requests" section** with a pending count |

---

## 4. Relationship to `docs/plans/multiple-forms.md`

That plan asked the same question ("which forms may *this person* see") and answered it with a list of form
ids stored on the user — `dbo.users.form_ids NVARCHAR(MAX)`, a JSON array, read and written as
`number[] | null`, where `NULL` means "unrestricted". **This plan replaces that storage decision with a flag
on the form plus a grant table, and keeps almost everything else.** The reasons are in §4.2.

### 4.1 Inherited — do not re-derive

| From `multiple-forms.md` | Still true here |
|---|---|
| §4.3 — the JWT is not the place for a grant: it lives 15 minutes, so *"a stale grant is an annoyance, a stale **revoke** is a leak"* | **Yes.** Read the permission from the database per request. |
| §4.4 — admin stays unrestricted | **Yes**, and §15 Q1 extends the same rule to **`staff`**: an account that administers forms must not be able to lock itself out of one, and here the same argument applies to the role that works across the whole organization. |
| §4.5 — the client hides, it never decides | **Yes.** `selectableForms` stays a status filter; the server is the only place visibility is decided. There must not be two overlapping gates for one feature. |
| §4.6 — the parent path does not narrow | **Yes**, and it is the single most important regression guard (§3.2). |
| §4.7 — *"403 for an action, empty for a list"*, and `canAccessForm` must derive from the same function the list uses | **Yes.** `canAccessSchool` derives from `scopedSchoolId` for exactly this reason, and the new check must derive from the new predicate. |
| §4.8 — the default form: several visible + no configured default ⇒ **no selection**, never a guess from `updated_at` | **Yes**, and it becomes *more* relevant: a new registrant with zero visible forms must land on the intentional empty state, not on `reportable[0]`. |
| §4.9 — no login page per form | **Yes.** |
| §5 — every site that accepts a caller-supplied `form_id` must be audited | **Yes**, and this plan carries a concrete site table (§7.2) plus a test that refuses each one (§12). |
| §7 — schema work lands in **both** dialects | **Yes** (§5.4). |
| §10 — warn, do not block, on a restricted account; a sticky line saying new forms are not assigned automatically | **Yes**, adapted to the approve/decline panel (§10.2). |

### 4.2 Superseded — and why

`multiple-forms.md` §4.1 recommended option **A** (`users.form_ids`) because it was one column instead of a
new table. Two things changed:

1. **The request workflow forces a table anyway.** A pending request must record *who asked, for what, when,
   and who decided* — none of which fits in a JSON array of form ids on the user row. Once
   `form_access_requests` exists, the argument for *also* having a JSON array is gone: two mechanisms for
   one rule is the "two overlapping gates" failure that plan warns about (§4.5) and that this repository has
   already produced twice. One table holds both the request and the grant (§5.2).
2. **A flag on the form keeps the rule expressible as a SQL predicate — a list of ids does not.** This is
   the more interesting reason, and it is worth being concrete, because it decides how much of the app has
   to change:

   With a flag plus a grant row, visibility is:

   ```sql
   f.organization_id = @org
   AND (@role <> 'cdm_contact'                        -- admin / staff read everything (§15 Q1)
        OR f.visibility = 'public'
        OR EXISTS (SELECT 1 FROM dbo.form_access a
                    WHERE a.user_id = @userId AND a.form_id = f.id AND a.status = 'approved'))
   ```

   The role test is the **first** disjunct on purpose: for an admin or a `staff` account it is a constant
   true, so the grant subquery is never evaluated and the common case costs nothing. For a `cdm_contact` it
   is a constant false and the expression reduces to exactly the public-or-granted rule.

   That is **a predicate**, so it drops straight into the existing shared filter reader
   (`submissionFiltersFrom` in `routes/submissions.ts`) and is honoured by the list *and* the archive-counts
   query **at the same time** — which is what keeps the "N archived hidden" badge describing the same query
   as the rows underneath it, a guarantee that code comment exists to protect.

   With `users.form_ids` the same rule can only be applied by *first* loading the caller's array and then
   either (a) string-interpolating a list of ids into every statement on every site — an injection surface
   and a parameter-count explosion, or (b) post-filtering rows in TypeScript, which silently breaks the
   archive counts and every other aggregate computed from the rows.

   **So the flag design is not merely tidier — it composes with the filter reader the app already has.**
   `multiple-forms.md` §4.2's tri-state (`NULL` = all / `[]` = none / `[2]` = one) also disappears, and with
   it that whole hazard: there is no derived filter here that can collapse to *no clause* when the array is
   absent, because the "no clause" case is spelled `visibility = 'public'` and is always emitted.

### 4.3 Explicitly out of scope

`multiple-forms.md` also covered **report views, a per-form default, and registration codes**. Those are not
part of this request. §4.8's default-form rule is inherited because a zero-visible-form state now has a
realistic way to occur, but nothing else from that plan is pulled in.

---

## 5. Data model

### 5.1 `dbo.forms.visibility`

```
visibility NVARCHAR(10) NOT NULL CONSTRAINT DF_forms_visibility DEFAULT 'public'
  CHECK (visibility IN ('public','private'))
```

- **`DEFAULT 'public'` is the whole deploy story.** Every existing form, and every form created by an admin
  who does not touch the field, is public — so shipping the column changes no behaviour for anyone. The
  behaviour change happens when an admin marks a specific form private, at a moment of their choosing (§14).
- SQL Server: a `CHECK` constraint cannot be added to an existing column in the same batch that adds it, and
  a statement that references a just-added column needs its own batch (error 207). So the ladder is three
  statements in three batches: add the column, add the constraint (guarded by its own `OBJECT_ID` check),
  done. The `role` column's CHECK widening in `schema.ts` is the precedent.
- New forms are created by `POST /api/forms`; creation should accept an optional `visibility` and default to
  `'public'`. Creating a form directly private is allowed but must run the same backfill in reverse — i.e.
  it must **not** grant anyone, since there is nobody who "currently sees it" (the form did not exist a
  moment ago). See §6.4.

### 5.2 `dbo.form_access` — one table for the request *and* the grant

```
CREATE TABLE dbo.form_access (
  user_id       INT          NOT NULL,
  form_id       INT          NOT NULL,
  status        NVARCHAR(20) NOT NULL
      CHECK (status IN ('pending','approved','denied')),
  source        NVARCHAR(20) NOT NULL
      CHECK (source IN ('request','backfill','direct')),
  requested_at  DATETIME2    NOT NULL CONSTRAINT DF_form_access_requested DEFAULT SYSUTCDATETIME(),
  decided_at    DATETIME2    NULL,
  decided_by    INT          NULL,
  note          NVARCHAR(400) NULL,
  CONSTRAINT PK_form_access PRIMARY KEY (user_id, form_id)
);
```

Decisions, and the reason for each:

- **One row per `(user, form)`.** The primary key *is* the idempotency mechanism: "request access" twice is
  one row, and approve-then-decline is an update rather than a second row that a careless query would
  double-count. This is exactly the shape of `system_message_dismissals` (`PRIMARY KEY (message_id, user_id)`),
  which exists in this codebase for the same reason.
- **No foreign keys.** Deliberately, matching `system_message_dismissals` and `webhook_events`: a deleted
  user or a deleted form must not be blocked by its access rows, and the rows are removed explicitly when the
  parent goes. It also avoids SQL Server's **one-cascade-path** rule (error 1785), which has already bitten
  this schema twice.
- **`status` carries the lifecycle; `source` records *how* the row came to exist.** `backfill` is the
  grandfathered grant (§6) and must be distinguishable from a grant an admin made deliberately — otherwise
  "why does this person have access?" is unanswerable, which is the whole reason §6 rejects a timestamp rule.
- **`decided_by` / `decided_at` / `note` are the latest decision.** §15 Q5 answered that a decline carries a
  reason and the requester sees it, so `note` is written by the deciding administrator and rendered on the
  locked panel (§10.1). §15 Q6 answered that an approval is revocable; a revocation is written as
  `status = 'denied'` — the state the predicate already understands — with `event = 'revoked'` in the log
  (§5.3), so the *state* stays simple and the *log* says which of the two actually happened.
- **`denied` covers both "declined" and "revoked".** §15 Q6 confirmed that is acceptable. The requester's
  experience is identical — no access, and no self-service way back (§15 Q5) — and the log distinguishes
  them so an administrator can answer "was this refused, or removed after the fact?". The one consequence is
  worth stating plainly: **a revocation cannot be undone by the person it removed**, so an administrator who
  revokes by mistake must grant access again themselves.
- **No index beyond the primary key.** The self-lookup (`a.user_id = @uid AND a.form_id = f.id`) seeks the
  PK in its own column order. The administrator's pending queue is a scan of a table that will hold tens of
  rows. Adding `IX_form_access_form_status` would also oblige a matching entry in `expectedIndexNames()`
  *and* the Turso DDL, because `libsql.test.ts` asserts the two disagree on nothing. **An index on a ten-row
  table is a claim, not a performance fix** — if the queue ever grows, adding one is a one-line change in
  both dialects.
- **The row is the current state; the history lives beside it** (§5.3). §15 Q7 asked for the append-only
  log, so `form_access` stays **one row per `(user, form)`** — which is what keeps the visibility predicate
  a single-row seek (§4.2) — and `form_access_events` records every request, decision and revocation as it
  happens. **The state table is what the predicate reads; the log is what an administrator reads.** Keeping
  them separate is the point: a history cannot be folded into a table whose primary key is "one row per
  person per form".

### 5.3 `dbo.form_access_events` — the append-only decision log  ⟵ **§15 Q7**

§15 Q7 asked for the history, so it is a second table rather than a second column. The split is deliberate:
`form_access` answers *"may this person read this form **now**?"* and is what the predicate reads (§4.2),
while `form_access_events` answers *"who changed this, when, and on whose authority?"* and is **never
consulted by the visibility rule**.

```
CREATE TABLE dbo.form_access_events (
  id          INT IDENTITY(1,1) PRIMARY KEY,
  user_id     INT           NOT NULL,
  form_id     INT           NOT NULL,
  event       NVARCHAR(20)  NOT NULL
      CHECK (event IN ('requested','withdrawn','approved','declined','revoked','backfilled')),
  actor_id    INT           NULL,   -- NULL when the requester acted on their own behalf
  note        NVARCHAR(400) NULL,
  created_at  DATETIME2     NOT NULL CONSTRAINT DF_form_access_events_created DEFAULT SYSUTCDATETIME()
);
```

- **Append-only, and nothing else.** No `UPDATE`, no `DELETE` anywhere in the code. That is the property
  that makes it a log instead of a second copy of the state table — and it means the log can be written on
  the same code path as the state change without any risk of the two disagreeing about history.
- **`actor_id` is nullable on purpose.** It is `NULL` for a self-service request, because nobody *decided*
  anything; every administrator-made decision carries their id. A `NOT NULL` would force a fabricated actor
  onto requests and make "who approved this?" unanswerable in exactly the case where the answer is "the
  requester asked".
- **No foreign keys**, for the same reason as `form_access` (§5.2) and `system_message_dismissals`: rows are
  removed explicitly when a form is deleted (§6.4), and SQL Server's one-cascade-path rule (error 1785) has
  already bitten this schema twice.
- **No index beyond the identity primary key.** Same argument as §5.2 — the only query is "the history of one
  `(user, form)`", which is a scan of a table holding tens of rows, and declaring an index would oblige a
  matching entry in `expectedIndexNames()` *and* the Turso DDL (§12). Adding one later is one line per
  dialect. Note this table is the one that *does* grow without bound, so it is the first place to add one if
  it is ever warranted.
- **Every write goes through one helper** (`recordAccessEvent`, §9) that is called by the same function that
  writes the state row — so no handler can change an answer and forget the log. This is the same instinct as
  §8's single `decide` endpoint: two code paths that must write the same audit line will eventually write it
  differently.

### 5.4 Both dialects, and the timestamp trap

| Dialect | Where | What |
|---|---|---|
| SQL Server | `server/src/db/schema.ts` | `form_access` CREATE inside an `IF OBJECT_ID('dbo.form_access','U') IS NULL` batch; `form_access_events` in a batch of its own; `visibility` via its own `IF COL_LENGTH('dbo.forms','visibility') IS NULL` batch; the CHECK in a third batch. |
| Turso | `server/src/db/dialect/turso.ts` | `TURSO_DDL` gains the final `CREATE TABLE IF NOT EXISTS form_access (…)` **and** `CREATE TABLE IF NOT EXISTS form_access_events (…)`, **and** `visibility` in the `forms` CREATE; `addColumns` gains a `{ table: 'forms', column: 'visibility', definition: "TEXT NOT NULL DEFAULT 'public'" }` entry. Both new tables are brand-new, so they need **no** `addColumns` entry — that list is only for columns added to a table an earlier revision already created. |
| Shared | `server/src/db/client.ts` | `requested_at`, `decided_at` **and `created_at`** **must** be added to `TIMESTAMP_COLUMNS`, or they read back as a `TEXT`/string on Turso and a `Date` on SQL Server and every consumer of the difference breaks. `visibility`, `status` and `event` are strings and must not be added to `BOOLEAN_COLUMNS` or `TIMESTAMP_COLUMNS`. |

**★ SQLite has no `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, and its `ALTER TABLE` cannot add a `CHECK`.**
So on Turso the constraint lives in `TURSO_DDL`'s final `CREATE TABLE` and is *not* retrofitted onto a
database created earlier — the app must therefore validate `visibility` on write as well as trusting the
database. This is the same asymmetry `dual-db.md` §5.3 documents for `pre_archive_status`.

### 5.5 What is deliberately *not* stored

- **Not a school.** The district has **235** schools and only three have ever been used (repo memory,
    `notes.md`). Making access `(form, school)` instead of `(form, user)` would multiply the grant set by the
    school list for no benefit the request asks for. **§15 Q2 answered this: per person.** Note the answer is
    narrower than it looks — because only School Contacts can be locked out (§15 Q1), a `(form, school)` key
    would have had to be `(form, school, role)` to be equivalent, and would still multiply the rows by 235.
- **The restriction is a role; the grant is per person.** §15 Q1 answered that a private form is hidden from
  **School Contacts** and from no one else — so the *restriction* names a role, and it names it in the
  predicate (§7.1), not in this table. §15 Q2 answered **per person** for the *grant*, which is the part that
  has to be stored: "which of the School Contacts at Alston Ridge may read this form" is not answerable from
  a role. Storing a role *here* would have been cheaper and wrong — it would have answered "every School
  Contact sees it", which is exactly the state the feature exists to end. (`multiple-forms.md` §15 Q1 raised
  the same doubt in the other direction and is now settled.)
- **Not on the JWT** (§4.1).

---

## 6. The one-time grandfather — the part the request turns on

> *"If the current CDM Form is marked as 'Private', after the feature goes live, all persons who currently
> see the CDM form should retain access. Only new registrants should need to request access."*

### 6.1 The rule

**The grant is written at the moment a form changes from public to private, and it covers exactly the
accounts that could see it one instant before.** Not "the accounts that existed when the code was deployed"
— the two are only the same if nothing registers in between, and tying access to a deploy timestamp is the
thing §6.3 rejects.

Concretely: the administrator opens the form, sets it to Private, and the same transaction that changes the
flag writes an `approved` / `source = 'backfill'` row for every account that can see that form today and
does not already have a row for it. ⟵ **§15 Q1** That set is exactly the organization's **`cdm_contact`**
accounts: administrators and `staff` keep access by rule and need no row (§3.1), so writing one for them
would create rows that are never consulted.

**This is what makes the promise testable rather than aspirational.** "Every account that can see it one
instant before" has a name for a `cdm_contact` — it is *every active or inactive `cdm_contact` in the
organization* — so check 4 in §12 can assert the whole set rather than a sample of it.

### 6.2 Why the grant is a row and not a rule

Three shapes were considered:

| Shape | Why not |
|---|---|
| **`WHERE u.created_at < <deploy time>`** | Needs a timestamp baked into the source (or frozen into a DDL batch that then cannot be re-run). It leaves **nothing in the data** saying who was grandfathered, so "who can currently read this form?" — the question an administrator will ask the first time something looks wrong — has no answer that comes from the database. It also silently changes meaning on the next public→private flip, and a baked-in timestamp in a startup migration ladder is the exact hazard already recorded for this repo: the ladder runs against whichever database the connection string names, at every boot. |
| **`WHERE u.created_at < f.visibility_changed_at`** | Better, because it is derived and needs no magic constant — but it is still invisible in the data, and it makes a *decline* impossible to express (there is no row to decline against, and the person would still satisfy the predicate). |
| **A `backfill` grant row per user** ✅ | Auditable (`source = 'backfill'`), queryable, individually revocable, and it survives being re-run: the predicate is "no row exists yet", so a person who was **declined** is never re-granted by a later flip. One row per affected account, at a count the live measurement puts in the **single digits**. |

### 6.3 The statement

```sql
INSERT INTO dbo.form_access
  (user_id, form_id, status, source, requested_at, decided_at, decided_by)
SELECT u.id, @formId, 'approved', 'backfill', SYSUTCDATETIME(), SYSUTCDATETIME(), @actorId
  FROM dbo.users u
 WHERE u.organization_id = @orgId
   AND u.role = 'cdm_contact'          -- §15 Q1: admin and staff keep access by rule
   AND NOT EXISTS (
         SELECT 1 FROM dbo.form_access a
          WHERE a.user_id = u.id AND a.form_id = @formId);
```

`INSERT … SELECT … WHERE NOT EXISTS` — deliberately the shape that parses on **both** SQL Server and
SQLite (SQL Server does allow `WHERE` without `FROM` and evaluates the predicate; verified in this repo's
earlier work; it is Oracle/MySQL-family that rejects it). That keeps one statement instead of a
read-then-write loop, and the `NOT EXISTS` is what makes the operation idempotent.

**`u.role = 'cdm_contact'`, not `u.role <> 'admin'`** — the two were equivalent under the old reading of the
feature and are not equivalent now. The role test in the predicate (§7.1) says *admin and staff are
unrestricted*; a backfill written as "everybody who is not an admin" would grant rows to `staff` accounts,
and those rows would sit in the table looking like decisions while the predicate never reads them. Writing
the grant set as the **complement of the predicate's exemption** is the one form of this statement that
cannot drift out of step with it, so the two must be changed together if they ever change at all (§13,
trap 12).

The same transaction writes one `backfilled` row per inserted user into `form_access_events` (§5.3) with
`actor_id = @actorId` — the administrator who flipped the flag — so a grandfathered grant and the reason for
it arrive together and neither can exist without the other.

### 6.4 The edges, decided

| Case | Decision | Why |
|---|---|---|
| An account with an existing **`denied`** row | **Not** touched | A decline is a decision. Re-granting it because the form was flipped private again would silently reverse an administrator's answer, and nothing on screen would say so. **A revoked grant is also a `denied` row (§5.2), so it is protected by the same rule** — which is exactly what makes a revocation stick across a re-privatisation (§12, check 5). |
| An account with an existing **`pending`** row | **Not** touched | They are already asking; a second row cannot exist under the PK, and granting would pre-empt the decision. |
| **Admins and `staff`** | Skipped | Both are unrestricted by rule (§15 Q1, §7.4). Writing rows for them would create rows that are never consulted, which is worse than no rows — it makes "who has access?" noisy **and** makes the grant table disagree with the predicate about why each row exists. |
| **Inactive** accounts (`active = 0`) | **Granted** | They were eligible a moment before; `active = 0` already prevents signing in, so the grant is inert until they return. Skipping them means an account disabled for a week and re-enabled later is silently locked out of what it had — a support ticket nobody will connect to a permissions change. |
| A form created **already private** | No backfill | There is nobody who "currently sees it" — it did not exist. The `previous visibility` must be read before the update, and the backfill only runs on `public → private` (or on a form that predates the column, which is the same case under `DEFAULT 'public'`). |
| Private → **public** | No data change | `visibility = 'public'` makes the grants irrelevant without deleting them, so a later re-privatisation finds the same decisions in place. This is the property that makes the feature reversible. |
| An admin **deletes the form** | Grants deleted with it | The table has no FK, so this must be explicit in `deleteForm` alongside the existing cascade work. Flagged as a to-do in §11 rather than assumed. |

### 6.5 The failure mode being designed out

If the deploy is what grants access — "everybody who existed at deploy time is grandfathered" — then the
promise "all persons who currently see the CDM form should retain access" is a promise about a **moment
nobody recorded**. Two weeks later, when someone asks *"did Maria have access before, or did she get it by
asking?"*, there is no row to read and no way to reconstruct the answer. Binding the grandfather to the
**privatisation event** instead makes it a row with a timestamp and an actor, and makes the promise
testable (§12).

---

## 7. Enforcement

### 7.1 One predicate, two callers

A new module — `server/src/access/formAccess.ts` — holds the entire visibility rule:

```ts
/**
 * The one place "may this person read this form?" is written down.
 *
 * The viewer's ROLE is part of the signature because the rule is role-shaped (§15 Q1):
 * an `admin` or a `staff` account reads every form in its organization and never consults
 * the grant table; a `cdm_contact` reads a private form only with an approved grant.
 *
 * Naming the role HERE — and nowhere else — is what keeps "this form is hidden from staff
 * as well" a one-line change if it is ever asked for. A second copy of this test elsewhere
 * is the "two overlapping gates" failure §13 traplists.
 */
export function formVisibilityPredicate(
  viewer: { userId: number; role: Role },
  formAlias = "f"
): { sql: string; params: Record<string, unknown> }

/** The list form: used by every query that returns forms or rows. */
export function listFormsVisibleTo(viewer, organizationId, schoolId?): Promise<Form[]>

/** The single-row form: MUST call the same predicate — see multiple-forms.md §4.7. */
export async function canAccessForm(viewer, formId): Promise<boolean>
```

`canAccessForm` is written as the predicate applied to one id, not as an independent query, for the reason
`auth.ts` already documents for `canAccessSchool`: *"a row that appears in the list can never 403 on open."*
If the two are ever written separately they will disagree, and the symptom is a submission the grid shows
and the detail page refuses.

The predicate **narrows**: it is `AND`-ed onto the organization filter, never substituted for it. A grant
must never be able to widen a query — `multiple-forms.md` §4.2 names this as one of two hazards, and it is
the one that leaks data.

### 7.2 Every site that has to change

| File · site | Today | Change |
|---|---|---|
| `routes/forms.ts` · `GET /` | org filter only | apply the predicate; **this is the only visibility decision** |
| `routes/forms.ts` · `GET /:id`, `POST /`, `PUT /:id`, `PATCH /:id/status`, `DELETE /:id` | admin only | **unchanged** — admins unrestricted |
| `routes/forms.ts` · `GET /:id/columns` | staff/cdm_contact/admin | `canAccessForm` → 403 |
| `routes/forms.ts` · **new** `PATCH /:id/visibility` | — | admin; runs the backfill on `public → private` (§6) |
| `routes/submissions.ts` · `submissionFiltersFrom` | org + school + form | gains `viewer`, so **the list and `GET /archive/counts` narrow together** |
| `routes/submissions.ts` · `GET /:publicId` | org + school | `canAccessForm(req.user!, row.form_id)` → 403 |
| `routes/submissions.ts` · `PATCH /:publicId/status`, `POST …/archive`, `POST …/restore`, `PUT …/values`, adhoc GET/POST/PUT/DELETE, `GET …/documents` | org + school | `canAccessForm` → 403. `PUT …/values` is the staff-edit write path, so this one is the meaningful one. |
| `routes/submissions.ts` · `DELETE /:publicId` | admin only | **unchanged** |
| `routes/submissions.ts` · `POST /`, `GET /:publicId/public` | anonymous | **unchanged** — parents (§3.2) |
| `routes/export.ts` · `GET /preview`, `GET /csv` | staff/cdm_contact/admin | apply the predicate (both take a `form_id`) |
| `routes/reports.ts` · `GET /preview`, `GET /export` | staff/cdm_contact/admin | apply the predicate |
| `routes/reports.ts` · `GET /views` | per-user saved views | filter out views naming a form the caller cannot open — otherwise the Reports selector offers a view it will then refuse to run. `PUT/POST/DELETE /views` reject a locked `form_id`. |
| `routes/documents.ts` · `GET /` | joins submissions | apply the predicate through the submission → form join |
| `routes/documents.ts` · `GET /:id/pdf` | staff/cdm_contact/admin | `canAccessForm` on the document's submission's form |
| `routes/webhook*.ts`, `routes/inventory.ts` | admin / webhook secret | **unchanged** |
| `routes/users.ts` · all three hand-built DTOs | admin | **unchanged**, unless the Users panel grows an access column (§10.2) — note `multiple-forms.md` §5 warns that a field added to only one of the three DTOs *"saves but never displays"* |
| `routes/formAccess.ts` · **new** | — | the request/approve/decline surface (§8) |

### 7.3 Refusal style

Inherited verbatim from `multiple-forms.md` §4.7, because it is the reason a locked row cannot look like an
empty table:

- **An action on a thing you may not read → `403`** with a message naming the form (`"Forbidden: no access
  to this form"`), matching `"Forbidden: submission belongs to another school"`.
- **A list you may not read from → an empty list**, not a 403. A `403` on `GET /api/submissions` would be a
  page-level error for a state the page is designed to explain.

### 7.4 The invariants

1. **Admin and `staff` are unrestricted**, by rule, in the predicate — not by a grant row (§15 Q1). The rule
   names **roles**, never a list of accounts, so it cannot be broken by registering a new user.
2. **A grant narrows, never widens.** The predicate is `AND`-ed.
3. **The parent path never narrows.** A private form still serves its questions and still accepts answers.
4. **The history is never the source of truth.** `form_access_events` may say anything; the predicate reads
   `form_access` alone (§5.3). If the two ever disagree, the state table wins and the log is the bug.

---

## 8. API surface

New router `server/src/routes/formAccess.ts`, mounted in `server/src/index.ts` beside
`systemMessagesRouter`.

| Method · path | Auth | Purpose |
|---|---|---|
| `GET /api/form-access/mine` | staff · cdm_contact · admin | The private forms in my organization that I **cannot** read, each with my status: `none` · `pending` · `denied`, plus `last_event` so the panel can say *"declined"* or *"access removed"* (§5.2, §10.1). **This is what makes "request access" possible** — without it a restricted user cannot even name what they are asking for, and the empty state would have nothing to offer. **Returns `[]` for an admin or a `staff` account**, which is the honest answer rather than a special case: nothing is locked to them (§15 Q1). |
| `POST /api/form-access/requests` | staff · cdm_contact · admin | `{ form_id }` → my row becomes `pending`; writes the `requested` event. Idempotent for a row already `pending`. **Refuses (400)** a form that is `public` (there is nothing to request) or that I can already read (a grant I already hold, or a role exemption). **Refuses a row in `denied`** ⟵ **§15 Q5** — see below. |
| `POST /api/form-access/requests/withdraw` | staff · cdm_contact · admin | `{ form_id }` → my own `pending` row is removed and a `withdrawn` event is written. **Refuses anything not `pending`.** Withdrawal cannot change anyone's access — it deletes an unanswered question — which is why it is the one self-service action that survives §15 Q5. |
| `GET /api/form-access/requests` | admin | The queue, `?status=pending` by default, oldest first, joined to `users` for the name/e-mail and to `forms` for the title. |
| `POST /api/form-access/requests/decide` | admin | `{ user_id, form_id, decision: "approve" \| "decline" \| "revoke", note? }`. Writes `decided_at` / `decided_by` and the matching event (`approved` / `declined` / `revoked`). **One endpoint with a `decision` field rather than three routes**, so the state change and its audit row cannot be written differently by different handlers — and **`revoke` is included here rather than being its own endpoint** for the same reason: a revocation is a decision on an approved row, not a different kind of operation. ⟵ **§15 Q6** |
| `GET /api/form-access/grants?form_id=N` | admin | Which accounts hold a grant on this form, each with its **event history** (§5.3), so "who can read this, and why do they?" is one screen. This is what makes §15 Q7 visible and makes §15 Q6 usable — a revoke control needs a list to revoke from. |
| `PATCH /api/forms/:id/visibility` | admin | `{ visibility }` — the flag, and the backfill on `public → private`. |

**A dedicated `PATCH …/visibility` rather than a field on `PUT /api/forms/:id`,** for two reasons: `PUT
/:id` uses `Object.prototype.hasOwnProperty.call(parsed.data, key)` to tell "absent" from "clear", so an
optional visibility on it would be a third state in an endpoint that already has two; and switching to
private has a **side effect on rows in a different table**, which deserves its own endpoint and its own test
rather than riding along on a form-editing call.

**Why `POST /requests` refuses a `denied` row** ⟵ **§15 Q5.** §15 Q5 answered that a decline is reversible
only by an administrator, so a `denied` row must not be reopenable by the person it refused. The refusal is
the *whole* of that answer in code — if the upsert simply set `status = 'pending'` for any existing row, a
declined requester could re-ask by pressing a button, and the administrator's decline would mean nothing.
This is also why the state table needs a `denied` state at all rather than deleting the row on a decline: a
deleted row and a never-asked row are indistinguishable, and the difference is the administrator's decision.

**All seven routes must be added to `server/src/routes/inventory.ts` *and* `server/src/swagger.ts`.** That
file's own comment is explicit: *"the test fails if you add a route in one place without updating the
others."* Note the `auth` vocabulary in the inventory is `none | cookie | secret | staff | admin` — a route
open to staff, School Contacts *and* admins is labelled `staff`.

**★ That is seven on THIS router. §16.4 adds an eighth route overall** (`GET /api/forms/available`, on the
*forms* router) — so the total to register in §11 is **8**, and §12's structural check counts them together.
The two are counted separately here because they are mounted separately; a single "8 routes" in §8 would
read as though `form-access` had eight.

---

## 9. Server functions

`server/src/db/queries.ts` (or a new `server/src/db/formAccess.ts` if it grows past a screen):

| Function | Notes |
|---|---|
| `listLockedFormsFor(user)` | For `GET /form-access/mine`: private forms ∖ visible forms, with the caller's status **and its latest event** (so the panel can distinguish *"declined"* from *"access removed"* — both are `denied`, §5.2). Returns `[]` for a role the predicate exempts, without a special case: the set difference is genuinely empty. |
| `requestFormAccess(user, formId)` | Insert `pending` + the `requested` event, in one transaction. Idempotent for a row already `pending` (and for one already `approved` — it returns "you can read it" rather than writing anything). **Throws a `BAD_REQUEST` for a `denied` row** ⟵ **§15 Q5**; the handler turns the two refusals into different messages (*"already declined"* vs *"you can already read this form"*) because they are different facts. |
| `withdrawAccessRequest(user, formId)` | Deletes the caller's own row **only if it is `pending`**, and writes the `withdrawn` event. Nothing else may call it — the `user_id` comes from the session, never from the body. |
| `decideFormAccess({ userId, formId, decision, actorId, note })` | `approve` → `approved` + `approved` event; `decline` → `denied` + `declined` event; **`revoke`** → `denied` + `revoked` event ⟵ **§15 Q6**. All three stamp `decided_at` / `decided_by`. The event is written by `recordAccessEvent` **inside the same transaction**, never after it. |
| `recordAccessEvent({ userId, formId, event, actorId, note })` | **The only writer of `form_access_events`** (§5.3). Takes the caller's transaction handle, so the state change and its audit row commit or fail together. `actor_id` is `null` when the requester acted for themselves. |
| `setFormVisibility(formId, orgId, visibility, actorId)` | Reads the previous value **first**, updates, and on `public → private` runs the backfill of §6.3 **plus one `backfilled` event per inserted user**. Returns `{ form, granted: n }` so the admin's confirmation can say how many accounts were grandfathered — a number that will otherwise be guessed at. |
| `countPendingAccessRequests(organizationId)` | For the Settings section title (§10.2). **Do not** describe this as feeding an "administrator alert" — §15 Q3 answered in-app only (§10.3); the count *is* the notification. |
| `listFormAccessFor(organizationId)` | For the panel's table. |
| `listAccessGrantsFor(formId)` | For `GET /form-access/grants`: each account with a grant, joined to `users`, each with its event history from `form_access_events` (§5.3). **Include the people with no row**: a `denied` requester is exactly who an administrator is looking for when they open this screen, and a grants-only list is the shape that hides them. |

`server/src/schemas.ts` gains the Zod bodies (`requestAccessSchema`, `withdrawAccessSchema`,
`decideAccessSchema`, `setVisibilitySchema`). The `decision` enum is `["approve","decline","revoke"]` and
the `event` values are written **by the server**, never accepted from the body — a caller must not be able to
label their own action in the audit log. **Keep the blanket bounds looser than any per-value rule**, per this
repo's recorded trap: a `.max()` derived from the widest member of a set makes every narrower business rule
unreachable, because the schema always speaks first.

---

## 10. Client

### 10.1 The locked state *is* the feature

The most likely way to get this wrong is to let a restricted user see an **empty grid**. An empty grid says
"there is nothing here"; the truth is "there is something here and you are not in it". Those need different
words, and only one of them is an invitation.

A new component (say `components/LockedFormPanel.tsx`) renders three states and is used by the staff queue
and the Reports page:

| State | What it says |
|---|---|
| `none` | *"**#2 CDM Non-Traditional** is a private form. Ask an administrator for access."* + **Request access** |
| `pending` | *"Your request was sent on 28 Sep 2026. An administrator has not answered yet."* + **Withdraw request** (allowed — §8; it deletes an unanswered question and changes nobody's access) |
| `denied` | *"Your request was declined on 28 Sep 2026."* — or *"Your access to this form was removed on 28 Sep 2026."* when the latest event is `revoked` (§5.3) — + the `note` if there is one + **\"This has to be changed by an administrator.\"** ⟵ **§15 Q5**: **there is no self-service way back**, so the panel offers none. A **Ask again** button here would be a control that the API refuses (§8), which is worse than no control. |

Where it appears:

- **The dashboard / staff queue** when the only published form in the organization is locked — i.e. the new
  registrant's first screen. This replaces the `reportable[0]` guess (`multiple-forms.md` §4.8): *zero
  visible forms must produce the intentional empty state, never a form chosen from `updated_at`.*
- **`/reports?form_id=N`** with a locked `N` (§13, trap 5).
- **A stale `report_views` row** naming a locked form — `GET /api/reports/views` must not offer it (§7.2).

### 10.2 Admin: **Access Requests**, a section in Settings

There is no admin navigation to extend: `client/src/components/layout.tsx` has exactly five admin links
(Dashboard, Documents, Forms, Reports, Settings) and everything else — Webhook Log, System Messages, Slack,
Organizations, Schools — is a `CollapsibleSection` inside `AdminSettings.tsx`. **So this is a new
`CollapsibleSection title="Access Requests"`** placed directly after System Messages.

Contents:

- **The title carries the pending count** (`Access Requests (2 pending)`), because the section is closed by
  default and a count inside a closed section is invisible. `CollapsibleSection` already takes
  `title` / `subtitle`, so this needs a `title` that is a node or a `badge` prop — a small, contained change.
- **The queue table**: requester (name + e-mail), their school, the form, when they asked, and
  **Approve** / **Decline** buttons. `client/src/pages/admin/AdminSettings.tsx` already renders a users
  table with `title="Edit user"` rows; match it.
- **A revoke control, and the list of who has access** ⟵ **§15 Q6.** A second table below the queue — *who
  can read this form right now* — with a **Revoke** button per row, fed by `GET /api/form-access/grants`
  (§8). *Decide-then-forget* stops being a complete design the moment an approval is revocable: without a
  list of the people holding a grant, a revoke control has nothing to act on, and the only way to undo a
  mistake would be to make the whole form public.
- **The history is shown, not merely kept** ⟵ **§15 Q7.** Each row expands to its `form_access_events`
  timeline (*requested 28 Sep · approved 29 Sep by Kevin*). This is what makes *"declined"* and *"access
  removed"* distinguishable on the requester's own panel (§10.1), and it is the only place an administrator
  can answer *"who changed this, and when?"*. The events arrive on the same call — no extra route.
- **Approving is the only thing that grants access.** The confirmation states it, and says the count of
  grandfathered accounts when a form was just switched to private (§9) — a number that, if it is wrong, is
  wrong in the direction of locking someone out, and so is worth showing.
- **The form's own visibility control** lives on the Forms page / designer (where a form is edited), not
  here. This section answers requests; it does not decide policy.
- **Warn, do not block** when the last reader is being removed, and keep a sticky line on the form saying
  *"new accounts are not granted access automatically while this form is private"* — the adaptation of
  `multiple-forms.md` §10.

### 10.3 "The admin will receive a message" — in-app only  ⟵ **§15 Q3**

The request says the admin *receives a message*. §15 Q3 answered **in-app only, for now**, so there is
exactly one thing to build and the two other candidates are recorded as **not built**:

| Mechanism | Exists? | Verdict |
|---|---|---|
| **The in-app queue** (the Settings section above) | **No** — new | **This is the system of record and the only channel.** A request is "received" in the sense that it is waiting in the section, whose title carries the count (§10.2). |
| **E-mail** | **No** — `docs/plans/mailjet-setup.md` is a plan and there is no mail dependency anywhere in `server/src` | **Not built.** It would also need an address to send *to* per administrator, and this schema stores none. |
| **Slack alert** (`sendSlackAlert`) | **Yes** — fire-and-forget, already used for new submissions, document creation, webhook failures and password resets | **Deliberately not used.** It is the obvious candidate and it is one line — which is exactly why the decision is recorded rather than left implicit. Its own weakness as a *sole* channel is worth noting anyway: it is **a silent no-op when no webhook URL is configured**, so an alert that is the entire notification can be no notification at all. |

**What this answer costs, stated plainly.** Nothing pushes. An administrator learns about a request when they
open Settings, so the feature's responsiveness rests on (a) the count being rendered on the **closed**
section title and (b) somebody looking. The requester's side has the same shape: they learn the outcome when
they next open the form and the locked panel says so (§10.1). Since §15 Q1 keeps staff and admins inside the
form, the people most likely to notice a waiting requester are already able to read it.

Three consequences to keep when this is built:

- **The count on the section title is load-bearing, not decorative** (§10.2). With no push channel, a count
  rendered only inside an *open* section is a count nobody sees.
- **Adding Slack later is additive** — §15 Q3's "flip later" means a one-line call in `requestFormAccess`,
  with no schema change and no endpoint change. **Do not build a notification abstraction to prepare for
  it.**
- **If Slack is added later**, note its incoming-webhook format cannot carry interactive buttons, so an
  "approve from Slack" flow would need a bot app with an interactivity endpoint — out of scope either way.
  The alert links to Settings.

---

## 11. File-by-file change table

| File | Change |
|---|---|
| `server/src/db/schema.ts` | `visibility` on `forms` (own batch) + CHECK (own batch); `form_access` table (own batch); **`form_access_events` table (own batch)**; `Form` type gains `visibility` |
| `server/src/db/dialect/turso.ts` | `visibility` in the `forms` CREATE + an `addColumns` entry; `form_access` **and `form_access_events`** CREATEs in `TURSO_DDL` (both brand-new, so neither needs an `addColumns` entry) |
| `server/src/db/client.ts` | `requested_at`, `decided_at`, **`created_at`** → `TIMESTAMP_COLUMNS` |
| `server/src/access/formAccess.ts` | **new** — the predicate, `canAccessForm`, `listFormsVisibleTo` |
| `server/src/db/formAccess.ts` | **new** — `listLockedFormsFor`, `requestFormAccess`, `withdrawAccessRequest`, `decideFormAccess`, `recordAccessEvent`, `setFormVisibility`, `countPendingAccessRequests`, `listFormAccessFor`, `listAccessGrantsFor` |
| `server/src/db/queries.ts` | `listForms` gains the viewer + predicate; `listSubmissions` / `submissionArchiveCounts` apply it from the filter object; `deleteForm` also deletes **both** `form_access` and `form_access_events` rows for the form |
| `server/src/routes/formAccess.ts` | **new** router (**7 routes** — §8) |
| `server/src/routes/forms.ts` | predicate on `GET /`; `canAccessForm` on `GET /:id/columns`; new `PATCH /:id/visibility` |
| `server/src/routes/submissions.ts` | `submissionFiltersFrom` carries the viewer; row routes gain `canAccessForm` |
| `server/src/routes/export.ts`, `routes/reports.ts`, `routes/documents.ts` | predicate / `canAccessForm` (§7.2) |
| `server/src/schemas.ts` | **four** Zod bodies (`requestAccessSchema`, `withdrawAccessSchema`, `decideAccessSchema`, `setVisibilitySchema`) |
| `server/src/routes/inventory.ts`, `server/src/swagger.ts` | register the **8** new routes — the **7** on `form-access` (§8) **plus** `GET /api/forms/available` (§16.4) |
| `server/src/index.ts` | mount `/api/form-access` |
| `server/src/notify/slack.ts` | **no change** — and deliberately **not reused** by this feature (§10.3, §15 Q3). Listed here so a reader does not assume it is wired in |
| `client/src/lib/api.ts`, `client/src/types/index.ts` | the new calls and types |
| `client/src/components/LockedFormPanel.tsx` | **new** — three states, no self-service re-request after a decline (§10.1) |
| `client/src/pages/staff/*`, `pages/reports/*` | render the locked state; remove the `reportable[0]` guess |
| `client/src/pages/admin/AdminSettings.tsx` | the **Access Requests** section: the queue, the **access list with Revoke**, and the per-row event history |
| `client/src/pages/admin/AdminFormDesigner.tsx` (or the Forms page) | the visibility control |
| `server/src/db/form-access.test.ts` | **new** (suite, §12) |
| `docs/plans/public-private-forms.md` §17 | **the production SQL script** — run by hand against `wcpsssqlelasticpool` / `wcpss-google-forms` **before** the code is swapped in |
| `client/src/pages/forms/AvailableForms.tsx` | **new** — the Available Forms page (§16.5) |
| `client/src/App.tsx` | the `/staff/forms` route under `roles={["staff","cdm_contact","admin"]}` (§16.5) |
| `client/src/components/layout.tsx` | the **Available Forms** sidebar item in both nav blocks (§16.5) |
| `client/src/lib/settings.ts` **and** `server/src/routes/settings.ts` | `available_forms` added to `MENU_ITEMS` **and** `MENU_ITEM_KEYS` — **both**, or the Settings toggle cannot see it (§16.5) |
| `server/src/routes/forms.ts` | **`GET /available`** — the discovery read (§16.4) |
| `server/src/db/formAccess.ts` | `listAvailableFormsFor(viewer, organizationId)` — reuses `listLockedFormsFor`'s join (§16.4) |

---

## 12. Verification plan

Suite `server/src/db/form-access.test.ts`, in the shape of `system-messages.test.ts` (which also asserts the
mount line in `index.ts` — worth copying, since a router that exists but is not mounted answers 404 and
looks like a client bug).

Structural checks:

- `form_access` **and `form_access_events`** exist in **both** dialects and their column sets are identical.
- `requested_at` / `decided_at` / **`created_at`** are in `TIMESTAMP_COLUMNS`; `visibility` / `status` /
  `event` are in neither `TIMESTAMP_COLUMNS` nor `BOOLEAN_COLUMNS`.
- The **seven** routes are in `inventory.ts` **and** `swagger.ts` (the existing coverage test does this).
- `index.ts` mounts `/api/form-access`.
- `expectedIndexNames()` still matches the Turso index set — i.e. we added no index anywhere (§5.2). This is
  safe **because of how that function reads our DDL**, not because of a promise: it parses
  `CREATE [UNIQUE] INDEX` statements only, and both new tables are declared with an inline
  `PRIMARY KEY` constraint, which contributes no name to that set. **That makes it a claim about the
  reader** — if either table ever gains a real `CREATE INDEX`, this check must gain the name with it.

Behavioural checks, each with the *negative* it depends on:

1. **A public form is readable by an account with no grant** — the control that proves the feature has not
   simply locked everything.
2. **A private form is invisible to that same account**: `GET /api/forms` omits it, `GET /api/submissions?form_id=` returns `[]` (an **empty list, not a 403**), and `GET /api/submissions/:publicId` for one of its rows returns **403**. If this check ever starts passing as a non-empty list, the message must say what that means: *the predicate stopped being applied, and the form is readable by everyone.*
3. **`GET /api/forms/public` still returns the private form, and `POST /api/submissions` still accepts an
   answer for it.** This is the §3.2 regression guard, and it is the one a future "tighten the permissions"
   change is most likely to break.
4. **The grandfather, measured:** flip a form to private, then assert that every **`cdm_contact`** in the
   organization has exactly one `approved`/`backfill` row **and** a `backfilled` event, and that each of
   them still sees the form. Then **register a new account and assert it does *not*** — the second half is
   the half the request is really about, and the two halves must be asserted in the same test or a bug that
   grants to *everyone* passes. ⟵ **§15 Q1**: the assertion is over `role = 'cdm_contact'`, **not** over
   "every non-admin" — `staff` accounts are deliberately excluded from the backfill (§6.3), so a
   non-admin-shaped assertion would fail on the design working as intended.
   **Add the mirror check:** an `admin` and a `staff` account see the private form **and hold no row at
   all**, which is what proves the role exemption is doing the work rather than the backfill.
5. **A decision survives a re-privatisation:** decline a user, flip the form public and back to private, and
   assert the user still has **no** grant (`source='backfill'` must not overwrite a decision). **Then repeat
   it with a `revoke`** — a revoked grant is also a `denied` row (§5.2), so the same protection has to
   hold, and this is the check that would otherwise let a revocation quietly undo itself on the next flip.
   **Then assert the refused re-request:** `POST /api/form-access/requests` for that user returns 400 and the
   row is still `denied` — the code path §15 Q5 answered.
6. **`setFormVisibility` returns a granted count equal to the number of newly inserted rows** — asserting the
   count against `COUNT(*)` of `source='backfill'` rows rather than against a number the response computed
   from the same insert.
7. **A locked `form_id` on every site in §7.2 that accepts one refuses.** Enumerate the routes in the test
   and call each without a grant; a list that only checks `GET /api/submissions` is exactly the
   "reachability is not correctness" trap this repo has recorded twice.
8. **Every state change writes exactly one event, written by the one writer.** Walk a request → approve →
   revoke cycle and assert `form_access_events` holds exactly `requested`, `approved`, `revoked` in that
   order with the right `actor_id` (the requester for `requested`; the administrator for the rest), and that
   the state row's `status` matches the **last** event. **Then attempt a re-request and assert the log is
   still exactly three rows** — a refused request that nonetheless records itself would put an event in the
   history that never happened. A test asserting only the state table passes just as well when the log is
   empty; the assertion has to read the log directly.

A deliberately **failing control** must be present: a request to `PATCH /api/forms/:id/visibility` as a
`cdm_contact` (expect 403), a `GET /api/form-access/requests` as a `cdm_contact` (expect 403), and a
`POST /api/form-access/requests/decide` with `decision: "revoke"` as a `cdm_contact` (expect 403) — the
revoke path is the newest and the one most likely to be guarded by nothing. Without a control that is
guaranteed to fail, a green suite cannot be distinguished from a harness that swallows everything.

---

## 13. Traps this feature is specifically exposed to

1. **A grant must narrow, never widen.** `AND` it onto the organization filter. A predicate substituted
   *for* the org filter, or an `OR` written in the wrong place, silently returns another tenant's rows —
   and it will look like it works, because the caller's own rows are in there too.
2. **Locked must not render as empty.** A grid with no rows and a grid the user may not read are the same
   pixel state and different facts. §10.1.
3. **Two overlapping gates for one feature.** `selectableForms` (client) must stay a *status* filter; the
   server remains the only visibility decision. This repository has produced this bug twice
   (`multiple-forms.md` §4.5).
4. **The JWT is not the source.** A grant in the token leaks for the life of the token after a revoke
   (§4.1).
5. **Deep links and saved state.** `/reports?form_id=N`, a `report_views` row, a bookmarked
   `/staff/:publicId`, a browser tab left open across a revoke. Each must land on the locked panel or a 403,
   never a blank table.
6. **`submissionFiltersFrom` is shared with the archive counts.** Adding the predicate in only the list
   handler leaves the "N archived hidden" badge describing a query the grid no longer runs — the exact
   drift that comment exists to prevent.
7. **SQL Server batch rules.** A statement referencing `visibility` needs its own batch (error 207); a
   `CHECK` cannot be added in the same batch as its column.
8. **`TIMESTAMP_COLUMNS`.** Omit it and `decided_at` is a string on Turso and a `Date` on SQL Server; the
   `libsql.test.ts` guard enforces the pairing, but only if the column is declared in both dialects.
9. **`tsx watch` does not watch `.env`**, and the backend's dev server must be restarted by hand after a
   configuration change.
10. **Do not hand-copy the §7.2 site list into a comment as the enforcement mechanism.** This repo has a
    recorded incident where a hand-maintained allowlist drifted two entries behind the DDL and *nothing*
    reminded anyone, because the comment saying "keep this in step" does nothing. The list is useful as
    documentation; check 7 in §12 is what makes it true.
11. **Idempotency of the backfill is the `NOT EXISTS`, not the guard around the batch.** A backfill written
    as an unguarded `INSERT … SELECT` without `NOT EXISTS` runs again on every boot of the migration ladder
    and, under the PK, fails the second time with a duplicate-key error on a startup path.
12. **The backfill's role test and the predicate's role test are the same rule written twice.** §6.3 writes
    the grant set as the complement of the predicate's exemption (`role = 'cdm_contact'` against
    `role <> 'cdm_contact'`). If a future request hides a form from `staff` as well, changing only the
    predicate leaves the backfill granting rows to `staff` — rows that are silently never consulted, which
    is the failure mode that *looks* like working. **Change both in the same commit**, and let check 4 in
    §12 be what reminds you: its mirror half asserts that a `staff` account holds no row.
13. **A decline and a revocation must not be reachable from the requester's side.** §15 Q5/Q6 make both
    final. The two places that can break it are `POST /requests` (which must **refuse** a `denied` row
    rather than upsert over it) and any client rendering an "ask again" affordance (§10.1). **A UI control
    the API refuses is worse than no control** — it reads as a bug in the feature rather than the policy it
    is.
14. **Write the event in the same transaction as the state change, or the log lies.** `recordAccessEvent`
    takes the caller's transaction handle. An event written after the state update (or in a `finally`)
    leaves a window where the state has changed and the audit line does not exist — and because `denied`
    covers both *declined* and *revoked*, the log is the **only** thing that can tell those two apart
    afterwards. The reverse ordering is no better: an event written first leaves a log entry for a decision
    the database then refused.
15. **`source = 'backfill'` must never be read as "this person consented".** It records *how* the row
    arrived, not a preference. Any future "notify everyone who has a grant" feature that treats a backfilled
    row as an opt-in will message people who never asked. Q7's log is what makes the distinction visible:
    `event = 'backfilled'` with an administrator as `actor_id`, against `event = 'requested'` with a null
    one.

---

## 14. Deploy order

Three steps, each independently reversible, and the behaviour change happens in the third — which is a
decision you make with the feature already live, not something the deploy does to you.

1. **Ship the schema and the flag.** `visibility` defaults to `public`; `form_access` and
   `form_access_events` are created empty. *Nothing changes for anyone, including parents and the webhook.*
   Verify `dbReady` and that `GET /api/forms` returns the same forms as the day before.
2. **Ship the workflow.** The Settings section, the locked panel, the **seven** routes, the decision log.
   Still nothing changes: no form is private, so no one is locked and no one can request anything, and the
   log stays empty. Verify by creating a throwaway private form, requesting access as a test account,
   approving it, **revoking it**, then deleting the throwaway form — one pass through every state the
   locked panel and the admin section can render. **No Slack alert is wired** (§15 Q3).
3. **Mark the CDM form Private.** At that instant the backfill grants every **`cdm_contact`** in the
   organization that can currently see it — and no one else, since administrators and `staff` keep access by
   rule (§15 Q1). Verify with check 4 in §12: *existing School Contacts still see it, a freshly registered
   account does not and is offered a request, and a `staff` account sees it holding no grant row at all.*

If step 3 turns out to be wrong, flipping the form back to **Public** restores the previous behaviour
completely and destroys nothing (§6.4).

---

## 15. The questions, and the answers

### 15.1 Answers (2026-09-28)

All eight questions are answered. **Four changed the design**, and every passage they changed carries the
marker **⟵ §15 Qn** in place.

| # | Question | Answer | What it changed |
|---|---|---|---|
| 1 | **What does "Private" restrict?** | **School Contacts stop seeing the form's results; administrators *and* `staff` keep access.** Families can still submit. | ⟵ **§1, §3.1, §3.3, §4.2, §6.3, §6.4, §7.1, §7.4, §12 (check 4)**. The predicate is role-shaped and the backfill covers `cdm_contact` only. The second half confirms §3.2 is untouched — **a submission gate is not part of this feature.** |
| 2 | **Whose access — per person, or per person *and* school?** | **Per person.** | ⟵ **§5.5, §4.2**. Confirms the `(user_id, form_id)` key; no school dimension is stored anywhere. |
| 3 | **How should the administrator be told?** | **In-app only, for now.** | ⟵ **§2, §10.3 (rewritten), §11, §14 (step 2)**. **Slack is deliberately not wired and e-mail is not built.** The Settings queue is the entire notification story, which makes the pending count on the **closed** section title load-bearing. |
| 4 | **Who may approve?** | **Any administrator.** | Confirms §8 as written: every `/api/form-access/*` admin route is `requireRoles("admin")`, with no owner column on the form and no approver list. |
| 5 | **Does a decline need a reason and a way back?** | **A reason, yes. A way back only for an administrator.** | ⟵ **§5.2, §8, §10.1, §13 (trap 13)**. Declines carry a `note`; `POST /requests` **refuses** a `denied` row; the locked panel's "Ask again" is removed. *Withdrawing a still-pending request stays allowed* — it changes nobody's access. **⚠️ SUPERSEDED 2026-10-02 — see §18: a `denied` row IS now re-requestable, at the user's request, so that removing access in the Edit User drawer leaves the person able to ask for it back.** |
| 6 | **Should an approval be revocable?** | **Yes, by an administrator.** | ⟵ **§5.2, §8, §9, §10.2**. `decision: "revoke"` on the existing `decide` endpoint reaches `denied` from `approved`, and a grants list with a Revoke button gives that control something to act on. "Revoke and decline are the same state" is accepted — the log tells them apart, which is why Q7 matters more once Q6 is yes. |
| 7 | **Is the last decision enough, or do you want a history?** | **A history is wanted.** | ⟵ **§5.2, §5.3 (new table), §8, §9, §11, §12 (check 8), §13 (trap 14)**. `form_access_events` is append-only and is **never** read by the visibility predicate. |
| 8 | **When do you want to flip CDM to Private?** | **Later — after everything is working.** | ⟵ **§14** confirmed as written: ship the schema, then the workflow, then flip. Steps 1 and 2 change nothing for anyone, so the deploy carries no risk — **the behaviour change stays a decision you make with the feature already live.** |

### 15.2 What the answers settled, and the three things worth watching

**Settled, and not worth re-opening:**

- **This does not gate submission.** §3.2 stands unchanged. The bound Apps Script and the form's own URL
  post to the webhook anonymously; *"only invited families may submit"* would need a real authentication
  story and is a second feature with its own plan.
- **The restriction names a role; the grant names a person** (Q1 + Q2). Do not add a school to the grant key,
  and do not add a role to it — either one turns a per-person decision back into a rule.
- **The backfill population is small and knowable**: the organization's School Contacts. Every other account
  in the system is untouched by this feature, which is why the deploy in §14 has no blast radius until step 3.

**Three things worth watching, in the order they are likely to bite:**

1. **In-app only means nothing pushes.** Q3 makes the count on a *closed* section the entire notification
   mechanism. A request sitting unanswered for a week is the design working as specified — but it is the
   first thing to revisit if it turns out to be too quiet. Adding Slack is a one-line change (§10.3), and
   because §10.3 deliberately avoids a notification abstraction, there is nothing to unwind first.
2. **A revocation is permanent from the requester's side** (Q5 + Q6 together). An administrative mistake has
   to be corrected by an administrator, and there is no undo on the revoke button — the confirmation on that
   button should say so in words rather than relying on the reader to infer it.
3. **`staff` will keep seeing any form that is made private, permanently.** Q1's carve-out is exactly why
   this feature is small, and it is also why a future *"this form is for the CDM office only"* request will
   need a change to the **predicate** rather than a new flag or a checkbox. §7.1 makes that a one-line
   change — but it is a code change, and saying so now saves someone an afternoon of looking for a setting
   that does not exist.

---

## 16. ★ **Available Forms** — the discovery page (added 2026-10-02)

> *"I would like to add a menu item 'Available Forms' that shows all of the forms, the ones the user
> currently has access to and any new forms that they can request access to."*

### 16.1 Why this is not a convenience — it is what makes §10.1 reachable

§10.1 designs the **locked panel**: a screen that says *"#2 CDM Non-Traditional is a private form. Ask an
administrator for access."* with a **Request access** button. The plan then says where it appears:

> *"The dashboard / staff queue **when the only published form in the organization is locked** — i.e. the
> new registrant's first screen."*

**★ §1.1's re-measurement breaks that assumption: there are now TWO published forms** (`#2 CDM Google
Form` and `#5 Gov School Submissions`). So a `cdm_contact` who is refused `#2` still has `#5`, lands on a
**working queue**, and the locked panel is never rendered. The request workflow would exist, be correct, be
tested — and be **unreachable** for the exact person it was built for.

That is the failure this section fixes, and it is worth naming precisely because it is the *quiet* kind: no
error, no empty state, no 403. The person simply never learns that `#2` exists, so they never ask, so the
admin queue stays empty, so everything looks like it is working.

**Three ways to reach a locked form, and only the third is reliable:**

| Route | Works when | Fails when |
|---|---|---|
| The zero-forms empty state (§10.1) | the user can see **no** forms at all | ★ **any other form is published** — the case today |
| A deep link (`/reports?form_id=2`, a bookmark) | somebody gave them the link | they have never seen the form, so they have no link |
| **The Available Forms page** ✅ | always — it is the only surface that *enumerates* | — |

**★ Generalise: an affordance that lives only inside an empty state is unreachable as soon as the state is
not empty.** A locked form is a *row*, not an absence, and a row needs a list to appear in.

### 16.2 What the page shows

One page, organisation-scoped, listing **every form the caller is entitled to know about**, in three groups.
"Entitled to know about" is the whole design question and it is answered in §16.3.

| Group | Contents | Action |
|---|---|---|
| **My forms** | every form the caller can read — public forms, plus private forms they hold a grant for | **Open** → the normal queue/report for that form |
| **Available to request** | private forms in the organisation the caller **cannot** read and has **no row** for | **Request access** |
| **Requested** | private forms with a `pending` row | **Withdraw request** + *"waiting since 28 Sep"* |
| *(a fourth, folded into the third)* | private forms with a `denied` row | **no action** — *"Declined 28 Sep"* / *"Access removed 28 Sep"* + the admin's note ⟵ **§15 Q5** |

**★ The `denied` rows are shown, not hidden.** §15 Q5 answered that a decline is final from the requester's
side, and the temptation is to hide the form entirely so the person stops thinking about it. That is worse:
the form is real, they know it exists (they asked for it), and a page that silently drops it reads as a bug.
Showing it with *"this has to be changed by an administrator"* is the honest state — and it is the same
wording §10.1 already uses, so the panel and the page cannot disagree.

**★ The page is a VIEW, not a second permission system.** Every row it renders comes from the same predicate
as everything else (§7.1). It must not compute visibility itself — see §16.5.

### 16.3 ★ What a person may learn exists

This is the only genuinely new policy question the page raises, and it deserves a decision rather than a
default.

**The rule: a person may see that a form exists if they could ask for it.** For a `cdm_contact` that means
**every form in their own organisation**, including private ones they have no grant for. Concretely the page
shows `title`, `description`, the form's code (`#2 CDM2`), and its status — and **nothing else**: no
submission count, no school breakdown, no last-updated, no designer. The row is an *invitation*, not a
preview.

Why this is safe, and why it is the right call:

- **The form's existence is already public.** `GET /api/forms/public` and `GET /api/forms/:id/public` are
  **anonymous** and serve a published form's title and questions to anyone (§3.2). So a signed-in School
  Contact learning that a published form exists reveals strictly less than the public endpoint already does.
  **★ There is nothing to protect here** — the private flag narrows *results*, never *existence*.
- **A request is impossible without it.** §8's `POST /requests` takes a `form_id`; a person who cannot
  enumerate forms cannot produce one. Hiding existence makes the workflow unusable by construction.
- **It is bounded by the organisation**, which is the existing tenant boundary — the same one `GET /api/forms`
  already applies.

**★ What the page must NOT reveal, and this is the trap:** a **draft** or **archived** form. Those are
unpublished, `GET /api/forms/public` does not serve them, and `selectableForms` (§2) exists precisely to keep
them out of every picker. A private *draft* is doubly hidden. So the page's query is
`status = 'published'` **AND** the visibility rule — and the status filter is the one that matters, because
it is the one with a public-endpoint precedent. **A form that is not published must not appear on this page
in any group, for any role.**

**★ And it must not reveal another organisation's forms.** The predicate is `AND`-ed onto the org filter,
never substituted for it (§7.1, trap 1). Org 2 (`technology-services`) exists and is active (§1.1), so it is
the natural negative control in §16.7.

### 16.4 The API — one call, and it is not a new permission surface

**`GET /api/forms/available`** — staff · cdm_contact · admin.

Returns every published form in the caller's organisation, each with the caller's relationship to it:

```jsonc
[
  { "id": 5, "title": "Gov School Submissions", "code": "GOVS", "description": "…",
    "access": "granted",   "reason": "public" },        // readable
  { "id": 2, "title": "CDM Google Form", "code": "CDM2", "description": "…",
    "access": "none",      "reason": "private" },        // requestable
  { "id": 7, "title": "…", "code": "…", "description": "…",
    "access": "pending",   "requested_at": "2026-09-28T…" },
  { "id": 8, "title": "…", "code": "…", "description": "…",
    "access": "denied",    "decided_at": "2026-09-28T…", "note": "Not your school.",
    "last_event": "revoked" }
]
```

- **`access` is derived, never stored**: `granted` (the predicate passes) · `none` · `pending` · `denied`.
  It is computed by asking the *same* predicate as every other query, so the page cannot disagree with the
  queue about what the caller can open. **This is why it is one endpoint rather than two** — a
  `listForms` + `listLockedFormsFor` pair (which §9 already has) would let the two halves disagree about a
  form that changed state between the calls, and the page would render it in two groups at once.
- **`last_event`** distinguishes *declined* from *access removed* (§5.2/§5.3), exactly as §9's
  `listLockedFormsFor` does. Reuse that function's join rather than writing a second one.
- **`reason`** on a granted row is `public` or `grant`, so the page can say *"public"* beside a form nobody
  had to grant — which is what stops a reader concluding every form needs a request.
- **No new route family, no new table.** This is a read over `forms` + `form_access`, both of which §5
  already creates. It is registered in `inventory.ts` **and** `swagger.ts` like every other route (§8), and
  it is labelled `staff` in the inventory vocabulary (open to staff, School Contacts and admins).
- **★ It is NOT `GET /api/forms` and must not replace it.** `GET /api/forms` answers *"what may I read?"*
  and is what every picker and report uses; it must keep narrowing (§7.2). `GET /api/forms/available`
  answers *"what exists, and what is my relationship to it?"* — a superset by design. **Two endpoints with
  two different questions**, and the naming should make that obvious rather than inviting a merge.

### 16.5 Client

**A new route `/staff/forms`** (and, for symmetry, the admin sees the same page — admins are unrestricted by
rule, so every row is `granted` and the page is a plain index; §16.6 says why it is still worth showing
them). Rendered inside the existing `<AppShell>` under
`<ProtectedRoute roles={["staff", "cdm_contact", "admin"]}>`.

**A new sidebar item, "Available Forms"**, in both the admin and the staff nav blocks
(`client/src/components/layout.tsx` — the two `<>…</>` fragments at ~L299 and ~L334).

**★ The menu item must be added to `MENU_ITEMS` (`client/src/lib/settings.ts`) *and* `MENU_ITEM_KEYS`
(`server/src/routes/settings.ts`) — both, or the Settings → Menu Settings panel cannot switch it.** Those
two lists are a hand-copy of each other and this repo has a recorded incident of exactly that drift. The key
is `available_forms` and the label is `Available Forms`. **Note the existing precedent:** `documents` was
deliberately *removed* from both lists because `documents_link` was already the single gate for that link
(§2 of the repo's notes) — so the question to ask before adding a key is *"is there already a gate?"*.
Here there is not: this page is available to every internal role, with no per-role setting, so a
`menu_items` key is the right and only gate.

**Placement: directly after "Submissions"** in the staff block and after "Forms" in the admin block — it is
a sibling of the queue, not of Settings.

**The page itself** (`client/src/pages/forms/AvailableForms.tsx`):

- Three `<section>`s with the existing `.card` / `table.grid` classes — **reuse, do not invent**. The
  *My forms* table is the same shape as the Forms admin grid minus the admin columns.
- **The empty state is per-group, not per-page.** *"You have access to every form"* under *Available to
  request* is a real, good state and must be said; a page-level empty state would be unreachable, because
  *My forms* is never empty for a `staff` or admin account.
- **★ The locked rows do not link anywhere.** A `none` row's action is a **button**, not a link — there is
  no page behind it to open. This is the same defect as §13 trap 13 (*"a UI control the API refuses is worse
  than no control"*): a link to a 403 is worse than a button that asks.
- **The `denied` row's action is absent, not disabled.** A greyed-out *Request access* invites the reader to
  look for the condition that would enable it. §10.1's wording (*"This has to be changed by an
  administrator."*) is the whole affordance.
- **After a successful request the row moves group in place** — no full reload, because the page's whole
  job is to show the state change. Optimistic is **not** acceptable here: §8's `POST /requests` can refuse
  (a `denied` row, a form that is already public), and a row that moves on a refusal is a lie. Re-render
  from the response.
- **The page must not compute visibility.** It renders `access` from the payload. Any `if (form.visibility
  === 'private')` in this component is the "client hides, it never decides" violation (§4.1) and the
  "two overlapping gates" trap (§13 trap 3). The server already said what the relationship is.

### 16.6 Does an admin need this page?

**Yes, and it is not redundant with the admin Forms page.** The admin Forms page is a *management* surface —
it lists drafts and archived forms, has Edit/Delete/Publish, and is where visibility is set (§10.2). This
page is a *reader's* index: published forms only, no management controls. For an admin every row reads
`granted`, so the page is mostly an index — which is exactly what makes it useful as the **one screen that
proves the feature is behaving**: an admin who can see a form listed as `none` for themselves has found a
bug in the predicate, because §7.4 says that cannot happen.

**★ That makes the admin view a free invariant check, and §16.7 turns it into one.**

### 16.7 Verification additions

Extending §12. Each check names the negative it depends on.

1. **The three groups partition the published forms exactly.** For a `cdm_contact`, the union of
   *my forms* + *requestable* + *requested/denied* equals every **published** form in their organisation,
   with no form in two groups. Assert the counts sum, not just that each group is non-empty.
2. **★ A draft and an archived form appear in NO group, for any role.** This is the §16.3 trap and the one
   most likely to regress, because the naive query is `WHERE organization_id = @org` with no status filter.
   **Include a control:** the same fixture asserts a published form *does* appear, or "no drafts appear"
   passes on a query that returned nothing at all.
3. **★ An admin's own rows are all `granted`.** §16.6 — this is the invariant check, and it fails loudly if
   the predicate's first disjunct is ever removed.
4. **A `staff` account's rows are all `granted` too** (same carve-out, §15 Q1) — and a `staff` account holds
   **no `form_access` row** (§12 check 4's mirror half), which is what proves the exemption is doing the
   work rather than a grant.
5. **Org isolation:** a `cdm_contact` in org 1 sees **zero** forms belonging to org 2
   (`technology-services`). The org filter is `AND`-ed, never substituted (§13 trap 1).
6. **The page and the queue agree.** For every row the page marks `granted`, `GET /api/submissions?form_id=`
   returns a non-empty list (or an empty one for a form with no submissions — assert the **status**, not the
   row count, or the check fails on a correct system with an empty form). For every row marked `none`,
   the same call returns `[]` and `GET /api/submissions/:publicId` for one of its rows returns **403**.
   **★ This is the check that catches the two surfaces disagreeing**, which is the failure §16.4's
   single-endpoint decision exists to prevent.
7. **A request made from the page moves the row group without a reload**, and the admin queue's pending
   count increases by one — the two halves of the workflow observed in one pass.
8. **The `denied` row offers no action** and renders the admin's `note`; and a `revoked` row reads
   *"access removed"*, not *"declined"* (§5.3's `last_event`).

**★ The failing control stays:** a `cdm_contact` calling `GET /api/form-access/requests` (the admin queue)
must still get **403** — the new page must not have widened anything to make itself work.

### 16.8 Traps specific to this page

1. **★★ An affordance reachable only from an empty state disappears the moment the state is not empty.**
   §16.1 — this is the defect the page exists to fix, and it is re-introducible by anyone who "simplifies"
   the page away on the grounds that the locked panel already covers it.
2. **★ The naive query leaks drafts.** `WHERE organization_id = @org` with no `status = 'published'` puts
   unpublished forms on a page every internal role can open. §16.3.
3. **The page must not become a second visibility implementation.** Render `access` from the payload; never
   test `visibility` in the component (§16.5, §13 trap 3).
4. **`MENU_ITEMS` and `MENU_ITEM_KEYS` are a hand-copy pair.** Add the key to both, or the Settings toggle
   silently cannot see it (§16.5). This repo has the incident recorded.
5. **A link where a button belongs.** A `none` row has no destination; a link to a 403 reads as a broken
   feature (§13 trap 13).
6. **Optimistic group movement on a refused request.** §8 refuses a `denied` row and a public form; the
   row must move only on a 2xx (§16.5).
7. **The page is not a replacement for `GET /api/forms`.** Every picker and report keeps using the narrowing
   endpoint (§16.4). Two endpoints, two questions — merging them either breaks the pickers or re-widens
   them.

---

## 17. ★ Production SQL — to be run by hand after the code ships

**Added 2026-10-02.** Development is pointed at the **test** database
(`wcpss-sql-serverless-freetier` / `school-form-data`). Production is a **different server and database**
(`wcpsssqlelasticpool` / `wcpss-google-forms`) that this app did not create and whose data is inviolable.

### 17.1 Why a script is needed at all, when the app has a migration ladder

The app runs `SQLSERVER_DDL_STATEMENTS` at every boot (`initDb()`), and §11 puts the new tables and column
into it. **That is not sufficient here, for two reasons that are specific to this deployment:**

1. **The ladder runs against whichever database the connection string names** — so it will create these
   objects on the *test* database the moment the code boots there, and on production only when a slot
   pointed at production boots. That is the documented hazard: *"a staging deploy migrates production."*
2. **The ladder is create-if-missing and its failures are quiet.** If anything in it fails on production's
   foreign schema (a name collision, a type the DDL assumes), the app still reaches `dbReady` for the parts
   that succeeded, and the missing objects surface later as a 500 on a route.

**So: run this script by hand against production BEFORE the code that needs it is swapped in.** It is
idempotent — every statement is guarded — so re-running it is safe, and running it early is safe too
(the app ignores objects it does not yet use).

### 17.2 The script

**★ Run against `wcpsssqlelasticpool` / `wcpss-google-forms`. Confirm the target first:**

```sql
SELECT @@SERVERNAME AS server_name, DB_NAME() AS database_name;
-- expect: wcpsssqlelasticpool | wcpss-google-forms
```

Then, in this order. Each block is a **separate batch** — SQL Server raises error 207 when a statement
references a column added in the same batch, and a `CHECK` cannot be added in the batch that adds its
column.

**Batch 1 — the visibility column.**

```sql
IF COL_LENGTH('dbo.forms', 'visibility') IS NULL
  ALTER TABLE dbo.forms ADD visibility NVARCHAR(10) NOT NULL
    CONSTRAINT DF_forms_visibility DEFAULT 'public';
GO
```

**Batch 2 — its CHECK constraint** (separate batch; guarded on the constraint by name, not on the column).

```sql
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_forms_visibility')
  ALTER TABLE dbo.forms WITH CHECK ADD CONSTRAINT CK_forms_visibility
    CHECK (visibility IN ('public','private'));
GO
```

**Batch 3 — `form_access`.**

```sql
IF OBJECT_ID('dbo.form_access', 'U') IS NULL
  CREATE TABLE dbo.form_access (
    user_id      INT           NOT NULL,
    form_id      INT           NOT NULL,
    status       NVARCHAR(20)  NOT NULL
        CONSTRAINT CK_form_access_status CHECK (status IN ('pending','approved','denied')),
    source       NVARCHAR(20)  NOT NULL
        CONSTRAINT CK_form_access_source CHECK (source IN ('request','backfill','direct')),
    requested_at DATETIME2     NOT NULL CONSTRAINT DF_form_access_requested DEFAULT SYSUTCDATETIME(),
    decided_at   DATETIME2     NULL,
    decided_by   INT           NULL,
    note         NVARCHAR(400) NULL,
    CONSTRAINT PK_form_access PRIMARY KEY (user_id, form_id)
  );
GO
```

**Batch 4 — `form_access_events`.**

```sql
IF OBJECT_ID('dbo.form_access_events', 'U') IS NULL
  CREATE TABLE dbo.form_access_events (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    user_id    INT           NOT NULL,
    form_id    INT           NOT NULL,
    event      NVARCHAR(20)  NOT NULL
        CONSTRAINT CK_form_access_events_event
        CHECK (event IN ('requested','withdrawn','approved','declined','revoked','backfilled')),
    actor_id   INT           NULL,
    note       NVARCHAR(400) NULL,
    created_at DATETIME2     NOT NULL CONSTRAINT DF_form_access_events_created DEFAULT SYSUTCDATETIME()
  );
GO
```

**★ No `INSERT` statements, and no backfill.** The backfill (§6) is **not** part of this script — it runs
when an administrator flips a specific form to private, and it must run then, not now. A script that
pre-granted access would grant it to accounts that may not exist yet and would leave rows with no
privatisation event behind them (§6.5).

**★ No index statements.** §5.2/§5.3 deliberately add none, and adding one here would put production's
index set out of step with both dialects' DDL — which `libsql.test.ts` asserts.

### 17.3 Verify the script

**★ The script in §17.2 was executed against the test database on 2026-10-02 to prove it works** — run
**twice** (idempotency), verified with the queries below, then **fully rolled back** so the test database was
left exactly as found. Results: all 4 batches executed without error on both passes; the column, both tables,
the 3 named CHECKs and the 8/7 column counts all verified; a bogus `status` was **rejected** and a valid row
**accepted**; and the rollback removed every object it created. **So the script is known-good, not merely
drafted.**

Run these immediately after, and keep the output:

```sql
-- expect 1 row, 'public'
SELECT c.name, t.name AS type_name, c.max_length, c.is_nullable, dc.definition AS default_value
  FROM sys.columns c
  JOIN sys.types t ON t.user_type_id = c.user_type_id
  LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
 WHERE c.object_id = OBJECT_ID('dbo.forms') AND c.name = 'visibility';

-- expect 1 row: CK_forms_visibility
SELECT name, definition FROM sys.check_constraints
 WHERE parent_object_id = OBJECT_ID('dbo.forms') AND name = 'CK_forms_visibility';

-- expect 2 rows, the two new tables
SELECT name FROM sys.tables WHERE name IN ('form_access', 'form_access_events');

-- expect 8 columns on form_access, 7 on form_access_events
SELECT t.name AS table_name, COUNT(*) AS column_count
  FROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id
 WHERE t.name IN ('form_access', 'form_access_events')
 GROUP BY t.name;

-- expect 3 CHECK constraints across the two tables
SELECT parent.name AS table_name, cc.name
  FROM sys.check_constraints cc
  JOIN sys.tables parent ON parent.object_id = cc.parent_object_id
 WHERE parent.name IN ('form_access', 'form_access_events');

-- expect 0 rows — nothing was granted by this script
SELECT COUNT(*) AS rows_in_form_access FROM dbo.form_access;
```

### 17.4 ★ The one difference from the app's own DDL, and why

The app's `CREATE TABLE` in §11 declares the CHECKs **inline and unnamed** (matching the surrounding
style). This script names them (`CK_form_access_status`, `CK_form_access_events_event`, …).

**That is deliberate, and it is the one place the two must not be "kept in step" by hand.** An inline
constraint gets a server-generated name, so a script and a ladder that both ran would create *two*
differently-named constraints on the same rule — and a later widening (the `google_doc` precedent in this
repo) would find only one of them. Naming them here means:

- the script's objects are **discoverable by name**, which is what §17.3's verification relies on;
- if the ladder later runs on production, its `IF OBJECT_ID(...) IS NULL` guard sees the table already
  exists and creates nothing — so there is no collision;
- a future constraint change has a stable name to target, exactly as `CK_form_fields_type` does after the
  `google_doc` work.

**★ Record the names in the plan and in `schema.ts`'s comment when the code is written**, so the next person
does not have to diff a live database to find out what the constraints are called.

### 17.5 Order of operations for the production deploy

| # | Step | Why this order |
|---|---|---|
| 1 | Run §17.2 against production | Creates objects the new code needs. Idempotent, and harmless while the old code is still live — it does not read them. |
| 2 | Run §17.3 and keep the output | Proves the objects exist **before** the code depends on them. |
| 3 | Deploy the code (§14 steps 1–2) | The ladder finds the objects present and creates nothing. |
| 4 | Verify `dbReady` and that `GET /api/forms` returns the same forms as before | The column defaults to `public`, so nothing should have narrowed. |
| 5 | Only then, §14 step 3 — mark the CDM form Private | The behaviour change, with the feature already live and verified. |

**★ Do not skip step 5's precondition.** Flipping a form to private is the *only* step that changes what
anyone can see, and it is the one step that is fully reversible (§6.4).

### 17.6 If the script is skipped

The failure is not a crash — it is a **500 on the first request that touches the new objects**, with a
message naming a missing column or table. Concretely:

| Missing object | Symptom |
|---|---|
| `forms.visibility` | `GET /api/forms` (which selects the column) 500s for **everyone**, including admins — so the whole app looks down, not just the new feature. |
| `form_access` | The predicate's `EXISTS` subquery fails → every form listing 500s. |
| `form_access_events` | Requests and decisions 500 **after** the state row was written, leaving a grant with no audit line (§13 trap 14). |

**★ The first row is the one to weigh.** `listForms` uses an **explicit column list** (not `SELECT *`), so
adding `f.visibility` to it means a missing column takes down the *existing* forms list for every role —
admins included — rather than just the new page. That is an argument for running the script **before** the
code, not after — and it is why §17.5 puts the script first.

**★ The ladder would eventually create these on its own** (the next time a slot pointed at production
boots), so the script is not strictly the only path — but "eventually" is bounded by the next deploy, and
between the code swap and that boot the app is broken. **Run the script.**

---

## 18. ★★ REVERSED 2026-10-02: a `denied` row IS now re-requestable

**Requested verbatim:** *"On the edit user page, there should be a list of forms the person has access
to and the admin can remove access. If access is removed, it will say 'request access' on the available
forms page."*

That last clause **contradicts §15 Q5**, which answered that a decline is final from the requester's
side. Asked directly how a *removal* should differ from a *decline*, the answer was: **any `denied` row
becomes re-requestable.** So §15 Q5 is superseded for the request path, and the change is recorded here
rather than quietly applied.

### 18.1 What changed

| Site | Before | After |
|---|---|---|
| `requestFormAccess` | threw `AccessRequestError("denied")` for a `denied` row | resets it to `pending` and writes a fresh `requested` event |
| `RequestRefusal` | included `"denied"` | removed — the union is `already_readable \| not_private \| not_found` |
| `POST /requests` | mapped the `denied` refusal to a 400 | that branch is gone |
| `AvailableForms` grouping | `denied` → the *Requested* group, no action | `denied` → the *Available to request* group, with **Request access** |
| `LockedFormPanel` | `denied` showed "This has to be changed by an administrator" | shows the reason **and** a **Request access again** button |
| `AdminSettings` drawer copy | "cannot ask again" | "can ask for access again — approving that request restores it" |

### 18.2 ★ What is deliberately NOT lost

**The two facts remain distinguishable.** `declined` and `revoked` are still separate
`form_access_events` values, so an administrator reading the history can still tell *"this person was
refused"* from *"this person's access was removed"*. Only the **state** (`denied`) is shared — and
re-requesting now clears it.

**A removal still sticks against the grandfather.** §6.4's rule is unchanged: a later public→private
flip does not re-grant an account whose row is `denied`. The difference is that the account can now
*ask*, and an administrator decides — which is a better answer than a permanent lock and is what makes
the Edit User drawer's Remove button reversible.

### 18.3 The Edit User drawer

**`GET /api/form-access/user/{userId}`** and **`POST /api/form-access/user/{userId}/remove`** — admin
only, scoped to the caller's organization (a foreign user answers **404**, not 403, so the two are
indistinguishable).

**★ The list shows the rows that EXIST for the account — "grants you have made", not "forms this person
can read".** The two differ for a `staff` or admin account, which is exempt by rule and holds no row at
all, so its list is legitimately **empty** and the drawer says why. Deriving "forms they can read" would
mean re-running the predicate per form and would offer a Remove button for rows that do not exist.

**★ Removal REFUSES a PUBLIC form (409).** On a public form every internal member can read it
regardless of any row, so the removal would appear to succeed while changing nothing — the admin would
watch the row vanish and the person would still open the form. The message names the fix: make the form
private first.

**★ Only an `approved` row offers Remove.** A `pending` request is answered in the Access Requests
section and a `denied` row is already without access, so a Remove button on either would be a control
the API refuses (§13 trap 13).

**★ The user id comes from the PATH, the form id from the body** — so a removal cannot be redirected to
a different account than the one the admin has open.

### 18.4 Verification

`form-access.test.ts` gained a §18 block (5 gates): the public-form refusal, the `denied`+`revoked`
pair matching the queue's Revoke, the rows-not-readable rule (asserting the function does **not**
consult the predicate), the organization scoping on both routes, and the path-not-body rule.

Live: **23 checks**, including the full round trip **grant → remove → re-request → approve →
restored**, plus the controls (removing a nonexistent row, removing on a missing form, and the
public-form refusal leaving the row untouched).

**★ One probe expectation was wrong, and the fix was in the COPY, not the code.** The first run
asserted "re-requesting is refused" — true of the build at that moment, but contradicting the request.
That failure is what surfaced the inconsistency between the drawer's "they can ask again" wording and
the API's refusal; the code and the copy were then brought into line together.

**★ Generalise: a probe that asserts the CURRENT behaviour will happily enshrine a contradiction between
what the UI promises and what the API does.** The check that caught this was the one written from the
*requirement* rather than from the implementation.
