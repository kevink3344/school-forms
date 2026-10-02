# Plan — Admin-managed roles (Settings → Roles)

**Status:** Draft for review
**Date:** 2026-09-30
**Area:** Roles / Access control — runtime, admin-authored roles
**Absorbs:** [`reviewer-role.md`](./reviewer-role.md) (its census is the evidence; its route split is the capability map)
**Adopts from:** [`user-roles.md`](./user-roles.md) §4.2's catalog shape and §4.6's capability names — and **drops** its `dbo.user_roles` / `dbo.form_roles`, for the reason argued in §3.5
**Supersedes:** [`access-groups.md`](./access-groups.md) §3.1 recommendation of *Option A* — this is **Option B**, chosen deliberately
**Prerequisite:** [`access-groups.md`](./access-groups.md) §4 refactor (see §11 P1)
**Implementation status as of 2026-10-01:** see [`staff-only-field-access-toggles.md`](./staff-only-field-access-toggles.md) §6.1. Measured: the catalog, `/api/roles` CRUD, the Roles panel and `client/src/lib/roles.ts` are **built**; §8.3's client table is **rows 1–6 done, rows 7–9 not** (`HomeRedirect.tsx`, `layout.tsx` L333, `App.tsx` L137/147/157/167 still hold role-key lists, and they compose into a sign-in redirect cycle for any role outside `admin`/`staff`/`cdm_contact`); and §4/P5's `requireCapability` guards have **zero route call sites** — all 56 `requireRoles(...)` lists remain.

---

## 1. What was asked

> "There should be a Roles section in Settings, where admins can add roles. Once they are assigned
> though they cannot be deleted."

Two requirements:

1. **A Settings → Roles section** where an admin creates a role.
2. **A role that has been assigned cannot be deleted.**

Requirement 2 is the interesting one. It is not a UI nicety — it is the rule that makes
requirement 1 safe, and §5 shows it should be enforced by the **database**, not by application
code, because a role key is referenced from **five** places and only one of them is a foreign key.

---

## 2. ★ The one move the whole design turns on

> **An unset access list must stop meaning "the roles that exist today" and start meaning
> "every role, including ones that do not exist yet."**

Today, four pure functions materialise the current role list:

| Function | File | Today | Problem once roles are data |
| --- | --- | --- | --- |
| `fieldAccessRoles(field)` | `db/schema.ts` L140-143 | `null` → `[...ROLES]` | returns a **snapshot** |
| `messageAudienceRoles(raw)` | `db/schema.ts` L1309-1325 | `null` → `[...ROLES]` | returns a **snapshot** |
| `parseDocumentRoles(raw)` | `routes/settings.ts` L110-121 | blank → `[...ROLES]` | returns a **snapshot** |
| `defaultMenuItems()` | `routes/settings.ts` L68-72 | `[...ROLES]` per key | returns a **snapshot** |

**None of them can ask the database.** `fieldAccessRoles` takes a field and returns a list; it is
called from `canSeeField` inside row-mapping code. `defaultMenuItems` is called from
`defaultValue(key)`, a pure function. Making them `async` would push a query into every row of
every list response.

So if `ROLES` becomes "the built-in keys", all four silently freeze at three roles. A role an
admin creates tomorrow is excluded from every staff-only field, every message audience, the
Documents link and both menus — **and nothing errors.**

### 2.1 The current code already makes this promise — and `[...ROLES]` is what breaks it

This is not my preference; it is the existing stated contract. `db/schema.ts` L1302-1305, verbatim:

> `NULL/undefined = unset, which resolves to every current role (so a message authored before`
> `audiences existed is shown to everybody, and a role added later is included rather than`
> `silently excluded).`

*"a role added later is included rather than silently excluded"* — `[...ROLES]` cannot keep that
promise the moment `ROLES` stops being the complete set. The function that documents
forward-compatibility is the one that would break it. The fix is to make the returned value a
**sentinel** rather than an expanded list.

### 2.2 The change

Keep the return type `string[] | null`, and give `null` the meaning it already has at the storage
layer — **unrestricted**:

| Function | New contract |
| --- | --- |
| `fieldAccessRoles` | `null` when unset (**was:** `[...ROLES]`); `[]` stays `[]` |
| `canSeeField` | `roles === null ? true : roles.includes(viewer)` |
| `messageAudienceRoles` | `null` when unset (**was:** `[...ROLES]`) |
| `parseDocumentRoles` | `null` when blank (**was:** `[...ROLES]`) |
| `documentRolesInclude(roles, role)` | `roles === null \|\| roles.includes(role)` |
| `parseMenuItems` | `null` per key when unset; **drop the `ROLES.filter(...)` normalisation** (see §2.3) |
| `defaultMenuItems` | `null` per key, i.e. "everyone" — no list at all |

`null` = "unrestricted" and `[]` = "nobody". That two-valued distinction **already exists** and is
already pinned by tests (`system-messages.test.ts` L156-161 asserts `[]` and `null` differ). This
plan does not invent it; it removes the third state (`[...ROLES]`) that collapsed onto "the roles
that happen to exist right now".

### 2.3 Two bonuses this refactor collects on the way

**A. It fixes a documented silent failure.** `parseMenuItems` L93 does
`(ROLES as readonly Role[]).filter((r) => v.includes(r))` — it **drops unknown roles**. So a
stored `menu_items` row written before a role existed filters that role out, while a *missing* key
defaults to "everyone" and includes it. The same configuration therefore behaves differently
depending on whether anyone ever opened the Menu Settings panel. Removing the filter (the write
path is validated; the normalisation is a second, weaker copy of that validation) removes the
asymmetry.

**B. It is independently valuable.** This refactor is what makes *any* new role work in field
access, message audiences, Documents and menus — **including a code-defined one.** It should land
even if this plan's Settings screen were never built. See §11 P2.

### 2.4 ⚠️ A live latent bug found while measuring

`server/src/schemas.ts` L356:

```ts
const audienceSchema = z.array(z.enum(ROLES)).max(ROLES.length);
```

`.max(ROLES.length)` caps the audience array at **3** — the number of built-in roles. A message
addressed to four roles is **rejected by the schema** before any handler sees it. This is the
"blanket bound set to the widest member of a limit set" trap: the cap is derived from the field
set, so it can never be looser than the thing it is supposed to allow.

It also makes `z.enum(ROLES)` the gate, whose rejection message names an enum the admin cannot
edit. Under this plan both go: `z.array(z.string())` with a generous absolute bound (e.g. `.max(64)`),
and role-existence becomes a **handler lookup** — a `BAD_REQUEST`, not a `VALIDATION_FAILED`,
matching the layering convention this codebase already documents. §8.2.

*(Correctness note: this bug is currently unreachable because only three roles exist. It becomes
reachable the instant a fourth is created — by this plan or by `reviewer-role.md`.)*

---

## 3. Data model — `dbo.roles`

### 3.1 Scoping: installation-wide, not per-org

**Measured:** `dbo.app_settings` is `PRIMARY KEY ([key])` with **no organization column**
(`db/schema.ts` L971-976), and `getSetting(key)` selects on `[key]` alone (`db/queries.ts` L194-201).
So `menu_items` and `documents_link` are already **installation-wide**. `users.role` is a bare
`NVARCHAR(20)` and the JWT carries a bare `role` claim.

Roles should follow: **one global catalog.** Per-org roles would require

- a composite key, so `users.role` becomes `(organization_id, role)` and the token grows a
  second tenant-scoped claim;
- a composite FK, which SQL Server permits but which makes every role comparison carry an org;
- a `dbo.roles` uniqueness rule per org, so two orgs can define the same key differently.

…to buy a distinction that `app_settings` does not currently make anywhere. **Recommend global;
note that it means one org's admin can create a role visible to other orgs** (they cannot *assign*
it across orgs — `users.ts` already enforces same-tenant — but they will see it in the list).
Surface this; do not decide it silently.

### 3.2 Table

```sql
IF OBJECT_ID('dbo.roles', 'U') IS NULL
CREATE TABLE dbo.roles (
  role_key      NVARCHAR(20)  NOT NULL PRIMARY KEY,
  label         NVARCHAR(60)  NOT NULL,
  description   NVARCHAR(200) NULL,
  badge         NVARCHAR(20)  NOT NULL CONSTRAINT DF_roles_badge DEFAULT 'badge-gray',
  sort_order    INT           NOT NULL CONSTRAINT DF_roles_sort DEFAULT 0,
  is_admin      BIT           NOT NULL CONSTRAINT DF_roles_is_admin DEFAULT 0,
  can_view      BIT           NOT NULL CONSTRAINT DF_roles_view DEFAULT 1,
  can_edit      BIT           NOT NULL CONSTRAINT DF_roles_edit DEFAULT 0,
  can_export    BIT           NOT NULL CONSTRAINT DF_roles_export DEFAULT 0,
  can_report    BIT           NOT NULL CONSTRAINT DF_roles_report DEFAULT 0,
  school_scoped BIT           NOT NULL CONSTRAINT DF_roles_school DEFAULT 0,
  built_in      BIT           NOT NULL CONSTRAINT DF_roles_built_in DEFAULT 0,
  created_at    DATETIME2     NOT NULL CONSTRAINT DF_roles_created DEFAULT SYSUTCDATETIME()
);
```

**Seed (idempotent, one statement per row or a single guarded block):**

| key | label | badge | admin | view | edit | export | report | school | built_in |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `admin` | Admin | `badge-orange` | ✔ | ✔ | ✔ | ✔ | ✔ | – | ✔ |
| `staff` | Staff | `badge-blue` | – | ✔ | ✔ | ✔ | ✔ | – | ✔ |
| `cdm_contact` | School Contact | `badge-teal` | – | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `reviewer` | Reviewer | `badge-gray` | – | ✔ | – | ✔ | ✔ | – | ✔ |

The `report` column is ✔ on all three existing roles because `server/src/routes/reports.ts` L40
holds `REPORT_ROLES = ["staff", "cdm_contact", "admin"] as const` — every current role has it, so
seeding anything less would change behaviour (§10.2).

**Defaults protect the admin-authored case.** A role created through the API gets
`is_admin=0, can_view=1, can_edit=0, can_export=0, can_report=0, school_scoped=0, built_in=0` — a
**read-only, org-wide** role. It cannot be created as an admin, and it cannot be created with write
capability unless the admin asked for it. Defaulting to `can_edit=0` is the choice that keeps a
mis-click from granting write access to 21 routes.

**★ `built_in = 1` rows have their flags re-derived from code on every boot.** For the four seeded
keys, `label` / `badge` / capability flags are written from a code constant at the end of `initDb`,
so a hand-run `UPDATE dbo.roles SET can_edit = 1 WHERE role_key = 'staff'` is **overwritten on the
next restart**. This is `user-roles.md` §4.2's `is_system` rule under a different column name, and
it is what makes `admin` un-escalatable by a database edit as well as by the API (§7.2). Capability
edits are honoured **only** on `built_in = 0` rows — so the Settings panel must render the four
built-ins' capability checkboxes **disabled**, or an admin will toggle one, see it save, and watch it
revert at the next deploy.

### 3.3 The four built-ins, and why `reviewer` is one

The user named four roles. `reviewer` should be **seeded as a built-in** so that:

- it cannot be deleted (§5) — the four named roles are permanent;
- its read-only semantics come from `can_edit = 0` on a row, **not** from `"reviewer"` being
  appended to some route lists and omitted from others. That deletes `reviewer-role.md`'s entire
  risk class R4 ("something completes the list and grants a write path") — there is no list to
  complete.

Admin-authored roles then layer on top. This is strictly more work than `reviewer-role.md` alone
and strictly less fragile.

### 3.4 The key is immutable; the label is not

The key is stored **verbatim** in four JSON blobs, not just in `users.role`:

| Store | Column / key |
| --- | --- |
| `dbo.users` | `role` (FK — §5) |
| `dbo.form_fields` | `roles` (JSON array) |
| `dbo.system_messages` | `audience` (JSON array) |
| `dbo.app_settings` | `menu_items` (JSON object of arrays) |
| `dbo.app_settings` | `documents_link` (JSON array) |

Renaming a key therefore means rewriting five stores, three of which have no schema. **The API
must allow editing `label`, `badge`, `sort_order` and the capability flags, and must reject any
change to `role_key`** (404 on a body key that differs, or simply no such field). Show the key
read-only in the UI with a note saying why, or the first support ticket will be "can I rename this".

### 3.5 Reconciliation with `user-roles.md` §4 — and why this plan does **not** use `dbo.user_roles`

`user-roles.md` §4.2–§4.4 already designed a `dbo.roles` catalog, a `dbo.form_roles` attachment
table and a `dbo.user_roles` grant table. This plan **adopts the catalog and drops the other two**,
and the reason is a single sentence in that document.

> `user-roles.md` §4.6: **"Capabilities union, they do not intersect."**

That model has two channels: the **system** role on `users.role` (one value, mutually exclusive) and
**custom** grants in `dbo.user_roles` (many per user, unioned with it). Under a union, a custom role
can only ever *add* capability — it can never take any away. So granting a *read-only* `reviewer`
custom role to a `staff` user yields `staff ∪ reviewer = staff`, i.e. **still write access**.
**The union channel cannot express a restrictive role at all** — and every role the user named
(Admin, Staff, School Contact, Reviewer) is restrictive relative to the others.

A role of this kind must therefore live in the **mutually-exclusive** channel, which means
`users.role` itself has to accept a non-system key. That is exactly what §3.2 and §6 do, and it is
why `dbo.user_roles` and `dbo.form_roles` are **out of scope here**: this is the *"system roles
only"* subset (request #6), and it is the version the user asked for.

**What is adopted verbatim from `user-roles.md`:**

| From | What | Where it lands |
| --- | --- | --- |
| §4.2 | `description` and `can_report` columns | §3.2 (this plan sizes `description` at 200, not 400) |
| §4.2 | **system rows re-derived from code every boot** (its `is_system`) | §3.2's `built_in` + the `★` rule below the seed |
| §4.2 | the seed-capability table (all three identical; only scoping differs) | §3.2 seed, extended with `reviewer` |
| §4.6 | capability names: `view` / `edit` / `export` / `report` | §4.2 |
| §4.6 | admin is **not** a capability — it short-circuits | §4.3's `is_admin ||` prefix |
| §4.5 | the dangling-key hazard in the JSON stores | §5.3 (the resurrection hole) |

**Two divergences, both deliberate:**

1. **No `organization_id` on `dbo.roles`.** `user-roles.md` §4.2 makes a role belong to one org, with
   `UNIQUE (organization_id, key)`. That is incompatible with the FK this plan relies on for
   "cannot be deleted" (§5.1): `users.role` holds a **key**, so an FK on it requires the key to be
   **globally** unique — and a per-org catalog permits the same key in two orgs. Keeping the catalog
   per-org *and* keeping the FK would mean `users.role` holding a role **id**, which changes the
   token, the 21 guards and every client `role === "staff"` comparison. **The FK is what makes the
   deletion rule enforceable at the database rather than in one handler (§5.1), so the FK wins.**
   Consequence: role keys are installation-wide — the same boundary `app_settings` already has (§3.1).
2. **No `dbo.form_roles` attachment.** That is the per-form feature, deferred by request #6. Dropping
   it also drops `user-roles.md` §4.7's `visibleFormIds()` primitive, so §4.3's check is a **global**
   capability on the role, not a per-form one. Adding per-form later *narrows* a global capability,
   which is additive to this design (`formCapabilities()` becomes `globalCaps ∧ formMembership`).
   Nothing here has to be undone to get there.

**★ The generalisable lesson, because it will come up again:** *an additive (union) grant model
cannot express a role whose purpose is to have less.* Whenever a role list mixes roles that **add**
powers with roles that describe a **lower-privilege job**, the two need different channels — and the
lower-privilege one must be mutually exclusive with the higher one, or it is decoration.

---

## 4. What a new role can actually do

Requirement 1 says an admin can add a role. It does not say what the role can reach — and that is
the decision the design turns on, because the app currently answers it with **21 identical
three-role lists**.

### 4.1 The 21 sites, already measured and already split

`reviewer-role.md` §4 catalogued every `requireRoles(...)` site. That split **is** the capability
map:

| Group | Sites | Capability |
| --- | --- | --- |
| Reads (forms list, submissions list/detail, archive counts, ad-hoc read, documents read, PDF, export preview) | 11 | `can_view` |
| Reports (`routes/reports.ts` — the `REPORT_ROLES` constant at L40) | 1 constant | `can_report` |
| Writes (status, archive, restore, values, ad-hoc write, column settings, document retry/regenerate) | 10 | `can_edit` |
| Deliberate binary exports (`export.ts` `/csv`, documents `/pdf`) | 2 (overlap above) | `can_export` |
| `requireRoles("admin")` (users, schools, settings, form create/update, submission delete, seed-staff) | ~14 | `is_admin` |

### 4.2 Options

| | **Option 1 — level** | **Option 2 — capability flags** *(recommended)* |
| --- | --- | --- |
| A new role gets | the same access as `staff` | `can_view` only |
| Guard becomes | `requireLevel(user.role) !== null` | `requireCapability("view" \| "edit" \| "export" \| "report")` |
| Route edits | ~21 sites, once | ~21 sites, once |
| Read-only role | **not expressible** | expressible (`can_edit = 0`) |
| Surprise on create | a new role can write to 21 routes immediately | nothing until the admin ticks a box |
| Matches `access-groups.md` §3.1 warning? | ❌ "a new role silently gains access" | ✔ least privilege by default |

**Recommend Option 2.** Both cost the same ~21 edits; only one of them defaults a new role to
*no write access*, and only one can express the read-only Reviewer that started this thread.

### 4.3 Mechanics — and the one thing that must be cached

`requireRoles(...)` is synchronous middleware. A capability check needs the role's flags, so
**load `dbo.roles` into memory at boot** and read the capabilities from that map. `requireRoles`
keeps its exact shape; the flags are looked up:

```
requireCapability("view")  → is_admin || can_view
requireCapability("edit")  → is_admin || can_edit
requireCapability("export")→ is_admin || can_export
requireCapability("report")→ is_admin || can_report
requireAdmin()             → is_admin
```

Invalidate the cache on every role write (create / update / delete). **This is correct only while
the server is one process.** `server/src/index.ts` runs a single `app.listen`, so it is today — but
on App Service scale-out a second instance would keep serving stale capabilities indefinitely.
Mitigation: a short TTL (30 s) in front of the cache, so a stale window is bounded rather than
infinite. Flag this; do not discover it during an incident.

**Unknown role → no capability.** A token naming a role that no longer exists must resolve to
*nothing*, never to a default. Same shape as `null` vs `[]`: the failure direction is chosen, not
inherited.

---

## 5. "Once assigned, it cannot be deleted"

### 5.1 The foreign key *is* the rule

```sql
ALTER TABLE dbo.users
  ADD CONSTRAINT FK_users_role FOREIGN KEY (role) REFERENCES dbo.roles(role_key);
```

No `ON DELETE` clause — SQL Server's default is `NO ACTION`, which **refuses to delete a role that
any user holds.** The application-level 409 is then a *message*, not the enforcement. This is the
right place for the rule: it cannot be bypassed by a future route, a migration script, or a
manual `DELETE FROM dbo.roles` in a query window.

Contrast with the alternative — checking `SELECT COUNT(*) FROM users WHERE role = @key` in the
handler — which is correct until something writes to the table another way.

### 5.2 But the FK only covers one of the five stores

`dbo.users` is a foreign key. `form_fields.roles`, `system_messages.audience`, `menu_items` and
`documents_link` are **JSON blobs with no schema**, and SQL Server does not enforce anything
inside them. A delete that satisfied only the FK would leave four dangling tokens.

**Measured severity: it fails safe.** Every JSON store treats a *dangling* token as absent, and
every one of them treats `null` as "everyone". So deleting a referenced role **narrows** access —
it cannot widen it. That is the correct failure direction and it is why this is not a
data-integrity emergency.

**But it is not harmless, because of §5.3.**

### 5.3 ★ The resurrection hole

Delete the key `counselor` while `form_fields.roles` still contains `"counselor"`, then create a
new role also called `counselor`. **The new role immediately inherits every field grant, message
audience and menu entry the old role had** — a grant nobody made, applied to a role the admin
believes is brand new.

The rule that closes it is the same rule the user asked for, stated precisely:

> **A role may be deleted only when it is referenced nowhere** — not by a user, and not by any of
> the four JSON stores.

A deleted role then has zero references by construction, so re-creating its key restores nothing.
This makes *"once assigned it cannot be deleted"* the whole rule rather than a partial one, and it
is why the delete guard must scan all five stores and not just `users`.

### 5.4 The reference census reuses three helpers that already exist

| # | Store | How to count references |
| --- | --- | --- |
| 1 | `dbo.users.role` | **the FK** — just attempt the delete and map error 547 to 409 |
| 2 | `dbo.system_messages.audience` | **`audienceLikePattern(role)`** (`queries.ts` L2603) + `WHERE audience LIKE @p ESCAPE '\'`. Already written, already tested (`system-messages.test.ts` L242-249) |
| 3 | `dbo.form_fields.roles` | parse in app code (forms are few — 3 live) — dialect-free |
| 4 | `app_settings` `menu_items` | **`parseMenuItems(raw)`** (`routes/settings.ts` L78) |
| 5 | `app_settings` `documents_link` | **`parseDocumentRoles(raw)`** (`routes/settings.ts` L110) |

Only #2 needs SQL, and its predicate already exists. Reusing `audienceLikePattern` is not just
economy: it is the one predicate the codebase has already reasoned about (`"staff"` must not match
a role ending in `staff`, and `cdm_contact`'s underscore must be escaped) — a hand-written second
version would be a second chance to get that wrong.

**Recommendation:** attempt the FK delete first (authoritative, free), and if it fails, run the
JSON census to *enrich the error message* — so the 409 says **which** stores block it, not just
"in use". Otherwise the admin sees a count of users and the real blocker is a message audience.

### 5.5 Two undeletable classes

| Class | Rule | Reason |
| --- | --- | --- |
| `built_in = 1` | **never deletable** | the four named roles must exist; `admin` above all |
| referenced (§5.2-5.3) | refused, 409 naming every blocking store | the user's requirement |
| otherwise | deletable | nothing references it, so nothing can be resurrected |

`admin` needs the explicit `built_in` guard rather than relying on "an admin always exists":
the FK only blocks deletion while ≥1 user holds `admin`, and an installation with **zero** admins
should still not be able to drop the `admin` role from the catalog.

---

## 6. Removing the `CHECK` constraint — the DDL, in order

`users.role` currently carries `CHECK (role IN ('admin','staff','cdm_contact'))`. A static
`IN`-list cannot express a runtime catalog, so it must be **replaced by the FK** (§5.1).

### 6.1 Three ordered edits to `SQLSERVER_DDL_STATEMENTS`

| # | Edit | Note |
| --- | --- | --- |
| **1** | Insert the `dbo.roles` CREATE + seed **before** the `dbo.users` statement | the FK target must exist; on a fresh DB this is a reorder in the array, not just an append |
| **2** | In `CREATE TABLE dbo.users` (L609): `role NVARCHAR(20) NOT NULL` — drop the inline `CHECK`, add the FK inline | fresh databases never grow the constraint |
| **3** | Append a migration block **after** the existing `cdm_contact` widening block (L647-666) that (a) drops any remaining CHECK on `role`, (b) adds `FK_users_role` if absent | existing deployments |

### 6.2 Idempotency and the interaction with the existing `cdm_contact` block

The `cdm_contact` block is keyed on `definition NOT LIKE '%cdm_contact%'`. After this plan's
block drops the CHECK, that sentinel matches nothing, so the `IF EXISTS` is false and the block
**no-ops** — which is correct, but only because the new block runs **after** it. Reversed, the
widening block would run on a database that is about to lose the constraint entirely, and a
future reader would find a migration that adds a constraint nothing enforces.

**Do not edit the existing block.** It is already applied in production; rewriting an applied
migration is how a ladder stops being idempotent. Append alongside it.

### 6.3 Turso / libSQL

`dialect/turso.ts` L77 declares the same inline `CHECK` in the final `CREATE TABLE IF NOT EXISTS`
shape, and ports none of the ladder (`schema.ts` L359-364). So:

- **New** Turso databases get a correct shape if L77 is edited.
- **Existing** Turso databases cannot lose the CHECK — **SQLite has no `ALTER TABLE ... DROP
  CONSTRAINT`**; it needs a full 12-step table rebuild.

Active mode is `DB_MODE=sqlserver`, so this is not a blocker. It must be *stated*, because the
symptom is `CHECK constraint failed` at role-assignment time with no obvious remedy. Options when
it matters: a table-rebuild migration, or recreate the Turso environment.

---

## 7. The API

Follows `routes/settings.ts` (the org-less settings router) as the template.

| Method | Path | Guard | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/roles` | any authenticated | **the single source of truth** the client stops re-declaring |
| `POST` | `/api/roles` | `requireAdmin` | body `{ key, label, description?, badge?, can_view?, can_edit?, can_export?, can_report?, school_scoped? }`; `is_admin` and `built_in` **never** settable; key is validated + normalised + uniqueness-checked → **409** |
| `PUT` | `/api/roles/:key` | `requireAdmin` | label / badge / sort_order / capability flags only; `role_key` change → **400** |
| `DELETE` | `/api/roles/:key` | `requireAdmin` | §5; **409** naming every blocking store |
| `GET` | `/api/roles/:key/usage` | `requireAdmin` | optional — powers the "Assigned to 4 users, used by 2 forms, 1 message audience" line before the admin clicks Delete |

### 7.1 Validation layering (this codebase already distinguishes the two 400s)

| Failure | Code | Where |
| --- | --- | --- |
| body is the wrong **shape** (missing `label`, `can_edit` not a boolean) | `400 VALIDATION_FAILED` | Zod, via `safeParse` |
| `key` is malformed / already exists / **is a built-in** | `409` | handler lookup |
| `role_key` differs from the path param on `PUT` | `400 BAD_REQUEST` | handler |

So `createRoleSchema` does **not** carry `z.enum(ROLES)` — role *existence* is a query, and a rule
whose answer is a query belongs in the handler (§2.4).

### 7.2 Key rules

- `role_key` — lowercase, `^[a-z][a-z0-9_]{1,19}$`, **stored verbatim** and immutable (§3.4).
  Derive it from the label on create if not supplied, and show the result before saving.
- `ADMIN` / `Admin` must normalise to `admin` before the uniqueness check, or an admin creates a
  role that displays identically and shadows nothing — and the route guards, which compare
  case-sensitively, will not recognise it.
- `built_in` is never client-settable.

---

## 8. The Settings → Roles section

### 8.1 Placement

The Settings page uses `<CollapsibleSection>` panels (not tabs). Existing order, measured:
**Users** (L836), Login Mode (916), Documents Link (1004), Menu Settings (1059), Slack (1132),
Webhook Log (1182), System Messages (1237), Organizations (1356), Schools (1411).

**Put Roles immediately after Users** — the two panels are one workflow (define a role, then
assign it), and Users is where `roleBadge()` is rendered.

### 8.2 The panel

| Column | Content |
| --- | --- |
| Role | badge (from `badge` column) + label |
| Key | monospace, **read-only**, with a note that it is stored in form fields, message audiences and menus and therefore cannot be renamed |
| Access | `Admin` / read-only / read + edit / + export — rendered from the flags |
| School-scoped | yes/no |
| Users | count (links to the Users panel) |
| Actions | Edit (label/flags) · Delete |

**Delete affordance.** Render the button **disabled with a tooltip naming why** when the role is
`built_in` or has any reference — do not hide it, and do not rely on the 409 alone. A disabled
control that says *"Assigned to 4 users and used by 1 message audience"* teaches the rule; a
button that fails on click teaches nothing. The tooltip text must be **derived from the same
census** the API uses (§5.4), not written separately — two copies of the blocking rule is the
`form_fields.roles` divergence hazard one layer up.

**An empty state** is required for a fresh install and must say what a role *is*, not just
"no roles" — every installation starts with the four built-ins, so the truthful empty state is
"4 built-in roles; add your own below".

### 8.3 Client plumbing

`client/src/types/index.ts` L3 — `export type Role = string`. **Note the trade explicitly:**
roles are now data, so the `Role` union stops being able to enumerate them, and the compile-time
exhaustiveness that today catches a forgotten role (`ROLE_AUDIENCE_LABELS: Record<Role,string>`,
`roleBadge(role: Role)`) is **replaced by a runtime fetch**. That is the price of Option B and it
is why `GET /api/roles` must be the *only* list the client holds. Every hard-coded client list
becomes a fetch:

| File | Today | Change |
| --- | --- | --- |
| `client/src/lib/settings.ts` L5 | `ROLES: Role[]` | delete — fetch |
| `client/src/lib/settings.ts` L15 | `ROLE_AUDIENCE_LABELS: Record<Role,string>` | keyed map from the fetched roles |
| `client/src/pages/admin/AdminFormDesigner.tsx` L22 | local `ROLES` | fetched |
| `client/src/pages/admin/AdminFormDesigner.tsx` L26 | `roleLabel(role)` | `role.label` from the fetched map |
| `client/src/pages/admin/AdminSettings.tsx` L47 | `roleBadge(role: Role)` if-chain | `role.badge` from the fetched map |
| `client/src/pages/admin/AdminSettings.tsx` L1726 | `<option value="cdm_contact">` | render the fetched list |
| `client/src/pages/HomeRedirect.tsx` L7 | `admin`→`/admin`, `staff\|\|cdm_contact`→`/staff`, **else `/login`** | route by **capability**: `is_admin`→`/admin`, else `/staff`. **The `/login` fall-through is an infinite redirect loop for an unrecognised role** |
| `client/src/components/layout.tsx` L323 | nav gated on `staff \|\| cdm_contact` | gate on capability, not on a role list |
| `client/src/App.tsx` L137/147/157/167 | 4× `<ProtectedRoute roles={["staff","cdm_contact"]}>` | capability-based guard |

`HomeRedirect` and `layout.tsx` are the two that fail **silently and totally** (an authenticated
user cannot sign in; an empty sidebar), and they are the reason the client cannot be half-migrated.

---

## 9. ★ What breaks — gates, in order of how quietly they fail

| # | Gate | Failure mode | Sev |
| --- | --- | --- | --- |
| **G1** | `system-messages.test.ts` **L139, 140, 147, 148, 183** — `expect(messageAudienceRoles(null)).toEqual([...ROLES])` | **hard test failure once §2 lands.** These 5 assertions *are* the contract being changed. Rewrite them to assert the sentinel (`null` = everyone) and keep L156-161 (`[] !== null`) | 🔴 deliberate |
| **G2** | `system-messages.test.ts` **L442-451** — "parses `audience` in exactly one place" → `expect(callers).toEqual(["toSystemMessage"])` | a **source scanner** over `queries.ts`; any new caller of `messageAudienceRoles(` fails it, and the message reads as a design rule | 🔴 |
| **G3** | `submissions-archive.test.ts` **L595 / L614** — asserts the literal `requireRoles("staff", "cdm_contact", "admin")` and a CONTROL that the delete route's list differs | breaks under §4 if the archive/restore guard becomes a capability check | 🔴 |
| **G4** | `system-messages.test.ts` **L242-249** — the `audienceLikePattern` escaping | must keep passing; §5.4 reuses this predicate, so if it were wrong the delete census would be wrong too | 🟠 |
| **G5** | `schemas.ts` **L356** `.max(ROLES.length)` | latent (§2.4) — becomes reachable at 4 roles | 🟠 |
| **G6** | `db/driver/libsql.test.ts` bans `TOP n` and other SQL-Server-isms from shared files | any census SQL must sit in the dialect layer, or stay app-side | 🟠 |
| **G7** | `db/system-messages.test.ts` L64 imports `ROLES` from `schema.js` | if `ROLES` is repurposed as "built-ins", the import still resolves but the *meaning* changes — check every importer | 🟡 |
| **G8** | — no test covers `fieldAccessRoles` directly (measured) | so the sentinel change is **unguarded**. Add tests; do not read a green suite as evidence | 🟡 |

**G1 and G3 are tests whose *claim* is being deliberately superseded.** That is legitimate — but
the rewritten assertion must carry the reason, or the next reader reverts it. Same discipline as
`system-messages.test.ts`'s existing long messages.

---

## 10. Verification

### 10.1 Static
`server npm run typecheck` · `server npx vitest run` · `client npx tsc --noEmit` ·
`client npm run build` · `get_errors` on every touched file.

### 10.2 The inherited-regression probe (the important one)
For each of `admin` / `staff` / `cdm_contact` / `reviewer`, record the HTTP status of **every**
route in §4.1 and §4.2 **before and after**. Expected diff:

- §2's refactor alone: **zero differences** for all four roles. This is the evidence that a
  sentinel replacing a materialised list is behaviour-preserving.
- §4's capability change: only the `reviewer` row changes, and only in the direction of *fewer*
  200s. Any change in an existing role's row is a bug.

Run it as `server/tmp-roles-probe.ts` — **a file, never `npx tsx -e`** (the shell eats backticks in
template-literal SQL). It must include **controls that are guaranteed to fail** (a deliberate
syntax error, and a route that does not exist), or a table of all-PASS results cannot be
distinguished from a harness that runs nothing.

### 10.3 Live assertions

| # | Assertion | What it proves |
| --- | --- | --- |
| 1 | Create a role via `POST /api/roles` → 201; `GET /api/roles` contains it | requirement 1 |
| 2 | Assign it to a user → `DELETE /api/roles/:key` → **409**, message naming the user count | requirement 2, the happy path |
| 3 | Delete it via raw SQL `DELETE FROM dbo.roles WHERE role_key=…` → **FK error 547** | **the DB enforces it, not the handler** — this is the assertion that distinguishes a real guard from a checked one |
| 4 | Un-assign the user, then delete → 204; then `GET /api/roles` no longer lists it | the rule is not "roles are undeletable" |
| 5 | Create a role, put it in a **message audience**, un-assign all users, `DELETE` → **409** naming the message store | §5.2 |
| 6 | Create `counselor`, grant it a staff-only field, **delete it without clearing the field**, recreate `counselor` → the field grant is **still there**, then delete the field reference and delete the role → recreate → the grant is **gone** | **§5.3's resurrection hole, both directions.** Assertion 6 is the one that proves the census is complete rather than convenient |
| 7 | Delete `admin` → refused | `built_in` |
| 8 | `POST /api/roles` with `is_admin: true` → the flag is not settable | no escalation |
| 9 | `POST` with key `ADMIN` → 409 (normalised first) | §7.2 |
| 10 | `PUT` changing `role_key` → 400 | §3.4 |
| 11 | A role with `can_edit=0` gets **403** on each of the 10 write routes — asserted **per route, not as a count** | §4.2 |
| 12 | A role with `can_view=1, can_edit=0` gets **200** on each read route | the role is not merely broken |
| 13 | A token naming a role deleted since issue → capabilities resolve to **none** (403 everywhere), not to a default | §4.3 |
| 14 | A `cdm_contact` is still school-scoped, and a `school_scoped=1` admin-created role is too | `isSchoolScoped` is now data, not a code branch |
| 15 | A field with `roles = NULL` is visible to a role **created after the field** | **§2's entire rationale** — the assertion that fails today |
| 16 | A message with `audience = NULL` is visible to a role created after it | same |

Assertions 15 and 16 are the ones that make this plan worth doing. Under `[...ROLES]` they fail;
under the sentinel they pass. If they are not written, §2 looks like a refactor rather than a fix.

Assertion 3's "per route, not as a count" matters for the same reason as `reviewer-role.md` §10.3:
a count of 403s cannot tell "every write route refused" from "one route refused ten times".
Assertion 6 needs its **second** half or it cannot distinguish a complete census from one that
happens to look complete.

### 10.4 Browser
Sign in as an admin; create a role; confirm it appears in the Roles panel **and** in the Users
assignment dropdown **and** in the form designer's field-access toggles **and** the message-audience
control — four surfaces, because each was a separate hard-coded list. Then assign it, and confirm
the Delete button is **disabled with a reason** rather than failing on click.

Standing environment facts: **Vite binds IPv4 only — use `http://127.0.0.1:5173/`**;
**`tsx watch` does not reload `.env`** (a DB/env change needs a full backend restart).

---

## 11. Phasing

| Phase | Content | Why here |
| --- | --- | --- |
| **P1** | `access-groups.md` §4 — `ROLE_DEFS` descriptor + `GET /api/roles`; client fetches instead of re-declaring | **required by everything else**; removes the duplicated client lists that §8.3 otherwise has to fix twice |
| **P2** | **§2 only** — the `null` sentinel in 4 functions + `canSeeField`, with tests G1/G8 rewritten | **independently valuable and independently shippable.** Makes any future role work in field access / audiences / docs / menus. Zero schema change. Do this even if the rest is cancelled |
| **P3** | `dbo.roles` + seed + FK + drop the CHECK (§3, §6) | schema; two dialects |
| **P4** | `/api/roles` CRUD + the delete census from §5.4 | requirement 1 + 2 |
| **P5** | Capability flags + guard helpers + the 21 route groups (§4) | the behavioural change; needs P2's probe as its safety net |
| **P6** | Settings → Roles panel (§8) | requirement 1's UI |
| **P7** | swagger (8 role enums), docs, user guide | — |

**P2 is the highest value per unit of risk and should land first** — it is testable with no UI, no
migration, and no new table.

---

## 12. What this plan deliberately does not do

**12.1 No per-form roles.** A role is the same everywhere (the earlier decision stands). A role
*cannot* be "Reviewer on form 5 but not form 6". Per-form attachment remains designed in
[`user-roles.md`](./user-roles.md) §4.3.

**12.2 No multi-role users.** `users.role` stays single-valued, so roles remain mutually
exclusive. Additive grants need a join table and a token change (`user-roles.md` §4.4).

**12.3 No per-role route authoring.** An admin cannot invent a capability. The capability set is
fixed at `view` / `edit` / `export` / `admin`; only their *combination* is configurable. Letting an
admin name a route would make the admin UI a control plane for the API surface, which is not what
was asked and is much harder to reason about.

**12.4 No escaping from JSON stores.** `form_fields.roles`, `system_messages.audience`,
`menu_items` and `documents_link` stay JSON. §5.3 is the mitigation for that decision, not a
reversal of it. Normalising them into join tables is `user-roles.md` §4.5.

**12.5 No `ALLOWED_ROLES` fix.** Measured dead: `config.auth.allowedRoles` (`config/env.ts` L116)
has **one** occurrence in `server/src` — its own definition. Nothing reads it, and its documented
value (`admin,staff`) contradicts `routes/auth.ts` L137, which hard-codes `cdm_contact` for
self-registration. Do not add a dynamic role to it: it would look effective and not be. Separate
change.

---

## 13. Open questions and decisions taken

**Decided 2026-09-30 (see each item):** Q1 roles are installation-wide; Q2 `reviewer` is a **seeded
built-in**. Q3–Q6 remain open. The decisions are recorded here rather than silently applied so that a
later reader can see they were asked and answered.

1. **Are roles global or per-org?** (§3.1) **DECIDED: installation-wide.** **Settled by §3.5, not by preference.** `user-roles.md`
   §4.2 makes roles per-org (`UNIQUE (organization_id, key)`), but `users.role` stores a **key**, so
   the FK that enforces "cannot be deleted" (§5.1) requires that key to be **globally** unique — and
   a per-org catalog permits the same key in two orgs. So the FK and per-org scoping cannot both
   hold with `users.role` as it stands, and the FK is the thing that makes the user's rule a
   *database* rule instead of a handler convention. Recommend **global** on that basis. The visible
   consequence stands and should be stated in the panel's own copy: an admin in one org sees, and
   can create, roles that appear in every other org's dropdown.
   **→ Accepted. The panel's copy must say it.** The per-org alternative was rejected *because* it
   would demote §5.1's enforcement to a handler convention a future write path can bypass.
2. **Is `reviewer` a seeded built-in, or just the first role an admin creates?** (§3.3) **DECIDED: seeded
   built-in.** **This is the
   one question that decides whether the request is satisfiable as stated.** A read-only role cannot
   be delivered as an admin-authored one in an additive model (§3.5) — it needs the mutually
   exclusive channel and a `built_in` row whose `can_edit=0` is code-reviewed once. Recommend
   **seeded**. Admin-authored roles then layer on top with the same machinery, but their first use
   case cannot be "read-only", and the panel's empty state should not imply otherwise.
   **→ Accepted. `reviewer` is seeded in the boot seed (§3.2) with `can_view=1, can_edit=0,
   can_export=1, can_report=1`, `built_in=1`. Consequently `reviewer-role.md`'s D4 ("is Reviewer
   read-only?") is answered — read + export + report, no writes — and its silence-list S1–S7 stops
   being a code-edit checklist for that role.**
3. **Does a new role default to `can_view` only?** (§3.2) Recommended. The alternative (default
   `can_edit`) makes a mis-click grant write access to 10 routes.
4. **Should the delete census *block* on JSON references, or only warn?** (§5.3) Recommended:
   block — a warn-and-proceed path re-opens the resurrection hole. Blocking is stricter than the
   literal request ("once they are assigned"), so confirm.
5. **Cache invalidation under scale-out** (§4.3). In-process + TTL 30 s is the proposal; a
   multi-instance correction needs a shared signal.
6. **Does the Roles panel need a "who can see this role" preview?** A role that is
   `can_view=1, can_edit=0` and never assigned looks identical to one in use. `GET
   /api/roles/:key/usage` (§7) answers it; whether the UI shows it before the first click is a
   UX call.

---

## 14. File-by-file change list

### Server — schema and data
| File | Change |
| --- | --- |
| `server/src/db/schema.ts` | `dbo.roles` CREATE + seed **before** `dbo.users`; L609 drop the inline CHECK; append the drop-CHECK/add-FK block **after** L647-666; `ROLES` becomes the **built-in** list with a comment saying so; **§2** — `fieldAccessRoles` and `messageAudienceRoles` return `null` for "unset"; L160's payload composer resolves `null` to the live list |
| `server/src/db/dialect/turso.ts` | L77 drop the inline CHECK; add the `roles` table to the final shape (§6.3) |
| `server/src/db/queries.ts` | `toSystemMessage` passes the sentinel through; `listActiveSystemMessagesForUser`'s NULL arm already means "everyone" — verify, don't change; new `listRoles` / `createRole` / `updateRole` / `deleteRole` / `roleUsage` |
| `server/src/db/roles-cache.ts` *(new)* | boot-loaded role map + capabilities + invalidation + TTL |

### Server — routes and guards
| File | Change |
| --- | --- |
| `server/src/routes/roles.ts` *(new)* | §7 |
| `server/src/auth.ts` | keep `requireRoles`; add `requireCapability` / `requireAdmin`; `isSchoolScoped` reads `school_scoped` from the cache instead of `role === "cdm_contact"` |
| `server/src/routes/settings.ts` | L58/L68/L93/L110 — §2 sentinels; drop the `ROLES.filter` normalisation |
| `server/src/routes/{forms,submissions,documents,export,reports}.ts` | the 21 sites → capability guards (§4.1/4.2) |
| `server/src/schemas.ts` | L70/L84 `z.enum(ROLES)` → `z.string()` + handler lookup; L170 `z.array(z.string())`; **L356 drop `.max(ROLES.length)`** (§2.4) |
| `server/src/swagger.ts` | 8× `enum: ["admin","staff","cdm_contact"]` → free strings; roles description at L25 |

### Client
| File | Change |
| --- | --- |
| `client/src/types/index.ts` | `Role = string` + a comment naming `GET /api/roles` as the source |
| `client/src/lib/settings.ts` | L5/L15/L85/L97 — fetched roles; `MENU_ITEMS` unchanged |
| `client/src/lib/roles.ts` *(new)* | fetch + cache + `roleLabelFor` / `roleBadgeFor` / `roleFlagsFor` |
| `client/src/pages/admin/AdminSettings.tsx` | **new Roles panel after Users** (§8.1); L47 `roleBadge` from the map; L1726 the `<option>` list |
| `client/src/pages/admin/AdminFormDesigner.tsx` | L22/L26 — fetched; `defaultFieldRoles()` should send **unset**, not a snapshot (§2) |
| `client/src/pages/HomeRedirect.tsx` | L7 — route by capability; **remove the `/login` fall-through** |
| `client/src/components/layout.tsx` | L323 — capability gate |
| `client/src/App.tsx` | L137/147/157/167 — capability guards |
| `client/src/pages/LoginPage.tsx` | L353 |

### Tests and docs
| File | Change |
| --- | --- |
| `server/src/db/system-messages.test.ts` | **G1** (5 assertions) and **G2** (the caller scanner) rewritten with their reasons; add the §10.3-15/16 cases |
| `server/src/db/submissions-archive.test.ts` | **G3** — the literal-guard assertion and its CONTROL |
| `server/src/db/field-access.test.ts` *(new)* | **G8** — nothing covers `fieldAccessRoles` today; the sentinel change is otherwise unguarded |
| `server/src/routes/roles.test.ts` *(new)* | §5 delete rules, §7 validation layering, key normalisation |
| `docs/plans/access-groups.md` | §3.1 decision flipped to Option B with the reason; §5 becomes the editable panel; §6 descriptor superseded by the `dbo.roles` row |
| `docs/plans/reviewer-role.md` | superseded banner (§3.3); §4 retained as the capability map |
| `docs/plans/user-roles.md` | §4.2 (`dbo.roles` catalog) and §4.5 (join tables vs JSON) are now partly realised — cross-link |
| `docs/plans/feature-backlog.md` | §7.4 — this is the moment it anticipated |
| `docs/guides/user-guide.md` | an "Add a role" section |
