# Plan — Adding New Access Groups (Roles)

**Status:** Draft for review
**Date:** 2026-09-13
**Area:** Roles / Access control (`admin`, `staff`, `cdm_contact` → + future roles)

---

## 1. Goal

Provide a repeatable, low-risk way to add a **new access group** (role) — e.g. a hypothetical
`counselor`, `nurse`, or `registrar` — so it can be:

- assigned to users (Admin → Settings → Users),
- granted access to individual staff-only form fields (the Access buttons),
- shown/hidden the Documents link,
- and used to gate routes and pages.

Today the app has **three roles hard-coded in ~12 places**. Adding a fourth currently means
finding and editing all of them by hand — easy to miss one, and a miss means either a broken
login or a silent security hole. This plan documents every touchpoint and proposes making the
list **data-driven** so future roles are a smaller, safer change.

---

## 2. Current state — every place a role is wired

| # | Location | What it does | Type |
| --- | --- | --- | --- |
| 1 | `server/src/db/schema.ts` `ROLES` | Canonical server list `["admin","staff","cdm_contact"]` + `Role` type | **Source of truth** |
| 2 | `server/src/db/schema.ts` `users.role` CHECK | `CHECK (role IN ('admin','staff','cdm_contact'))` | **DB constraint** |
| 3 | `server/src/db/schema.ts` role-CHECK migration | Idempotent block that widens the CHECK (added for `cdm_contact`) | **DB migration** |
| 4 | `client/src/types/index.ts` `Role` | `"admin" \| "staff" \| "cdm_contact"` | TS type |
| 5 | `client/src/lib/settings.ts` `ROLES` | Client copy of the role list | Duplicate list |
| 6 | `client/src/pages/admin/AdminFormDesigner.tsx` `ROLES` | Access buttons render from this | Duplicate list |
| 7 | `AdminFormDesigner.tsx` `roleLabel()` | Maps role → pretty label ("School Contact") | Label map |
| 8 | `AdminSettings.tsx` `roleBadge()` | Maps role → badge class + label | Label map |
| 9 | `server/src/auth.ts` `requireRoles(...)` | Route gate | Generic (no change) |
| 10 | Routes: `forms.ts`, `submissions.ts`, `documents.ts`, `export.ts`, `schools.ts` | `requireRoles("staff","cdm_contact","admin")` etc. | Per-route lists |
| 11 | `server/src/routes/submissions.ts` `isSchoolScoped()` | `role === "staff" \|\| role === "cdm_contact"` — decides school vs org scoping | **Behavioral** |
| 12 | `server/src/routes/export.ts` | Column visibility by role | Behavioral |
| 13 | `.env` `ALLOWED_ROLES=admin,staff` | Roles allowed to self-register | Config |
| 14 | `client/src/pages/HomeRedirect.tsx`, `LoginPage.tsx` | Post-login landing (`admin` → `/admin`, else `/staff`) | Routing |
| 15 | `client/src/App.tsx` | `<ProtectedRoute roles={["admin"]}>` per admin page | Route guards |
| 16 | `client/src/components/layout.tsx` | Sidebar links (Documents gated by `documents_link`) | Nav |

### Key insight — the schema already supports arbitrary roles

`form_fields.roles` is stored as a **JSON string array** (`'["admin","staff"]'`), and
`fieldAccessRoles()` treats NULL/empty as "all roles". So **per-field access needs no schema
change** to add a role — you just add the string to the array. The friction is entirely in the
hard-coded lists (#1, #2, #4, #5, #6) and the label maps (#7, #8).

---

## 3. Design decisions

### 3.1 Should roles be dynamic (DB-backed) or stay code-defined?

Two options:

- **Option A — Code-defined, but centralized (recommended for now).** Keep roles in code, but
  define them **once** with metadata (key, label, badge class, school-scoped?, landing page),
  and derive every other list from that. Adding a role = add one entry + one DB migration.
- **Option B — Fully dynamic (DB table `roles`).** Admins create roles at runtime in Settings.
  Maximum flexibility, but it turns a security boundary into runtime data: you must then
  validate role strings everywhere, handle deletion of in-use roles, and the Access-button
  labels need a lookup. Much larger change.

**Recommendation:** **Option A now**, with the option to evolve to B later. Roles are a
security boundary and benefit from being explicit and reviewable in code. A "Settings → Roles"
screen (see §5) can still *display* the groups and their capabilities without making them
mutable.

### 3.2 What makes a role, beyond a name?

Each role needs a small set of properties. Define them in one place:

| Property | Purpose | Example |
| --- | --- | --- |
| `key` | Stored value | `"cdm_contact"` |
| `label` | Display name | `"School Contact"` |
| `badge` | Badge class | `"badge-teal"` |
| `schoolScoped` | Sees only their school vs whole org | `true` for staff/cdm_contact |
| `landing` | Post-login route | `/staff` |
| `canDesignForms` | Admin-only capability | `false` |
| `defaultFieldAccess` | Pre-checked on new staff-only fields | `true` |

This single descriptor replaces the scattered `roleLabel()` / `roleBadge()` / `isSchoolScoped()`
logic.

---

## 4. The change checklist (what adding a role actually requires)

For a concrete example, adding a role `counselor` ("Counselor"):

### Backend
1. **`server/src/db/schema.ts`** — add `"counselor"` to `ROLES`.
2. **`server/src/db/schema.ts`** — add an idempotent CHECK-widening migration (mirror the
   existing `cdm_contact` block at ~line 312). The pattern: drop any CHECK on `role` that
   doesn't include the new role, re-add with the full set. Must be guarded so it no-ops once
   applied.
3. **`server/src/routes/submissions.ts`** — decide whether the new role is school-scoped
   (`isSchoolScoped()`).
4. **Routes** — add `"counselor"` to any `requireRoles(...)` list that should include it
   (forms list, submissions, documents, export).
5. **`server/src/routes/settings.ts`** — nothing structural; `parseDocumentRoles` already
   filters against `ROLES`, so the new role is automatically accepted.
6. **`.env` / `.env.example`** — add to `ALLOWED_ROLES` **only if** the role may self-register
   (usually not — admins create these accounts).

### Frontend
7. **`client/src/types/index.ts`** — add to the `Role` union.
8. **`client/src/lib/settings.ts`** — add to `ROLES`.
9. **`client/src/pages/admin/AdminFormDesigner.tsx`** — add to `ROLES` + `roleLabel()`.
10. **`client/src/pages/admin/AdminSettings.tsx`** — add to `roleBadge()`.
11. **`client/src/pages/HomeRedirect.tsx` / `LoginPage.tsx`** — landing route if not `/staff`.
12. **`client/src/App.tsx`** — add to `ProtectedRoute roles` for any page it may reach.

### Verify
13. Create a user with the new role; confirm login, landing page, sidebar, form access buttons,
    field visibility on a staff-only field, export columns, and route guards.

---

## 5. Proposed "Settings → Access Groups" panel

To make this discoverable (and to satisfy the "maybe under Settings" ask), add a **read-only**
panel that documents the groups:

- **Location:** `AdminSettings.tsx`, a new `CollapsibleSection` titled **"Access Groups"**,
  alongside Users / Login Mode / Documents Link / Slack / Organizations.
- **Contents:** a table of every role — Badge, Label, Key, Scope (School / Organization),
  and capability flags (Designs forms, School-scoped, Sees Documents by default).
- **Why read-only:** roles are a security boundary defined in code (§3.1). The panel makes the
  current groups visible and explains what each can do, without letting someone create an
  unvetted role that bypasses route guards.
- **Stretch:** if you later want runtime roles (Option B), this panel becomes editable and
  gains a `dbo.roles` table — a separate, larger plan.

---

## 6. Recommended refactor (makes step 4 a one-liner)

Introduce a single descriptor module, e.g. `shared/roles.ts` (or `server/src/db/roles.ts` +
a client mirror), exporting:

```ts
export interface RoleDef {
  key: Role;
  label: string;
  badge: string;
  schoolScoped: boolean;
  landing: string;
  canDesignForms: boolean;
  defaultFieldAccess: boolean;
}

export const ROLE_DEFS: RoleDef[] = [
  { key: "admin",       label: "Admin",       badge: "badge-orange", schoolScoped: false, landing: "/admin",  canDesignForms: true,  defaultFieldAccess: true },
  { key: "staff",       label: "Staff",       badge: "badge-blue",   schoolScoped: true,  landing: "/staff",  canDesignForms: false, defaultFieldAccess: true },
  { key: "cdm_contact", label: "School Contact", badge: "badge-teal",   schoolScoped: true,  landing: "/staff",  canDesignForms: false, defaultFieldAccess: true },
];

export const ROLES = ROLE_DEFS.map((r) => r.key);
export const roleLabel = (k: string) => ROLE_DEFS.find((r) => r.key === k)?.label ?? k;
export const roleBadge = (k: string) => ROLE_DEFS.find((r) => r.key === k)?.badge ?? "badge-gray";
```

Then:
- `roleLabel()` / `roleBadge()` / `isSchoolScoped()` / `defaultFieldRoles()` all read from it.
- `AdminSettings` "Access Groups" panel renders directly from `ROLE_DEFS`.
- Adding a role becomes: **one entry in `ROLE_DEFS` + one DB migration**.

**Note:** the client can't import server code directly (separate workspaces), so either
duplicate the descriptor in `client/src/lib/roles.ts` (kept in sync, like `ROLES` is today) or
expose it via a public `GET /api/roles` endpoint. Recommend the **endpoint** so there's a single
source of truth and the client never drifts.

---

## 7. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| **DB CHECK constraint** blocks the new role → inserts fail with a constraint error. | The idempotent migration (§4.2) is mandatory. Test on a fresh DB *and* an existing one. |
| Missed `requireRoles(...)` list → new role gets 403 on a page it should reach. | Grep for every `requireRoles(` and review; the §6 refactor reduces these to capability flags. |
| Missed client `ROLES` copy → Access button doesn't render for the new role. | Centralize via the endpoint (§6). |
| New role accidentally treated as admin. | `canDesignForms` / route guards are explicit; never default a role to admin. |
| Existing staff-only fields don't include the new role. | `fieldAccessRoles()` treats NULL/empty as *all* roles, but fields with an explicit array must be updated. Decide: backfill new role into existing arrays, or leave them (recommended: leave — explicit is safer; admins can grant per field). |
| `ALLOWED_ROLES` self-registration. | Only add the role there if self-registration is genuinely intended. |

---

## 8. Verification plan

1. Migration applies cleanly on a fresh DB and on an existing one (idempotent re-run = no-op).
2. Create a user with the new role via Settings → Users; confirm the badge renders.
3. Log in as that user: correct landing page, correct sidebar links.
4. On a staff-only field with the new role granted: the user sees it; without it, they don't.
5. Export columns respect the role.
6. Route guards: the role can reach intended pages and is 403'd on admin-only ones.
7. `npm run typecheck` (server + client).

---

## 9. Open decisions for review

1. **Code-defined vs. dynamic roles** — Option A (code, recommended) or Option B (DB-backed,
   editable in Settings)?
2. **Settings panel** — add the read-only "Access Groups" panel now (recommended), or skip it
   until roles become editable?
3. **Centralize via endpoint** — add `GET /api/roles` as the single source of truth (recommended)
   or keep the duplicated `ROLES` constant in sync by hand?
4. **Existing staff-only fields** — when a role is added, backfill it into existing field access
   arrays, or leave them untouched (recommended)?
5. **Which role is the concrete first example** — is there a real fourth group you have in mind
   (counselor / nurse / registrar), so the plan can name it end-to-end?

---

## 10. Files to change (for the recommended Option A + refactor)

| File | Change |
| --- | --- |
| `server/src/db/schema.ts` | Add role to `ROLES`; add CHECK-widening migration. |
| `server/src/db/roles.ts` *(new)* | `ROLE_DEFS` descriptor (single source of truth). |
| `server/src/routes/roles.ts` *(new, optional)* | `GET /api/roles` public endpoint. |
| `server/src/routes/submissions.ts` | Update `isSchoolScoped()` to read the descriptor. |
| `server/src/routes/{forms,documents,export}.ts` | Add role to relevant `requireRoles(...)`. |
| `client/src/types/index.ts` | Add role to `Role` union. |
| `client/src/lib/roles.ts` *(new)* | Client mirror or fetch from `/api/roles`. |
| `client/src/pages/admin/AdminFormDesigner.tsx` | Read `ROLES`/`roleLabel` from the shared module. |
| `client/src/pages/admin/AdminSettings.tsx` | Read `roleBadge`; add the "Access Groups" panel. |
| `client/src/pages/HomeRedirect.tsx`, `LoginPage.tsx` | Landing route from the descriptor. |
| `client/src/App.tsx` | Route guards if the role reaches new pages. |
| `.env` / `.env.example` | `ALLOWED_ROLES` only if self-registration is intended. |
| `docs/plans/access-groups.md` | This plan. |
