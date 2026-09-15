# Plan — Password Recovery (Admin Reset)

**Status:** Implemented
**Date:** 2026-09-15
**Area:** Admin → Settings → Users (issue) · any role → `/account/password/required` (redeem)
**Depends on:** `docs/plans/change-password.md` (the change-password endpoint is reused as-is)

---

## 1. Goal

Make a forgotten password **recoverable** without a database console:

1. An admin opens **Settings → Users**, selects a user, and clicks **Reset password**.
2. The app issues a **server-generated temporary password** and shows it **once**.
3. The admin passes it to the user out-of-band.
4. The affected user signs in with it and is **forced to choose a new password** before the
   app will render anything else.

---

## 2. The problem this closes

Before this change there was **no password recovery path of any kind**, anywhere:

| Layer | State before |
| --- | --- |
| `updateUser()` (`server/src/db/queries.ts`) | Its `SET` list is explicit — `display_name, email, active, school_id, role, organization_id, show_on_test_screen`. It **cannot write `password_hash`**, by design, so the generic admin user-edit path could never change a password "as a side effect". |
| `POST /api/auth/change-password` | Requires the **current** password (correctly — see §8 of `change-password.md`). Useless to someone who has forgotten theirs. |
| Email | There is no mail transport in the app (Mailjet was planned, never wired). No "forgot password" link, no reset token, no reset table. |

The consequence was not "inconvenient" but **unrecoverable**: the only ways to help a locked-out
account were (a) hand-writing a bcrypt hash directly into the database, or (b) abandoning the
account. For the **sole admin** account, (b) means losing the installation — there is nobody
elevated enough to help you.

This is also why the resolution is **admin-issued** rather than self-service: an email round-trip
is a much larger feature (mail provider, single-use signed token, expiry, enumeration concerns),
while admin-issued recovery needs no new transport and matches how the app is actually operated
(a handful of accounts, an admin who knows the users).

---

## 3. Design decisions

All nine were decided in the absence of a review conversation and are recorded here so they can
be challenged later. Each is also commented at its implementation site.

| # | Decision | Why |
| --- | --- | --- |
| 1 | **The server generates the temporary password** — the admin does not type one. | The alternative ("enter a new password for them") lets an admin choose a weak or reused value and quietly turns the reset into an account takeover with no evidence. Generated values cannot be weak, and the admin has no reason to prefer a remembered string. |
| 2 | **An admin cannot reset their own password through this endpoint** → `400`. | `change-password.md` §2 states the invariant: the bearer token alone must never be enough to set a password for the account holding it, because the token lives in `localStorage`. If self-reset were allowed, anyone who obtained a token would have permanent takeover — exactly what the current-password check exists to prevent. An admin who wants a new password already has **Change password** (they know their current one). Mirrors the existing *"You cannot deactivate your own account"* guard. |
| 3 | **A `must_change_password` flag is written in the same statement as the hash.** | The temporary password has been seen by a third party (the admin). Leaving it usable indefinitely means an account whose credential two people know. One `UPDATE`, one place, so the hash and the flag can never disagree. |
| 4 | **The forced change reuses `POST /api/auth/change-password`** rather than a new endpoint. | The behaviour needed is identical: verify the current (temporary) password, write a new hash, and in this case **clear** the flag. A second endpoint would duplicate the throttling and the 400-not-401 rule and drift. `updateUserPassword(id, hash, mustChange)` takes the flag as a parameter precisely so both callers express their intent in one call. |
| 5 | **`change-password` clears the flag and returns the refreshed user.** | The client must not have to re-fetch `/me` to learn it may render the app again; returning the user removes a round-trip and a race. |
| 6 | **A Slack admin alert is sent on reset — without the password.** | This is the closest thing the app has to an audit record for a security-relevant action, and the answer to *"who reset this, and when?"* months later. The password is deliberately **not** included: putting a live credential into a chat channel would create a worse problem than the notification solves. `sendSlackAlert` catches internally, so a dead webhook never fails the reset. |
| 7 | **The forced screen offers "Sign out", not "Cancel".** | There is nothing to cancel back to — the session is mid-way through a state the app will not render. A Cancel button would be a lie; signing out is a real, always-available action. |
| 8 | **The reset flow lives inside the existing user drawer** (confirm → show-once → done), not in a second overlay. | The drawer already owns the account. Stacking a modal on a drawer makes "which Cancel am I clicking?" ambiguous, and there is a single logical subject throughout. |
| 9 | **The flag is surfaced as a badge in the existing Status cell**, not as a new grid column. | No new column means no `colSpan` change, no horizontal scroll, and no `e.stopPropagation()` needed to keep the row-click working. The badge carries a `title` explaining it. |

**Deliberately deferred** (see §8): self-service "forgot password" by email, force-change on
**first** login for admin-created accounts, and immediate server-side session revocation.

---

## 4. API contract

### `POST /api/users/{id}/reset-password`

- **Auth:** bearer token, **`admin`** role. The reset is scoped to the caller's own organization.
- **Body:** none.
- **Responses:**

  | Status | When | Body |
  | --- | --- | --- |
  | `200` | Success | `{ id, email, display_name, temporary_password, must_change_password: true }` |
  | `400` | `id` not a positive integer | `{ "error": "Invalid user id" }` |
  | `400` | `id` is the caller's own account | `{ "error": "You cannot reset your own password. Use Change Password instead." }` |
  | `401` | No/invalid bearer token | `{ "error": "Missing bearer token" }` |
  | `403` | Target user is in another organization | `{ "error": "You can only reset passwords for users in your own organization" }` |
  | `404` | No such user | `{ "error": "User not found" }` |

  The guard order is **id → self → exists → tenant**, so the self-check fires before the lookup
  (it needs no database) and the tenant check is last (it needs the row).

- **Rate limiting:** none beyond the global limiter. The route requires an admin bearer token and
  **never verifies a password**, so it is not a guessing oracle — the reason
  `change-password` carries its own tighter limiter does not apply here.

### Temporary password shape

`server/src/security/temp-password.ts` — `generateTemporaryPassword()`:

- **14 characters**, `node:crypto` `randomInt` (rejection sampling, so no modulo bias).
- Alphabet is 57 characters: `a–z` and `A–Z` minus `l I O`, plus `2–9` — i.e. **minus the
  glyphs that get misread when a password is read aloud or retyped**: `l`, `I`, `O`, `0`, `1`.
- 57^14 ≈ 4.3 × 10²⁴. Hashing is `bcrypt` cost **12**, the same as every other path.

---

## 5. Files changed

### Server

| File | Change |
| --- | --- |
| `server/src/db/schema.ts` | `users.must_change_password BIT NOT NULL CONSTRAINT DF_users_must_change_password DEFAULT 0` in the `CREATE TABLE`, plus a standalone `COL_LENGTH`-guarded migration batch: `IF COL_LENGTH('dbo.users','must_change_password') IS NULL ALTER TABLE dbo.users ADD must_change_password BIT NOT NULL CONSTRAINT DF_users_must_change_password DEFAULT 0;` |
| `server/src/db/dialect/turso.ts` | `must_change_password BOOLEAN NOT NULL DEFAULT 0` added to the `users` block of `TURSO_DDL` **and** as a 4th entry in `addColumns` (an existing Turso database is migrated by `addColumns`, never by `ALTER TABLE` in the DDL). |
| `server/src/db/queries.ts` | Column threaded through `getUserByEmail`, `getUserById`, `createUser`, `listUsers`, `updateUser` (select/returning lists only — **not** `updateUser`'s `SET` list, see §3.3/§3.4). `updateUserPassword(id, passwordHash, mustChangePassword = false)` replaced the 1-argument version and now returns `Promise<User \| null>`. |
| `server/src/security/temp-password.ts` | **NEW** — `generateTemporaryPassword()`. |
| `server/src/routes/users.ts` | **+** `POST /:id/reset-password` with the four guards and the Slack alert. `must_change_password` added to the `GET /` list, `POST /` (201) and `PUT /:id` DTOs. |
| `server/src/routes/auth.ts` | `toUserDto` carries `must_change_password`; `change-password` calls `updateUserPassword(user.id, hash, false)` and returns `{ message, user }`. |
| `server/src/routes/inventory.ts` | **+** `{ method: "post", path: "/api/users/{id}/reset-password", auth: "admin", tags: "Users" }`. |
| `server/src/swagger.ts` | `must_change_password` on the `User` schema; full path object for the reset endpoint with `security: [{ bearerAuth: [] }]` and 200/400/403/404. |

### Client

| File | Change |
| --- | --- |
| `client/src/types/index.ts` | `User.must_change_password` and `AdminUser.must_change_password` (`boolean`); **+** `ResetPasswordResult`. |
| `client/src/lib/api.ts` | **+** `resetUserPassword(id)` — note the client sends **no** password; the server generates it. `changePassword` now returns `{ message, user }`. |
| `client/src/pages/account/ChangePasswordPage.tsx` | `forced?: boolean` prop and an exported `FORCED_PASSWORD_PATH = "/account/password/required"`. In forced mode: different heading/subtitle, first field labelled **Temporary Password**, the second button is **Sign out**, the success state offers **Continue to School Forms**, and the page renders **shell-less**. |
| `client/src/components/layout.tsx` | `ProtectedRoute` gates on the flag **by path** — a user with `must_change_password` is redirected to the forced path from any other route. |
| `client/src/App.tsx` | **+** the forced route, matching `ProtectedRoute` but **outside** `AppShell`. |
| `client/src/pages/admin/AdminSettings.tsx` | Reset state machine (`idle`/`confirm`/`done`), `handleReset`, `copyTemporaryPassword`, the **Reset password** footer button (rendered only when `form.id !== null && form.id !== user?.id`), the confirm/done/modify three-way drawer, the manual-copy fallback notice, and the **Must change** badge in the Status cell. |

---

## 6. The forced-change gate

The gate is **client-side, on the `ProtectedRoute` path**:

```tsx
if (user.must_change_password && location.pathname !== FORCED_PASSWORD_PATH) {
  return <Navigate to={FORCED_PASSWORD_PATH} replace />;
}
```

Three consequences worth being explicit about:

1. **The server still answers while the flag is set.** `GET /api/auth/me` returns `200` and the
   data endpoints keep working. This is a deliberate choice: the flag is a *workflow* state, not
   an authorization boundary. Making it an authorization boundary would mean a database read on
   the hot path of every request, and would need a decision about which endpoints are exempt
   (`/me`, `/refresh`, `/logout`, `change-password` itself — the exemption list is longer than
   the rule). The endpoint that actually matters, `change-password`, already requires the
   temporary password, so knowing the old password is still the only way to set a new one.
2. **It is enforced on the path**, so a deep link into `/admin/forms` is gated identically to a
   click in the sidebar — no "reach the page before the guard mounts" window.
3. **It lives inside `ProtectedRoute`**, so `loading` is resolved before the check reads `user`
   (otherwise a refresh would bounce the user to `/login`).

The route is **outside `AppShell`** — the user has nothing to navigate to, and showing a sidebar
full of links that all redirect straight back would be noise.

---

## 7. Verification

**Static**

1. `server`: `npm run typecheck` → 0 errors; `npm test` → **36/36** (3 Swagger coverage +
   33 libSQL, including the dialect-schema-parity test that scans `TURSO_DDL` for `*_at` columns).
2. `client`: `npm run typecheck` → 0 errors; `npm run build` → succeeded (1911 modules,
   354.11 kB / 99.62 kB gzip).

**Live, against the Turso-backed server** (`DB_MODE=turso`), via throwaway PowerShell probes
(~40 assertions across three scripts, all passing after correcting two probe bugs of my own):

| Check | Result |
| --- | --- |
| `must_change_password` present on the user DTOs | present on `GET /api/users` (was **missing** — see below) |
| Generated password shape | 14 chars, matches `^[a-hj-km-np-zA-HJ-NP-Z2-9]{14}$` |
| Flag armed by reset / cleared by change-password | armed → cleared, both read back from the DB |
| `change-password` with the temporary value | `200`, returns a user with `must_change_password: false` |
| The temporary password immediately after a successful change | rejected |
| A second reset | yields a **different** password and kills the previous one |
| Self-reset (`id === req.user.id`) | `400` — *"You cannot reset your own password. Use Change Password instead."* |
| Staff token / anonymous / garbage token | `403` / `401` / `401` |
| Unknown id / id `0` | `404` / `400` |
| Wrong current password on `change-password` | `400` (**not** `401` — the §6 trap in `change-password.md` is preserved) |
| `new === current` | `400` |
| `GET /api/auth/me` while the flag is set | `200` (the gate is client-side by design, §6) |
| Generic admin edit (`PUT /api/users/:id`) with the flag armed | flag **survives** — the `SET` list cannot clear it |

**Browser, in the running SPA** (signed in as `System Admin`, user id 8 `PW Test` as the subject):

1. The **Reset password** button is **absent** on the signed-in admin's own row, and present on
   another row. ✔
2. Confirm view lists the four consequences; **Cancel returns to the edit form**, not out of the
   drawer. ✔
3. Confirming shows the temporary password **once**, with the *"shown only once"* warning. ✔
4. The **Copy** button failed in this environment (`navigator.clipboard` denied) and the UI
   degraded exactly as designed — *"Could not copy automatically — select the password above and
   copy it manually."* — and the label fell back from *Copied* to *Copy* instead of getting stuck. ✔
5. Closing the flow, the grid row showed the **Must change** badge (the grid refetches after a
   reset, so the badge is not optimistic). ✔
6. Deep-linking to `/admin/settings` as the affected user redirected to
   `/account/password/required` — **the shell is absent** (`0` sidebar/topbar elements) and the
   heading is *"Set a new password"*. ✔
7. Wrong temporary password → *"Current password is incorrect"*, user stays on the forced screen. ✔
8. Mismatched new passwords → *"The new passwords do not match."*, **no request sent**. ✔
9. Correct temporary password → *"Password updated successfully."* and a **Continue to School
   Forms** button. ✔
10. Continuing landed on `/staff` with the full shell; navigating back to `/admin/settings`
    redirected by **role** (staff), not to the forced path — the flag was cleared. ✔
11. The **Must change** badge was gone from the grid afterwards. ✔

**Not reproducible:** an early reading showed the login page's Test User dropdown empty with
`—` brand stats. On a fresh load of `/login` it populated correctly (3 test users, 7 / 235 / 23
stats), and `GET /api/auth/users?org=academics` returns 3. The empty state came from that page
instance having been left open across a server restart (`500`s in its console log). **No bug** —
see §9 for the one small robustness note.

---

## 8. Known limitations / deferred

| Item | Note |
| --- | --- |
| **Self-service "Forgot password?"** | Needs a mail transport (Mailjet is planned but unwired), a single-use signed token with expiry, and enumeration-safe responses. The larger feature. |
| **Force a change on *first* login** | Admin-created accounts still start with an admin-chosen password that never expires. The same flag would cover it; what is missing is the delivery path that makes it *safe* (today the admin would have to read the password out and the user would have no way to rotate it on their own terms). |
| **Immediate session revocation** | *Unchanged from `change-password.md` §8.* JWTs are stateless and there is no `token_version` / `password_changed_at` column, so **tokens already issued are not revoked**. A session that is already rendered keeps working until it reloads (then the flag forces the change) or its access token expires (15 min); the 7-day refresh cookie keeps refreshing it. Closing this needs the `token_version` schema change described there. **The confirm dialog says this plainly rather than claiming the session is killed.** |
| **Emailing the temporary password** | Not done, and should not be: the whole point of the manual hand-off is that the credential does not travel over the same channel as the account's own email. |
| **Reset audit trail** | The Slack alert is the only record. A `password_resets` table would be the real answer. |

---

## 9. Residual state after verification

- User id 8 (`PW Test`, `pwtest.1789431078@schoolforms.local`) was **activated** during browser
  testing and **returned to `active = false`**. It is left with
  `must_change_password = true` (the last action was a reset probe), which is exactly the state
  the feature produces — re-activating it is the quickest way to demo the forced-change screen.
  Its password was deliberately replaced several times during verification; it is a throwaway
  test account.
- No real user's password, `active` flag, or hash was modified: every reset ran against id 8, and
  the DTO probes only **read** id 1's row. (The one write to a live row in this session was the
  `PUT` in the flag-survival test, and it wrote id 8's own values back unchanged apart from
  `active`.)
- One small observation, low priority, unrelated to this feature: the login page shows
  *"No users available"* when its initial `/api/auth/users` fetch fails, with no retry and no
  error message — a stale/transient failure looks the same as an empty organization.

---

## 10. Relationship to `change-password.md`

That plan's **§10 "Out of scope"** listed *"Admin resetting another user's password — different
feature (admin Settings → Users). Not requested."* and its **§2** argued that re-authentication
is mandatory *partly because there is no recovery path*. Both statements are now superseded by
this plan:

- The admin reset exists and is documented above.
- The re-authentication argument is **strengthened**, not weakened: recovery now exists, but it is
  admin-issued and produces a credential the user must replace. `change-password` still demands
  the current password, and self-reset still returns `400`.
