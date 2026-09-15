# Plan — Change Your Own Password

**Status:** Draft for review
**Date:** 2026-09-14
**Area:** Account (all roles) — banner user menu → `/account/password`

---

## 1. Goal

Let **any signed-in user** (admin, staff, School Contact) change their own password:

1. Clicking the **user name** in the top banner opens a small menu.
2. The menu contains a **"Change password"** link.
3. That link opens a page with three fields — **Current password**, **New password**,
   **Confirm new password** — and a submit button.

No admin involvement, no email round-trip. The user must prove they know their current
password (re-authentication), so a stolen/borrowed session alone cannot lock the owner out.

---

## 2. Why re-authentication is mandatory

Every other write in this app is authorized by the bearer token alone. Password change is
the one endpoint where **the token must not be sufficient**.

The access token lives in `localStorage`. If a shared laptop is left logged in, an attacker
with the token could otherwise set a new password and permanently own the account — the
legitimate owner would be locked out with no recovery path (there is no "forgot password"
flow, and no admin password-reset endpoint exists).

Requiring `current_password` and verifying it with `bcrypt.compare` against the stored hash
means the attacker needs the plaintext password, not just the token.

**This also constrains the HTTP status code** — see §6.

---

## 3. Current state

| Layer | Today |
| --- | --- |
| **Route** | `server/src/routes/auth.ts` has `/me`, `/register`, `/login`, `/users`, `/select`, `/refresh`, `/logout`, `/schools`, `/seed-admin`, `/seed-staff`. **No password-change route.** |
| **Query** | `server/src/db/queries.ts` has `getUserByEmail`, `getUserById`, `createUser`, `listUsers`, `updateUser`. `updateUser` writes `display_name / email / active / school_id / role / organization_id` — **it cannot write `password_hash`.** |
| **Schema** | `server/src/schemas.ts` has `registerSchema` / `createUserSchema` (both `password: min(8).max(100)`) and `updateUserSchema`. **No change-password schema.** |
| **Client API** | `client/src/lib/api.ts` has `login`, `registerStaff`, `me`, `logout`. **No `changePassword`.** |
| **Banner** | `client/src/components/layout.tsx` renders `.user-chip` as a **non-interactive `<div>`** (avatar + name + school) next to a separate logout icon button. |
| **Route** | No `/account/*` route exists. `App.tsx` mounts `/admin/*` (admin) and `/staff/*` (staff + cdm_contact). |

The banner chip is inert today, so there is nothing to re-purpose — it becomes a `<button>`.

---

## 4. API contract

### `POST /api/auth/change-password`

- **Auth:** bearer token, **any** authenticated role (`admin` / `staff` / `cdm_contact`).
- **Body:**

  | Field | Type | Rules |
  | --- | --- | --- |
  | `current_password` | string | required, 1–100 chars |
  | `new_password` | string | required, **8–100 chars** (matches registration), must differ from `current_password` |

  `confirm` is **not sent** — matching the two new-password fields is purely a client-side
  concern and sending it would add a field the server has no use for.

- **Responses:**

  | Status | When | Body |
  | --- | --- | --- |
  | `200` | Success | `{ "message": "Password updated successfully." }` |
  | `400` | Zod failure (too short, same as current) | `{ error, details }` |
  | `400` | Current password wrong | `{ "error": "Current password is incorrect" }` |
  | `401` | No/invalid bearer token | `{ "error": "Missing bearer token" }` |
  | `404` | Token subject no longer exists | `{ "error": "User not found" }` |
  | `429` | More than 10 attempts in 15 min | `{ "error": "Too many password change attempts. Try again later." }` |

---

## 5. Files to change

### Server

| File | Change |
| --- | --- |
| `server/src/db/queries.ts` | **+** `updateUserPassword(id, passwordHash)` — `UPDATE dbo.users SET password_hash = @passwordHash OUTPUT INSERTED.id WHERE id = @id`, returns `boolean`. Deliberately separate from `updateUser` so a password can never be set by the generic admin user-edit path. |
| `server/src/schemas.ts` | **+** `changePasswordSchema` with a `.refine()` that rejects `new === current` (so the check exists in exactly one place). |
| `server/src/routes/auth.ts` | **+** `POST /change-password` (`requireAuth`) with a dedicated rate limiter. |
| `server/src/routes/inventory.ts` | **+** `{ method: "post", path: "/api/auth/change-password", auth: "staff", tags: "Auth" }`. |
| `server/src/swagger.ts` | **+** the path object with `security: [{ bearerAuth: [] }]`. |

### Client

| File | Change |
| --- | --- |
| `client/src/lib/api.ts` | **+** `changePassword(current_password, new_password)`. |
| `client/src/components/layout.tsx` | `.user-chip` becomes a `<button>` that toggles a `.user-menu` dropdown containing a **Change password** item. Closes on outside click, `Esc`, and route change. |
| `client/src/pages/account/ChangePasswordPage.tsx` | **NEW** — the three-field form. |
| `client/src/App.tsx` | **+** `/account/password` inside `ProtectedRoute` **with no `roles` prop** → every authenticated role. Wrapped in `AppShell` so the banner stays visible. |
| `client/src/styles/global.css` | **+** `.user-menu-wrap` / `.user-menu` / `.user-menu-head` / `.user-menu-item` + a caret, and hover/focus states on `.user-chip`. |

---

## 6. The status-code trap (must not be 401)

`client/src/lib/api.ts` treats **any 401 on an authenticated request** as "access token
expired": it clears the stored token, calls `/api/auth/refresh`, and replays the request.
A 401 therefore means *session gone*, not *validation failed*.

If "current password is incorrect" returned **401**, the user typing a wrong password would
(1) have their session silently discarded, and (2) get bounced to `/login` — the app would
appear to forget who they are because they made a typo.

So a wrong current password returns **400**. This is the single most important detail in the
implementation and is called out in a comment at both the route and the client method.

---

## 7. Page behaviour

```
Change password                                    [heading]
Keep your account secure.                          [subtitle]

┌─ card (max-width 480) ──────────────────────────────────┐
│  CURRENT PASSWORD   [••••••••••••]                      │
│  NEW PASSWORD       [••••••••••••]                      │
│  CONFIRM NEW        [••••••••••••]                      │
│                                                          │
│  [ success / error banner ]                             │
│                                                          │
│  [ Update password ]  [ Cancel ]                        │
└──────────────────────────────────────────────────────────┘
```

- Fields reuse the app's `.filter-group` label-over-input idiom, so they inherit
  `height: var(--control-h)` automatically and match every other control in the app.
- **Client-side checks** (all before the request): all three required → new ≥ 8 chars →
  new ≠ current → new === confirm.
- **On success:** clear all three fields, show a green confirmation, and keep the user
  signed in. No forced logout.
- **On `400`:** show the server's message verbatim (e.g. "Current password is incorrect")
  in the error banner.
- **Cancel** returns to the user's home for their role (`/admin` for admins, `/staff`
  otherwise) — same rule `HomeRedirect` already uses.

---

## 8. Known limitation — other sessions survive

JWTs are stateless and there is **no `token_version` / `password_changed_at` column** on
`dbo.users`. Changing the password therefore does **not** invalidate tokens already issued.
A session on another device stays usable until its access token expires (15 min) and it can
keep refreshing for up to 7 days.

This is a real gap, and closing it needs a schema change rather than a code change:

1. add `dbo.users.token_version INT NOT NULL DEFAULT 0`,
2. put `tv` in the access + refresh payloads,
3. compare it in `requireAuth` / `/refresh`,
4. `token_version += 1` on password change.

**Not included in this change** — it touches the users table, the token payloads, and both
auth middlewares. Flagged here so the decision is conscious rather than accidental. Happy to
add it as a follow-up.

---

## 9. Rate limiting

The global limiter is `300 req / 15 min` (`env.rateLimit`) — far too loose for an endpoint
that verifies a password, where each call is a guessing attempt. The route adds its own
limiter of **10 attempts / 15 min** so the endpoint cannot be used as a password oracle,
while never affecting normal traffic.

---

## 10. Out of scope

- **Admin resetting another user's password** — different feature (admin Settings → Users).
  Not requested.
- **"Forgot password" / email reset** — needs a mail round-trip and a signed single-use token.
- **Password strength meter / complexity rules** beyond the existing 8-character floor.
- **Session invalidation on change** — see §8.

---

## 11. Verification

1. `cd server; npm run typecheck` → 0 errors.
2. `cd server; npm test` → the 3 Swagger coverage tests pass (proves the new route is in
   `ROUTES` **and** `swagger.ts`, and that it requires bearer security).
3. `cd client; npm run build` → 0 errors (`noUnusedLocals` will catch leftovers).
4. **Wrong current password** → 400, message shown, **user stays signed in** (the §6 trap).
5. **`new === current`** → rejected before any request is sent.
6. **`confirm` mismatch** → rejected before any request is sent.
7. **Success** → sign out, sign back in with the **new** password → succeeds;
   the **old** password → `401 Invalid credentials`.
8. Verify the dropdown under all three roles and at mobile width (name is hidden there, so
   the trigger is the avatar and the menu must still open).
