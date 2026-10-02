# Findings — Staff Only Fields access toggles, and where the Reviewer role is still refused

**Status:** 🔧 **Code complete and verified; UNCOMMITTED.** Two items in §5 and §6 need a decision
from you and were deliberately left alone.
**Date:** 2026-10-01
**Area:** Roles / access control — the client's duplicated role lists, and the state of the P5
capability-guard migration
**Relation to other docs:**
- **Delivers rows 3 and 4 of [`roles-settings.md`](./roles-settings.md) §8.3** (`AdminFormDesigner.tsx` L22
  local `ROLES` → fetched; L26 `roleLabel` → the fetched label) ahead of that plan's own phasing.
  **Measured 2026-10-01: rows 1–6 of that table are now done; rows 7–9 are not.**
- **Reports the measured state of `roles-settings.md` §4 / P5** — see §6 here; the short version is
  that the capability guards were *built* and *not wired*, so `reviewer-role.md` §4's route split
  is still unapplied.
- **Continues [`reviewer-role.md`](./reviewer-role.md) §5's S1–S7 silent-gate catalogue.** S1, S2
  and S3-as-it-was are all still the shape of §6 here.
- The `null`-means-unrestricted sentinel contract this fix had to honour is
  [`roles-settings.md`](./roles-settings.md) §2.

---

## 1. What was asked

> "The new role 'Reviewer' button should show up in the 'Staff Only Fields' section. See browser."

On `/admin/forms/2`, the **Staff Only Fields (6)** tab renders one *Access* row per field, with a
toggle button per role. The Reviewer role existed in `dbo.roles`, in `GET /api/roles`, in the Users
assignment dropdown and in `client/src/lib/roles.ts` (`BUILT_IN_ROLES`) — but **had no button on
those rows**.

---

## 2. What changed

Three files. No schema change, no new route, no new dependency.

| File | Change |
| --- | --- |
| `client/src/pages/admin/AdminFormDesigner.tsx` | the Access row is now driven by the live role catalog instead of a local constant; plus three latent defects in the same file (§2.1) |
| `server/src/db/schema.ts` | `ROLES` widened to include `"reviewer"` (§2.1 D4) |
| `server/src/db/system-messages.test.ts` | one comment ("snapshot of the three" → "of the four") — the assertions are `.toBeNull()` and order-independent, so the widening cannot fail them |

### 2.1 ★ Four variants of the same defect: a hand-kept copy of a machine-maintained set

This is the whole finding. Each variant is the same mistake at a different site, and **none of them
produces a diagnostic** — not `tsc`, not the linter, not the browser.

| # | Site | What was wrong | Failure mode |
| --- | --- | --- | --- |
| **D1** | `AdminFormDesigner.tsx` L22 | `const ROLES = ["admin","staff","cdm_contact"] as const` and the Access row was `{ROLES.map(...)}` | A role added later can never appear. **This is the reported bug.** Nothing fails; the button simply is not there. |
| **D2** | `AdminFormDesigner.tsx` `handleSave()` | `roles: f.staff_only ? (f.roles ?? defaultFieldRoles()) : null` | The `??` **narrows the unrestricted sentinel**. Every save rewrote `null` ("all current *and future* roles") into a frozen three-key array. A field meaning "everyone, including roles that do not exist yet" silently became "these three, forever". |
| **D3** | `AdminFormDesigner.tsx` Access row | `const granted = field.roles?.length ? field.roles : null` | The `?.length` check makes a stored **`[]` ("granted to nobody") render as all-granted**, and makes the empty state **unreachable** — unticking every role then re-ticking one snapped all the others back on. |
| **D4** | `server/src/db/schema.ts` L19 (was L4) | `ROLES = ["admin","staff","cdm_contact"]` | `knownRoleKeys()` (`server/src/db/roles-cache.ts`) falls back to this set on a **cold cache**. Its own comment in the surrounding block said four, and the seed ladder in *both* dialects seeded `reviewer` — the export was a row behind. |

**D2 and D3 are the interesting ones**, because they were not reported and no probe would have
found them: the row *looked* right, and only exercising "untick everything, then tick one back"
exposed D3.

### 2.2 The fix

**D1** — delete the constant; derive the toggles from the catalog:

```ts
export function accessRoleKeys(field: FormField, catalog: RoleRow[]): string[] {
  // Base = the live catalog, or the built-ins while it loads.
  const base = catalog.length ? catalog.map((r) => r.role_key) : [...BUILT_IN_ROLES];
  // ★ UNION with any key the field already names, so a grant made under a
  //   role that has since been renamed is still visible and still removable.
  //   Without this, a stale key is invisible in the UI but still in the JSON.
  return [...new Set([...base, ...(Array.isArray(field.roles) ? field.roles : [])])];
}
```

**D2** — `?? null` rather than `?? defaultFieldRoles()`. The sentinel stays the sentinel.

**D3** — an explicit three-state read instead of a truthiness check:

```ts
const granted = Array.isArray(field.roles) ? field.roles : null;
const has = granted === null || granted.includes(role);      // null ⇒ unrestricted ⇒ granted
const current = Array.isArray(field.roles) ? field.roles : roleKeys;  // materialise only on toggle
```

**D4** — `ROLES = ["admin","staff","cdm_contact","reviewer"] as const`.

### 2.3 The invariant the fix had to honour

`server/src/db/schema.ts` L16 states the contract for this list, verbatim, and it is the reason a
`ROLES`-derived access *decision* is forbidden:

> `ROLES` is for **"seeding the catalog, naming the built-ins in a UI, and defaulting a brand-new
> installation. **NOT**: deciding who may see something."**

On a `staff_only` field the stored values mean:

| Stored `roles` | Meaning |
| --- | --- |
| `NULL` | **UNRESTRICTED** — every current role **and every future one**. This is what `addField()` now writes. |
| `[]` | granted to **nobody** |
| `["admin","staff"]` | exactly those |

So the toggles may be *rendered* from the catalog (naming the built-ins in a UI is explicitly
sanctioned) but a saved decision must never be materialised from it. D2 was a violation of exactly
that sentence.

---

## 3. Evidence

Static:

- `get_errors` clean on all three files.
- `client npm run typecheck` clean · `server npm run typecheck` clean.
- `server npm test` → **8 files, 148 tests, all pass** (~3.6 s), including `system-messages.test.ts`
  (41 tests).

Browser (`/admin/forms/2` → **Staff Only Fields (6)**), measured in the DOM:

| Probe | Result |
| --- | --- |
| Access rows | `6` |
| Buttons per row | `[4,4,4,4,4,4]` |
| Labels | `["Administrator","Staff","School Contact","Reviewer"]` |
| Granted vs not | granted bg `rgb(22, 87, 136)` (accent) + `<Check>`; not granted `rgb(255, 255, 255)` + `<Plus>` |
| Grant/remove Reviewer | `["Administrator","Staff","School Contact"]` → `+Reviewer` → back to three |
| **D3 regression (the previously-broken path)** | untick all → `[]`; re-grant only Staff → `["Staff"]`; re-grant only Reviewer → `["Reviewer"]` — **no snapping** |

Screenshot: `docs/screenshots/access-row-reviewer.png` (untracked — delete it if you don't want it).

---

## 4. What this fix does **not** do

**★ The six existing staff-only fields on form 2 still name explicit role arrays, and none of them
names `reviewer`.** Measured via `GET /api/forms/2` on 2026-10-01:

| Field id | Label | Stored `roles` |
| --- | --- | --- |
| 16 | Next Course in Sequence | `["admin","staff","cdm_contact"]` |
| 37 | Counseling Completed? | `["admin","staff","cdm_contact"]` |
| 30 | Counseling Notes | `["admin","staff","cdm_contact"]` |
| 31 | Distribution of Phase I Letters | `["admin","staff"]` |
| 35 | Did Student meet criteria? | `["admin","staff"]` |
| 36 | Generate document | `["admin"]` |

So **the button exists and grants correctly, but a Reviewer still sees none of these fields** until
the arrays are widened. See §5 — that is a write to **production** and needs your go-ahead.

---

## 5. ⚠️ Decision 1 — widen the seeded field arrays? (a PRODUCTION write)

`.env` points at `wcpsssqlelasticpool.database.windows.net` / **`wcpss-google-forms`** — this is the
live database, so I have not touched it.

| Option | What it writes | Effect |
| --- | --- | --- |
| **(a) `roles = NULL`** | the unrestricted sentinel | Matches the contract in `schema.ts` L16 and what `addField()` now writes: every current role **and every future one** is admitted. Narrower roles would be carved back per field afterwards. |
| **(b) add `"reviewer"` to each array** | `["admin","staff","cdm_contact","reviewer"]` etc. | Nothing about existing access changes; only Reviewers are added. Keeps the explicit-ness that made this bug visible. |
| **(c) leave as-is** | nothing | A Reviewer sees no staff-only field. The role is assignable but useless — §6 makes that worse. |

Recommendation: **(b)** while the Reviewer role has no screen (§6). Option (a) is the
design-blessed default, but it is a *widening* to every future role as well, which the UI cannot yet
show you the consequence of. Either way the six rows are the only ones affected — measured, this
form is the only one with staff-only fields that matter here, and the toggle now makes the result
visible immediately either way.

---

## 6. ⚠️ Decision 2 — ★ the `reviewer` role is refused by the API **and** loops at login

This is a larger finding than the toggles, and it is the reason §5 wants care.

### 6.1 The API refuses it — the capability guards exist and are not wired

`server/src/auth.ts` defines `requireCapability(capability)` (L202) and `requireAdmin()` (L223), and
`auth.ts`'s own comment says plainly: *"Do NOT reach for this [requireRoles] to gate a new feature…
Use `requireCapability("view" | "edit" | "export" | "report")` instead."* `db/roles-cache.ts` builds
the cache and `roleHasCapability`. `GET /api/roles` serves the catalog. The Roles panel is built.

**But measured: `requireCapability` has ZERO call sites in `server/src/routes/`.** All **56**
`requireRoles(...)` sites are still role-key lists, e.g.

```ts
submissionsRouter.get("/", requireAuth, requireRoles("staff", "cdm_contact", "admin"), …)
```

`requireRoles` is `if (!roles.includes(req.user.role)) → 403`. So a `reviewer` token gets **403 on
every staff read route** — the queue, the detail page, the forms list, export, documents, reports.
This is `roles-settings.md` §4.2 / P5 and §10.3 assertions 11–12: **not started**.

### 6.2 The client loops — three more hand-kept copies of the landing rule

| Site | Code | Reviewer result |
| --- | --- | --- |
| `client/src/App.tsx` L137/147/157/167 | `<ProtectedRoute roles={["staff","cdm_contact"]}>` on all four `/staff/*` routes | `ProtectedRoute` L403 → `<Navigate to="/" replace />` |
| `client/src/pages/HomeRedirect.tsx` L7 | `admin→/admin`, `staff\|cdm_contact→/staff`, **else `/login`** | → `/login` |
| `client/src/pages/LoginPage.tsx` L182 | `if (user) return <Navigate to={user.role === "admin" ? "/admin" : "/staff"} />` | → `/staff` |

Those three disagree with each other and compose into a **redirect cycle**: `/staff` → `/` →
`/login` → `/staff` → … So assigning `reviewer` to a user does not merely land them nowhere — it
gives them a **blank, looping page at sign-in**. Note also that `LoginPage` and `HomeRedirect` hold
*two independent copies* of the landing rule (`admin ? /admin : /staff` vs
`admin / staff|cdm_contact / else`), and it is only by accident that they agree for the existing
roles.

`client/src/components/layout.tsx` L333 gates the whole staff nav block on
`staff || cdm_contact`, so even if the loop were broken the sidebar would be empty. That is
`reviewer-role.md` §5 **S1** and **S2** — catalogued on 2026-09-30 and confirmed still live today.

### 6.3 The consequence, today

Measured 2026-10-01:

| | |
| --- | --- |
| `GET /api/roles` | four built-ins, all `built_in: true`, including `{ key: "reviewer", label: "Reviewer", built_in: true }` |
| `GET /api/users` | **44 users** — `{ admin: 4, cdm_contact: 40 }` |
| users holding `reviewer` | **0** |
| users holding `staff` | **0** |

So it is dormant — but the Users dropdown is catalog-driven (`AdminSettings.tsx` L2337), which means
**an admin can assign `reviewer` right now and lock that user out.** `reviewer-role.md` §5 called
this "the headline risk"; the widening in D1/D4 has moved it from a hypothetical to a control an
admin can click.

### 6.4 The options

| # | Option | Cost | Note |
| --- | --- | --- | --- |
| **A** | **Ship the client half only** — capability-based `ProtectedRoute`/nav, and one shared landing rule (`is_admin → /admin`, capability `view` → `/staff`, else a "no access" page instead of `/login`) | ~6 sites, client only | Lands a Reviewer on the staff queue, which will render **403s** until P5. Needs an error state that says so. |
| **B** | **A + P5** — migrate the 21 `requireRoles(...)` sites in `reviewer-role.md` §4.1/§4.2 to `requireCapability("view"/"edit"/"export"/"report")` | the client half + 21 server sites | `roles-settings.md` §10.2's inherited-regression probe is the safety net: the diff must be **zero** for admin/staff/cdm_contact and only *fewer* 200s for reviewer. `submissions-archive.test.ts` L580-595 pins the archive/restore list verbatim and will need its claim rewritten **with the reason** (that file's own message argues *why* an added role there would be wrong). |
| **C** | **Remove `reviewer` from the catalog and the designer** — make it a planned role again, not a seeded one | small | Honest but loses the DDL/seed work in both dialects and `reviewer-role.md` §3's rationale. |
| **D** | **Leave it** — catalog-only, documented | zero | Acceptable **only if** the Users dropdown stops offering a role that locks a user out (i.e. drop it from the catalog, = C). |

**Recommendation: B, in two commits** — the client half first (it is where the loop is), then the
21 server sites behind `roles-settings.md` §10.2's probe. If that is too much now, **C** is far
better than D: a role an admin can assign but nobody can use is worse than no role.

---

## 7. Known, deliberately **not** fixed

- **★ `parseFormFieldRoles` (`server/src/db/queries.ts` ~L1128) collapses a stored `'[]'` back to
  `null` on READ** — it returns `null` for null/empty/parse-fail, while the write path (~L1422)
  deliberately preserves `'[]'`. So "granted to nobody" round-trips as "unrestricted". Fixing it is
  a server-wide semantic change (every consumer of the sentinel) and is out of scope for this bug.
  **The client fix in D3 is what makes the state reachable in the UI; the store still loses it.**
- **The seeded `reviewer` DESCRIPTION** still reads *"Read, export and report. Cannot change
  submissions."* — a capability claim the routes do not currently honour (§6.1). Left alone: it is
  a write to production data, and it is only false until P5 lands.
- **`docs/plans/roles-settings.md` is still headed "Draft for review"** while most of it (the
  `dbo.roles` table, `/api/roles` CRUD, the Roles panel, `client/src/lib/roles.ts`) is demonstrably
  built and serving. Consider marking it **partially implemented** with P5 (routes) and the
  remainder of §8.3's client table as the outstanding parts — as it stands, the doc's status line
  is the least accurate thing in it.

---

## 8. How to verify this work

1. `client npm run typecheck` · `server npm run typecheck` · `server npm test` (expect 148 pass).
2. Open `/admin/forms/2`, expand **Staff Only Fields (6)**, and confirm four buttons
   (`Administrator`, `Staff`, `School Contact`, `Reviewer`) per row.
3. Untick **all four** on one field — the row must render zero granted, not four. This is the D3
   regression; if it snaps back, the `?.length` check has returned.
4. Grant only `Reviewer`, save, reopen — the grant must be exactly `["reviewer"]`.
5. Create a new role in Settings → Roles and return to the designer: the new role must appear on
   these rows with no code change. This is the whole point of D1.

Standing environment facts: **Vite binds IPv4 only — use `http://127.0.0.1:5173/`**; **`tsx watch`
does not reload `.env`**; overwrites/forms are mounted so **scope browser queries to the open
overlay class (`open`)**.

---

## 9. File-by-file summary

| File | Change | Committed? |
| --- | --- | --- |
| `client/src/pages/admin/AdminFormDesigner.tsx` | catalog-driven Access row (`accessRoleKeys`), `?? null` on save, `Array.isArray` three-state read, `roleLabelFor`; `ROLES`/`roleLabel`/`defaultFieldRoles` removed | ❌ |
| `server/src/db/schema.ts` | `ROLES` widened to four keys + comment on why a hand-kept copy drifts | ❌ |
| `server/src/db/system-messages.test.ts` | comment: "snapshot of the three" → "of the four" | ❌ |
| `docs/screenshots/access-row-reviewer.png` | capture of the four-button Access row | ❌ (untracked) |
| `docs/plans/staff-only-field-access-toggles.md` | this document | ❌ |
