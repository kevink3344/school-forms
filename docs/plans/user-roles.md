# Plan — User Roles (per-form role assignment + organization-authored roles)

**Status:** ⏸️ **Deferred — superseded for the immediate need by [`reviewer-role.md`](./reviewer-role.md)**
**Date:** 2026-09-24 (deferred 2026-09-30)
**Area:** Roles / Access control — form-scoped roles, custom roles
**Depends on:** [`access-groups.md`](./access-groups.md) — its §4 change checklist lands first (see §8 P0)
**Related:** [`workspaces.md`](./workspaces.md) §13.2 / §14.3 (per-workspace role — the same shape of question, still open)

> **Why this was deferred, and why it is kept.**
>
> The requirement was narrowed on 2026-09-30 to a fourth **system** role — org-wide, single-valued,
> no per-form scoping (`reviewer-role.md` §2). Under those decisions this document builds three
> tables, a token claim and an enforcement primitive to answer a question nobody is asking yet.
>
> It is **not refuted**. Everything below is still the correct design for *"a person needs
> different access on different forms"* or *"one person holds two roles at once"* — neither of
> which a single-valued system role can express. Keep it as the design of record for that day.
>
> Two things here are worth taking even if the rest never ships:
>
> - **§4.5** (why a join table beats the existing JSON-array convention) — it is the reason the
>   reviewer role's key must be chosen deliberately, since the key is stored in
>   `form_fields.roles`, `system_messages.audience` and `menu_items`.
> - **§4.7** (one visibility primitive for the list *and* the guard) — the duplicated-list hazard
>   it describes is live today and is what `reviewer-role.md` §5.2 catalogues.
>
> `access-groups.md` §4 (P1 in `reviewer-role.md` §7) is a prerequisite for both plans, so
> taking it now costs nothing if this is ever resumed.

---

## 1. What was asked

> "When someone creates a form, they have the ability to add a System Role (Admin, Staff,
> School Contact) and add their own role (School Reviewer, Report Viewer)."

That is **two** features, and they are different enough to separate everywhere in this
document:

1. **Attach roles to a form** — a form ↔ role relation. **This does not exist today in any
   form.** Roles are global; nothing scopes them to a form.
2. **Author new roles** — a role *universe* that is no longer the hard-coded three. The
   current list lives in ~12 places (`access-groups.md` §2) and is also a **DB CHECK
   constraint**, so a custom role cannot even be stored on a user today.

Feature 1 is the visible one. Feature 2 is the one that creates the risk, because it moves a
security boundary from code to data.

---

## 2. Decisions taken (2026-09-24)

| # | Question | Decision |
| --- | --- | --- |
| **D1** | What does adding a role to a form *do*? | **Grant a capability set** — `view` / `edit` / `export` / `report`. Not visibility alone. |
| **D2** | Where is a custom role defined? | **Once per organization.** A role catalog; each form picks from it. |
| **D3** | How does a user come to hold one? | **Org-wide grant** (Settings → Users), **on top of** their existing system role. |
| **D4** | Can a form be hidden from Admin? | **No.** Admin sees every form in the org, always, implicitly. |

### Why D3 is the safety net

D3 means `users.role` **never gains a custom value**. The `CHECK (role IN
('admin','staff','cdm_contact'))` constraint, the `Role` union, the server `ROLES` constant and
`z.enum(ROLES)` all keep their exact current meaning: *the one system role a person is*. Custom
roles are a **second, additive** relation.

This is deliberate and it is what separates this design from `access-groups.md` **Option B**
(role keys in `users.role`, editable at runtime), which that plan warns "turns a security
boundary into runtime data" and would require widening the CHECK plus role-string validation at
every boundary. Here the only new thing a custom role can do is *narrow or widen access to
form data*. It can never make someone an administrator.

**Consequence to accept up front:** a custom role cannot grant access to administration —
Settings, Users, Schools, Organizations, Webhooks, designing a form, deleting a submission.
Those stay `requireRoles("admin")` and are untouched by this plan. If a future feature needs
"a non-admin who can edit one form's design", that is a **new decision**, not a flag added here
(see §12 Q3).

---

## 3. Current state

### 3.1 What exists

| Concept | Where it lives | Shape |
| --- | --- | --- |
| The system role of a user | `users.role` | single value, one of three, DB CHECK |
| The role claim used by guards | JWT `AccessPayload.role` | single string, 15-minute access token |
| Per-**field** access | `form_fields.roles` | JSON string array; `NULL` → all roles, `[]` → nobody |
| Per-**message** audience | `system_messages.audience` | same JSON convention |
| Per-**menu-item** gating | `app_settings` key such as `documents_link` | same JSON convention |
| Route gating | `requireRoles(...)` — 81 call sites, 12 files | exact role-key list per route |
| School scoping | `isSchoolScoped()` → `scopedSchoolId()` + `canAccessSchool()` | derived from `role`; true only for `cdm_contact` |

### 3.2 What is missing

- **No form ↔ role relation.** `dbo.forms` has no role column and there is no join table.
- **No role catalog.** `ROLES` is a TypeScript constant; there is no `dbo.roles` table.
- **No user ↔ role relation beyond the singleton.** A user cannot hold a second role.
- **No capability concept.** Access is all-or-nothing per route: if `requireRoles` admits you,
  you can do everything that route does. "Reviewer" vs "Viewer" is not expressible.

### 3.3 The one constraint that dictates the phasing

The startup DDL ladder (`server/src/db/schema.ts`, `SQLSERVER_DDL_STATEMENTS`) runs against
whatever database the connection string names, **before any swap and whether or not a swap ever
happens**. So a branch that adds these tables changes the production schema on its first boot.
Every step in §8 that touches DDL must be backward compatible on its own:

- new tables — safe
- new **nullable** columns — safe
- new `NOT NULL` columns on existing tables — **not** safe without a default
- widening the `users.role` CHECK — **not needed here** (D3), which is a large part of why D3
  was chosen

---

## 4. Design

### 4.1 Three layers, three questions

```
   ┌──────────────────────────────────────────────────────────────────────┐
   │  dbo.roles          "what roles EXIST in this organization"          │
   │  ─────────────────────────────────────────────────────────────────   │
   │  admin, staff, cdm_contact   (is_system = 1, seeded from code)       │
   │  School Reviewer             (is_system = 0, authored by an admin)   │
   │  Report Viewer               (is_system = 0, authored by an admin)   │
   └───────────────┬──────────────────────────────────┬───────────────────┘
                   │                                  │
      dbo.user_roles│ "who HOLDS it"       dbo.form_roles│ "which roles may
                   │                                  │  use THIS form"
                   ▼                                  ▼
   ┌───────────────────────────────┐   ┌──────────────────────────────────┐
   │ user 12  →  School Reviewer   │   │ form 5  →  Admin                 │
   │ user 31  →  Report Viewer     │   │ form 5  →  School Reviewer       │
   └───────────────────────────────┘   └──────────────────────────────────┘
                   │                                  │
                   └──────────────┬───────────────────┘
                                  ▼
              effective capability = ∩ of the two, unioned per capability
              ( admin short-circuits to full, per D4 )
```

### 4.2 `dbo.roles` — the catalog

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INT IDENTITY` | PK |
| `organization_id` | `INT NOT NULL` | **tenant boundary** — a role belongs to one org |
| `key` | `NVARCHAR(40) NOT NULL` | machine key: `school_reviewer`. Unique per org. |
| `label` | `NVARCHAR(80) NOT NULL` | "School Reviewer" |
| `description` | `NVARCHAR(400) NULL` | shown as a hint in the picker |
| `is_system` | `BIT NOT NULL DEFAULT 0` | 1 = one of the three; not editable, not deletable |
| `can_view` | `BIT NOT NULL DEFAULT 1` | |
| `can_edit` | `BIT NOT NULL DEFAULT 0` | |
| `can_export` | `BIT NOT NULL DEFAULT 0` | |
| `can_report` | `BIT NOT NULL DEFAULT 0` | |
| `badge` | `NVARCHAR(30) NULL` | optional CSS class / colour token for the chip |
| `school_scoped` | `BIT NOT NULL DEFAULT 0` | whether `canAccessSchool` applies to holders |
| `created_at` / `updated_at` | `DATETIME2` | |

`UNIQUE (organization_id, key)` — declared, not relied on.

**System rows are seeded, not authored.** At the end of `initDb`, for each organization, insert
any missing `is_system = 1` row from a code constant. That constant is the **single** place the
three system roles are named in this feature, and `access-groups.md` §6's `ROLE_DEFS` is the
natural shape for it. `key`/`label`/capabilities on a system row are **derived from code on every
boot**, never read back as truth — so if someone edits `staff`'s capabilities in the database,
the next boot overwrites it. That is intentional: the three system roles must keep meaning
exactly what they mean today (§9 R1).

Seed capabilities must **reproduce today's behaviour exactly**:

| System role | view | edit | export | report | school_scoped |
| --- | --- | --- | --- | --- | --- |
| `admin` | ✓ | ✓ | ✓ | ✓ | no (sees the whole org) |
| `staff` | ✓ | ✓ | ✓ | ✓ | no |
| `cdm_contact` | ✓ | ✓ | ✓ | ✓ | **yes** |

All three are identical on capabilities and differ only on scoping — which is exactly true of
the code today (all three appear in the same `requireRoles(...)` lists; `cdm_contact` is
narrowed by `isSchoolScoped`). Writing them as four identical flags is not a simplification
that loses information; it is the honest rendering of the current state, and it is what makes
`staff` and `cdm_contact` differ by exactly one field instead of by route lists.

### 4.3 `dbo.form_roles` — the feature that was asked for

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INT IDENTITY` | PK |
| `form_id` | `INT NOT NULL` | FK → `dbo.forms` **ON DELETE CASCADE** |
| `role_id` | `INT NOT NULL` | FK → `dbo.roles`, **ON DELETE CASCADE** |
| `created_at` | `DATETIME2 NOT NULL` | |

`UNIQUE (form_id, role_id)`.

Attaching a role is one row. Detaching is one delete. The Form Designer's role list is
`SELECT r.* FROM form_roles fr JOIN roles r ON r.id = fr.role_id WHERE fr.form_id = @id`.

### 4.4 `dbo.user_roles` — who holds a custom role

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INT IDENTITY` | PK |
| `user_id` | `INT NOT NULL` | FK → `dbo.users` **ON DELETE CASCADE** |
| `role_id` | `INT NOT NULL` | FK → `dbo.roles` **ON DELETE CASCADE** |
| `created_at` | `DATETIME2 NOT NULL` | |

`UNIQUE (user_id, role_id)`.

**Only custom roles may be granted here.** Not expressible as a constraint across tables in SQL
Server without a trigger, so it is enforced in the route (+ a Zod refine and a test). Trying to
grant `staff` here must 400 with a message saying the system role is set on the user, not
granted.

### 4.5 Why join tables, and not the existing JSON-array convention

`form_fields.roles`, `system_messages.audience` and the `documents_link` setting all store a
JSON array of role keys, with `NULL` meaning "all roles". Reusing that for a form-level role
list is the obvious move, and it is **wrong here** — for one reason:

> The existing convention works because the role universe is a **fixed three-item list in
> code**. Names can never change and can never disappear, so storing *names* is storing
> something permanent. Here the universe is **per-organization and mutable** — that is the
> whole feature (D2). A role can be renamed and can be deleted.

So a JSON array of keys breaks on rename (silently: the key no longer matches any role, and if
"unmatched" falls back to "everyone" the role list would *silently widen* — the worst possible
failure direction). A JSON array of ids has no FK, so deleting a role leaves dangling ids that
match nothing, and an `IDENTITY` can be recycled.

A join table gives: a real FK, `ON DELETE CASCADE` on both sides, `UNIQUE (form_id, role_id)`,
and — the reason it matters most for §4.7 — a **join** for the enforcement query, instead of
`OPENJSON` inside every submissions/reports/export query.

**Note this does not change the other three sites.** `form_fields.roles` and
`system_messages.audience` keep their JSON arrays, and keep meaning *system roles only*
(§11.2).

### 4.6 The capability model

A capability is a **verb on form data**, never a claim on administration.

| Capability | Gates | Concrete sites today |
| --- | --- | --- |
| `view` | the form appearing in `GET /forms`; opening `GET /forms/:id`; reading its submissions and a submission's detail | `submissions.ts` list + detail; `forms GET /:id` |
| `edit` | editing staff-only cell values; changing submission status; archive/restore; adding ad-hoc fields; saving columns | `submissions.ts` 11 × `canAccessSchool` write paths; `forms PUT /:id/columns` |
| `export` | CSV/XLSX/PDF preview + download for this form | `routes/export/*` |
| `report` | running and saving reports scoped to this form | `routes/reports.ts` (`REPORT_ROLES` at L40) |

**Not capability-gated, by design (D3):** creating a form, changing its status, deleting it,
deleting a submission, generating its fields, the Google Drive validation, and every surface
under `users` / `schools` / `settings` / `organizations` / `systemMessages` / `webhookEvents`.
Those stay `requireRoles("admin")` exactly as they are.

**Capabilities union, they do not intersect.** A user holding two roles attached to the same
form gets the union — which is the only reading that cannot surprise anyone.

### 4.7 One visibility primitive, used by the list *and* the guard

`access-groups.md` §2 row 11 records a real bug that came from two places deriving the same rule
differently ("a row that appears in a list can never 403 on open"). This feature has exactly the
same exposure, and the same fix: **derive both from one function.**

```ts
// server/src/roles.ts  (new)
export interface FormCapabilities {
  view: boolean; edit: boolean; export: boolean; report: boolean;
}

/** Every role key this user holds: their system role + custom grants. */
export async function heldRoleKeys(user: SessionUser): Promise<string[]>;

/** The capabilities this user has on ONE form. Admin short-circuits to all-true. */
export async function formCapabilities(user: SessionUser, formId: number): Promise<FormCapabilities>;

/** The ids of the forms this user may see at all. Admin → undefined (no filter). */
export async function visibleFormIds(user: SessionUser): Promise<number[] | undefined>;
```

`visibleFormIds()` is then consumed by:

- `listForms(...)` as an extra filter, so the grid shows exactly what can be opened, and
- `requireFormCapability(...)` as the per-record check, using the same predicate.

Two rules make this hold:

1. `visibleFormIds === undefined` means **no filter** and is returned **only** for admin.
2. The guard is never "is this id in the list" — the list is a projection of the predicate, not
   its definition. Both call `formCapabilities`/`visibleFormIds`, so they cannot drift.

The route-level guard mirrors the existing `canAccessSchool` shape — fetch, then check, then
403 — rather than being middleware that needs the id extracted from a query string:

```ts
const caps = await formCapabilities(req.user!, formId);
if (!caps.edit) return res.status(403).json({ error: "..." });
```

### 4.8 Empty means **unscoped**, and that is not the same as "nobody"

Every form in the database has **zero** rows in `dbo.form_roles` the day this ships. If zero
rows meant "no one may use this form", deploying the plan would black-hole the entire
application. So:

| `form_roles` rows | Meaning | Rendered in the designer as |
| --- | --- | --- |
| **0** | **Unscoped — legacy behaviour: every role may use this form** | "Everyone in *{org}* — this form isn't scoped yet" |
| ≥ 1 | Scoped to exactly these roles | the chips |

This mirrors `fieldAccessRoles()` in `schema.ts`, which returns `[...ROLES]` for `NULL` and `[]`
for an explicit empty array. Note the two must stay distinguishable on screen: a form the admin
has deliberately scoped to one role must not look identical to a form they never touched.

**And be honest about the "empty selection" case.** Under D4, an admin who detaches *every* role
has not locked the form — they have left it reachable by admins only. That is what D4 says, and
the UI must state it rather than implying a lock-out it cannot deliver:

> No roles attached. Admins can still use this form; nobody else can.

### 4.9 What the token carries, and what the database answers

`signAccessToken(user)` (`server/src/auth.ts` L41) is the single signer, called from four places
in `routes/auth.ts`. `AccessPayload` gains one optional claim:

```ts
roles?: string[];   // CUSTOM role keys only — never the system role, never role ids
```

| Question | Answered by | Staleness |
| --- | --- | --- |
| Which roles does this user hold? | the **token** (`roles`) | up to 15 min, or an immediate re-login |
| Which roles may use this form? | the **database** (`form_roles`) | immediate |
| What may a role do on a form? | the **database** (`roles.can_*`) | immediate |

Why the token and not a per-request lookup:

- `requireAuth` is deliberately DB-free today; adding a grant query would put a read in front of
  every request.
- `/refresh` already re-reads the user and re-signs (this is exactly the mechanism
  `role-migration-2026-09-24.md` relies on when 36 accounts changed from `staff` to
  `cdm_contact`), so the 15-minute window is the app's **existing, accepted** staleness.
- The token lives 15 minutes; a brand-new grant therefore takes effect within that window, or
  immediately after a re-login.

Two properties worth stating because they are not obvious:

- **Revocation and deletion are safe immediately, even with a stale token.** The grant is
  resolved as *"keys on my token" **∩** "roles this form names"*. If a role is deleted or
  detached from the form, the intersection is empty on the very next request — the token's stale
  copy grants nothing, because the form no longer names it.
- **Granting** a role is the only direction that waits for the token. If that turns out to
  matter, the cheap fix is to re-sign on a successful grant (the admin performing the grant is
  not the affected user, so it only helps after their next refresh — see §12 Q2).

Keys, not ids, on the token: the token is read by the client for showing chips, and a key is
stable across environments and readable in a JWT without a join.

### 4.10 The three system roles must not change behaviour

The whole of §8 P2 is a refactor with a **hard requirement**: for `admin`, `staff` and
`cdm_contact`, and for every existing form, the answer to every route must be **byte-identical**
to today. That is what makes it safe to ship the enforcement change before the UI.

The mechanism is §4.8 (zero rows = unscoped = all roles) plus §4.2 (system-role capabilities
seeded to reproduce today, and re-derived from code on every boot). Both exist to make P2 a
no-op for existing data — and §10's probe exists to prove it rather than assert it.

---

## 5. DDL

Follows the ladder's conventions exactly: idempotent guards, one batch per statement where an
`ALTER` is involved, and **declared in both dialects**.

### 5.1 `server/src/db/schema.ts` — `SQLSERVER_DDL_STATEMENTS`

Three `CREATE TABLE` statements, each guarded on the table's own name (the guard the ladder uses
for tables — `IF OBJECT_ID('dbo.x','U') IS NULL`). Indexes are declared as separate statements
so `expectedIndexNames()` picks them up and the boot-time missing-index warning stays honest.

Because the ladder also runs against databases this app did not create, the **foreign keys use
`fkGuard(table, column, referenced)`**, not a name-only guard — a name-only guard "misses" an
existing FK and adds a duplicate constraint to a live database (§ `schema.ts` L376-390 records
exactly this failure).

Key columns here are all `int`, so `isIndexable()` and `indexGuard()` behave normally (unlike the
`nvarchar(max)` columns that guard was written for).

### 5.2 `server/src/db/dialect/turso.ts`

The libSQL dialect builds the **final** schema directly with `CREATE TABLE IF NOT EXISTS` and
ports none of the ladder (`schema.ts` L359-364). The same three tables go there verbatim, with
`INTEGER PRIMARY KEY AUTOINCREMENT`, `TEXT`/`INTEGER` types, and `PRAGMA foreign_keys = ON`
assumed. The Turso ladder spells indexes `CREATE INDEX IF NOT EXISTS`, which the shared parser
already accepts.

### 5.3 Seed, not DDL

Seeding the three system roles is **not** a DDL statement — it is a per-organization upsert at
the end of `initDb`, after the tables exist, and it must tolerate: an org with no roles yet, a
role that was deleted, and a role whose label or capabilities were hand-edited (both get
restored from code).

### 5.4 What is deliberately *not* migrated

- **No column is added to `dbo.forms`.** The relation is a table, not a column (§4.5).
- **No change to the `users.role` CHECK.** D3 means custom roles never land there (§2).
- **No backfill.** Every existing form stays at zero rows, which means unscoped, which means
  unchanged (§4.8). This is the migration story: *there isn't one.*

---

## 6. Enforcement — route by route

| Route group | Today | After | Why |
| --- | --- | --- | --- |
| `submissions` list (`GET /`) | `requireRoles(staff,cdm,admin)` + `scopedSchoolId` filter | `requireFormCapability("view")` when a `form_id` is given, plus a `visibleFormIds()` filter when it is not | the list filter and the guard must agree (§4.7) |
| `submissions` detail / reads | same + `canAccessSchool` | `+ requireFormCapability("view")` | a form-scoped role must not read another form's submissions |
| `submissions` writes (11 sites) | same + `canAccessSchool` | `can_view` → `can_edit` | this is where Reviewer and Viewer differ |
| `submissions DELETE /:publicId` | `requireRoles("admin")` | **unchanged** | D3/short-circuit — destructive, admin only |
| `forms GET /` | `requireRoles(staff,cdm,admin)` | `requireAuth` + `visibleFormIds()` filter | every role must be able to list its own forms |
| `forms GET /:id` | `requireRoles("admin")` | `formCapabilities().view` | **this is the change that makes custom roles work at all** |
| `forms POST /`, `PUT /:id`, `PATCH /:id/status`, `DELETE /:id`, `POST /:id/generate-fields`, `POST /:id/drive-validate` | `requireRoles("admin")` | **unchanged** | form design is administration (D3) |
| `forms GET/PUT /:id/columns` | `requireRoles(staff,cdm,admin)` | `view` / `edit` | it is this form's data |
| `export` preview + download | `requireRoles(staff,cdm,admin)` (+ `documentsEnabled` / `requireAuthForPdf`) | `can_export` **on top of** the existing gates | the existing gates are orthogonal (feature flag, PDF token) and stay |
| `reports` (`REPORT_ROLES` = staff,cdm,admin) | role list | `can_report` for form-scoped reports; `REPORT_ROLES` stays for org-wide ones | some reports are not form-specific |
| `documents` | `requireRoles(staff,cdm,admin)` | `can_view` on the form the document belongs to | a document is form data |
| `settings`, `users`, `schools`, `organizations`, `systemMessages` admin CRUD, `webhookEvents`, `auth/seed-staff` | `requireRoles("admin")` | **unchanged** | administration |
| public routes (`/forms/public`, `/:id/public`, `submissions/:publicId/public`, `settings/:key`, `health`) | none | **unchanged** | a public form is public by definition — scoping is not a substitute for the `is_public` flag |

**The rule that keeps this tractable:** a route changes *only* if it reads or writes **one
form's data**. Everything that administers the system keeps its admin gate.

---

## 7. UI

### 7.1 Form Designer — the "Roles" section (the feature as asked)

In `client/src/pages/admin/AdminFormDesigner.tsx`, a new section **between "Form Details" and
the fields list** — the same neighbourhood as the Prefix field added in the previous change, and
the same card/section shape.

```
  Access
  ┌──────────────────────────────────────────────────────────────────────┐
  │  ( ) Everyone in Wake County — this form isn't scoped yet            │  ← zero rows
  │  (•) Only the roles below                                            │
  │                                                                      │
  │   [ Admin ]  view · edit · export · report      (system, locked)     │
  │   [ School Reviewer ]  view · edit                    [x]            │
  │   [ Report Viewer ]    view · export · report         [x]            │
  │                                                                      │
  │   + Add role ▾        ┌─────────────────────────┐                    │
  │                       │ School Contact          │  system roles      │
  │                       │ ─────────────────────── │                    │
  │                       │ School Reviewer         │  your org's roles  │
  │                       │ Report Viewer           │                    │
  │                       │ ─────────────────────── │                    │
  │                       │ + Create a role…        │                    │
  │                       └─────────────────────────┘                    │
  │                                                                      │
  │   ! Admins can always use this form.                                 │
  └──────────────────────────────────────────────────────────────────────┘
```

- **Admin is shown but not removable.** D4 makes it implicit; a removable chip would be a lie.
  Render it as a locked row with the note.
- **The radio pair is the load-bearing control** — it makes "unscoped" (§4.8) a visible state
  rather than an accident, and it is the difference between "I haven't decided" and "I decided
  it's these two".
- **"Create a role…" is inline** so "add their own role" is possible without leaving the form,
  which is what was asked. It opens a small dialog: **label**, **key** (derived from the label,
  sanitized like the Prefix field — lowercase, `[a-z0-9_]`, ≤ 40), a description, and the four
  capability checkboxes with a live sentence ("Holders can view and edit submissions of this
  form, but cannot export or run reports").
- Saving is immediate per action (attach/detach/create), not part of the form's Save — role
  grants are not form fields, and folding them into the form's dirty state would make the
  Save button mean two things.

### 7.2 Settings → Users — the grant

In `AdminSettings.tsx`, the Users panel (a `CollapsibleSection`, L180 in that file):

- The existing system-role `<select>` is **unchanged** (it still writes `users.role`).
- Below it, a new **"Additional roles"** checkbox group listing **custom roles only**.
- The users table shows custom-role chips beside the system badge.
- Guard: an org's custom roles only, and no system role can be posted to this field (§4.4).

### 7.3 Settings → Access Groups — the catalog

`access-groups.md` §5 proposes this panel **read-only**. This plan makes it editable for custom
rows. Columns: Badge · Label · Key · Kind (System/Custom) · Capabilities · Scope · **Used by**
(N forms, M users) · actions. System rows are visibly locked.

Deleting a custom role must **first show its usage counts** and then cascade. The counts come
from `form_roles` and `user_roles`; without them, "Delete" is a silent access change for
unknown people (§9 R4).

`CollapsibleSection` is currently a **local** component inside `AdminSettings.tsx` (L180), not
shared. If the Form Designer section uses the same shape it should be lifted to
`client/src/components/`, or the Form Designer uses its own — a one-line decision, noted so it
is not discovered mid-implementation.

---

## 8. Phasing

| Phase | Content | Ships a behaviour change? |
| --- | --- | --- |
| **P0** | `access-groups.md` §4 refactor: one `ROLE_DEFS` descriptor, `GET /api/roles`, client reads the list instead of a duplicated constant. | No |
| **P1** | DDL for the three tables (both dialects) + system-role seeding + `roles` claim on the token + `user_roles` read in `getUserById`. **No enforcement change, no UI.** | No — verified byte-identical |
| **P2** | Capabilities + the single visibility primitive, replacing `requireRoles` on the form-data routes only (§6). | **Yes — the risky one** |
| **P3** | Form Designer "Roles" section + inline role creation. | Yes (additive) |
| **P4** | Settings → Users additional-role grants. | Yes (additive) |
| **P5** | Access Groups catalog panel (editable, with usage counts). | Yes (additive) |
| **P6** | Audit trail: record effective-access decisions so "why can't I see this form?" is answerable from data. | No |

P1 must be **fully green before P2 starts**, because P1 is the last point at which the system is
trivially reversible (drop three unused tables).

---

## 9. Risks and traps

| # | Risk | Why it bites | Mitigation |
| --- | --- | --- | --- |
| **R1** | A system role's capabilities are seeded wrong, silently changing access | Nothing fails; a `staff` user just loses (or gains) a route | Capabilities are **derived from code on every boot**, and §10's probe diffs every route × every system role against today's answers |
| **R2** | Zero rows in `form_roles` read as "deny" | **Every existing form goes dark on deploy** | §4.8; the probe asserts an untouched form is reachable by all three system roles |
| **R3** | The list filter and the detail guard diverge | A row you can see 403s on open — the exact bug `access-groups.md` §2 row 11 fixed once already | One primitive (§4.7); the probe walks **every visible row** and opens it |
| **R4** | Deleting a custom role narrows access for people nobody looked at | Silent; the next report is a puzzled user | Usage counts in the delete dialog; `ON DELETE CASCADE`; the "why can't I see this" audit (P6) |
| **R5** | A new route is added later and forgets to choose | A route that should be capability-gated stays `requireRoles` and 403s a Reviewer — or worse, a new *unguarded* route | Add a route-count assertion to the test suite (the repo already does this for swagger path coverage); make the default path explicit in `server/src/roles.ts` |
| **R6** | A role from **another organization** is attachable | Cross-tenant leak — a role key is not unique across orgs | `organization_id` is checked on **both** the grant and the attach (§4.2/4.3); the probe attempts a cross-org attach and expects 400/404 |
| **R7** | The `users.role` CHECK is widened "for consistency" during P1 | Turns a custom role into a global role — the option D3 rejected — and makes it unremovable later | Comment the constraint as deliberate; the plan's §5.4 says so explicitly |
| **R8** | Custom roles are expected to gate field-level access and don't | `form_fields.roles` still holds system-role keys only; a Report Viewer sees fields per its system role | Deliberate (§11.2) and stated in the UI copy; §12 Q1 is the follow-up |
| **R9** | `[]` and "unscoped" get conflated in the UI | The admin cannot tell "I never set this" from "I set it to nothing" | The radio pair (§7.1), plus the explicit "Admins can still use this form" note |
| **R10** | Capabilities silently expand what a custom role can reach | `edit` on `submissions` is 11 call sites; one missed is an inconsistency | §6's rule — *only* form-data routes change — and the probe covers `edit` on every write path |
| **R11** | The token is treated as authoritative for a deleted role | — | It is not; the intersection (§4.9) makes deletion immediately effective. Stated because the intuition is the opposite |

---

## 10. Verification

### 10.1 Static (must be clean before any live check)

`server npm run typecheck` · `server npx vitest run` · `client npx tsc --noEmit` ·
`client npm run build` · `get_errors` on every touched file.

### 10.2 The regression probe — P2's whole safety argument

A throwaway `server/tmp-roles-probe.ts` (never `npx tsx -e`, which eats backticks) that, **before
and after** the P2 change, records the HTTP status for:

> **every** route in the form-data and admin groups × **each** of the three system roles ×
> {a form in the org, a form in another org, a form that does not exist}

and diffs the two tables. Any difference is a behaviour change and must be explained or fixed.
The probe must include **controls that are guaranteed to fail** (a deliberate syntax error and a
request to a route that does not exist) so a table of all-200s can be told apart from a harness
that is not running.

### 10.3 Live assertions

| # | Assertion |
| --- | --- |
| 1 | An untouched (zero-row) form is **viewable and editable** by `admin`, `staff` and `cdm_contact` — R2 |
| 2 | Attaching `Report Viewer` to a form as an admin does **not** change any system role's access — R1 |
| 3 | A user granted `Report Viewer` in an org whose form names it: `view` 200, `edit` **403**, `export` 200, `report` 200 |
| 4 | The same user on a form that does **not** name it: `view` 403 |
| 5 | The same user's forms list contains **exactly** the forms their visible set contains — R3, asserted as *set equality*, not a count |
| 6 | Every form id in the list opens without a 403 — the §4.7 invariant, walked row by row |
| 7 | A cross-org role id attached to a form → 400/404 — R6 |
| 8 | Granting a system role via `user_roles` → 400 with a message naming the real path — §4.4 |
| 9 | Deleting a custom role attached to a form leaves the form's other roles' access **unchanged** — R4 |
| 10 | A custom role's token claim cannot make it an admin: an org-admin route with a `Report Viewer` grant → 403 — D3 |

### 10.4 Browser

Log in as each of the three system roles plus one custom-role holder; confirm the forms grid, the
submissions grid, the Export modal and the Reports page are each visible-or-not as expected, and
that the Form Designer's Access section round-trips (attach → save → reload → persisted).

Remember the two standing environment facts: **Vite binds IPv4 only — use
`http://127.0.0.1:5173/`**, and **`tsx watch` does not reload `.env`** (a DB change needs a full
backend restart, not just a save).

---

## 11. What this plan deliberately does not do

**11.1 No per-form roster.** D3 grants custom roles org-wide. A person is a "School Reviewer"
everywhere their roles and the form's role list intersect. If you need *"a Reviewer on form 5
only"*, that is a fourth table and an n×m assignment UI (§12 Q4).

**11.2 Field-level access stays system-roles-only.** `form_fields.roles` keeps its JSON array of
system-role keys, and the Access buttons keep showing three options. The array *could* accept
custom keys with no migration (it is JSON) — but field access is read in the hot path of every
column filter, and a key-based match there would be a second, silently-diverging copy of the
same rule. Unify it later, deliberately (§12 Q1).

**11.3 No administrative capability.** No flag here grants Settings, Users, Schools, form design,
or submission deletion (§2, §4.6).

**11.4 No change to school scoping.** `isSchoolScoped` / `scopedSchoolId` / `canAccessSchool`
keep their exact meaning; `cdm_contact` remains the only school-scoped system role, and a custom
role's `school_scoped` flag plugs into the **same** two primitives rather than a new one.

**11.5 No per-workspace role.** `workspaces.md` §13.2 / §14.3 ask the same shape of question one
level up. This plan adds `organization_id` to `dbo.roles`, which is the join point those plans
would extend — but it does not answer §14.3, and it should not be read as having answered it.

**11.6 No public-route change.** A published form is reachable by anyone with the link, by
design. Role scoping governs the **admin/staff** surfaces, not the public one.

---

## 12. Open questions

1. **Should custom roles gate staff-only fields?** Today they cannot (§11.2). If "Report Viewer"
   should see a *narrower* set of columns than a staff member, that is a real requirement that
   changes §11.2 from "deferred" to "in scope".
2. **Is the 15-minute grant delay acceptable, or must a grant take effect immediately?** The
   cheap options are a shorter access-token life, or re-signing affected users' tokens on grant
   (which requires a token-version or a new `POST /auth/refresh` push — neither exists).
   Note `feature-backlog.md` §9.4 records that `token_version` is still absent.
3. **Should a form ever be editable by a non-admin?** Everything here keeps form *design*
   admin-only. "A School Reviewer who can add a field to their form" is a new decision.
4. **Should per-form user assignment exist at all** (the fourth table in §11.1)? If yes, is it a
   roster on the form, or a "reviewers for form X" filter over the org-wide grant?
5. **Are "School Reviewer" and "Report Viewer" the seed set, or examples?** If they are real,
   their capability sets should be fixed above and seeded per org so every org starts with them.
   If they are examples, the catalog starts empty and the only seeded rows are the three system
   roles.
6. **Does a custom role need a landing page?** `access-groups.md` §3.2 includes a `landing` field
   in `RoleDef`, because a role with no view of the forms grid needs somewhere to land. A pure
   "Report Viewer" with `view` granted lands on the forms grid; a role with `report` only would
   not. This plan assumes **every custom role has `view`** unless the admin clears it, and that
   clearing it is unusual.
7. **Should the role key be editable after creation?** Label, yes. Key, no (renaming a key that a
   token carries and a form names is more churn than value) — but confirm.

---

## 13. File-by-file change list

| File | Change |
| --- | --- |
| `server/src/db/schema.ts` | `RoleDef`/system-role constant; three `CREATE TABLE` statements + indexes in `SQLSERVER_DDL_STATEMENTS`; `FormRole`/`RoleRow` types; capabilities on `Role` |
| `server/src/db/dialect/turso.ts` | the same three tables, `CREATE TABLE IF NOT EXISTS` form |
| `server/src/db/index.ts` (or wherever `initDb` lives) | system-role seeding per organization, after the ladder |
| `server/src/roles.ts` | **new** — `heldRoleKeys`, `formCapabilities`, `visibleFormIds`, the capability type |
| `server/src/auth.ts` | `roles?: string[]` on `AccessPayload`; map it onto the session user in `requireAuth`; leave `requireRoles` and the school primitives untouched |
| `server/src/db/queries.ts` | `listRoles`, `createRole`, `updateRole`, `deleteRole`, `roleUsageCounts`; `rolesForForm`, `attachRoleToForm`, `detachRoleFromForm`; `customRolesForUser`, `grantRole`, `revokeRole`; a `visibleFormIds` parameter on `listForms` |
| `server/src/routes/auth.ts` | the four `signAccessToken(user)` call sites must pass a user carrying custom roles; `/refresh` already re-reads the user |
| `server/src/routes/forms.ts` | `GET /:id` → capability guard; `GET /` → visibility filter; `GET/PUT /:id/columns` → `view`/`edit`; **new** `GET/POST/DELETE /:id/roles` |
| `server/src/routes/roles.ts` | **new** — the catalog CRUD (`GET /`, `POST /`, `PUT /:id`, `DELETE /:id`) + usage counts |
| `server/src/routes/users.ts` | additional-role grants on create/update; reject a system role in that field |
| `server/src/routes/submissions.ts` | `can_view` on reads, `can_edit` on the 11 write sites; `DELETE` untouched |
| `server/src/routes/export/index.ts` (and friends) | `can_export` on top of the existing gates |
| `server/src/routes/reports.ts` | `can_report` for form-scoped reports; `REPORT_ROLES` stays for org-wide |
| `server/src/routes/documents.ts` | `can_view` on the owning form |
| `server/src/schemas.ts` | Zod for role create/update (key sanitising, mirroring `formCodeSchema`'s trim → lowercase → strip → refine shape), the attach/detach body, and the additional-role grant |
| `server/src/swagger.ts` | the new paths |
| `client/src/lib/api.ts` | role catalog, form roles, additional-role grants |
| `client/src/lib/settings.ts` | `ROLES` becomes the **fetched** system-role list (P0); `roleLabel`/menu defaults follow |
| `client/src/pages/admin/AdminFormDesigner.tsx` | the Access section, the inline create-role dialog, the unscoped radio pair |
| `client/src/pages/admin/AdminSettings.tsx` | Users panel additional-role group; Access Groups panel becomes editable; `CollapsibleSection` lifted if shared |
| `client/src/pages/admin/AdminForms.tsx` | **nothing required.** The file contains **zero** occurrences of `role` (measured), so the grid renders exactly whatever `GET /forms` returns — there is no client-side role filter to fight the server's visibility predicate |
| `client/src/types/index.ts` | `Role` union stays the **system** roles; a new `RoleDef`/`FormRole` type for the catalog |
| `docs/plans/access-groups.md` | cross-reference: mark §3.1 Option A as the P0 prerequisite, and point §5's read-only panel at this plan's editable version |
| `docs/plans/feature-backlog.md` | §7.4 → in progress, referencing this plan |
| `docs/plans/workspaces.md` | §15's relationship table gains a row for this plan (per-org roles are the join point §13.2 would extend) |
| `docs/guides/user-guide.md` | a section on roles and per-form access, once P3 ships |
