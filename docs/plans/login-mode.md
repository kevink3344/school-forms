**Date:** 2026-07-21

**Author:** Copilot

**Status:** Reference guide

---

## Purpose

This document is a **Login Mode** feature (Settings → Login Mode) recipe you can re-implement in multiple projects. Use this as a checklist/reference when wiring the same three-button login mode switch (**Select User (Test)**, **Password (Production)**, **System Maintenance**) into each application. See this url for example: https://teamsupportpro-development.azurewebsites.net/login

---

## What the feature does (as implemented here)

A single app-wide setting, `login_mode`, controls what the `/login` page shows:

- Mode | Button label | Login page behavior
- **`select` | Select User (Test) | Dropdown of organizations → dropdown of users → "Sign In as Selected User" (no password). Intended for test/demo environments.**
- `password` | Password (Production) | Email + password form (`POST /api/auth/login-with-password`), bcrypt-verified. Intended for production.
- `maintenance` | System Maintenance | Login form is hidden; a static maintenance message is shown instead. A URL query param (`?admin=1`) lets a super admin bypass this and still reach the password form.

Key properties of the reference implementation:

- **Single global setting**, stored in a generic `app_settings` key/value table — not per-organization or per-user.
- **Environment variable override**: `LOGIN_MODE` (env var) takes precedence over the stored DB value when set to a valid mode. This lets ops/hosting config force a mode (e.g., force `maintenance` during a deploy) without touching the database, and the Settings UI shows a banner and disables the buttons when this override is active.
- **Public read, admin-only write**: any client (even unauthenticated) can `GET` the current mode so the login page can render correctly; only `administrator`/`super_admin` can `PUT` a new value.
- **A companion `maintenance_message` setting** (free text) is shown only in maintenance mode and is editable inline right below the three buttons when `maintenance` is selected.
- **`/api/info` exposes `loginModeOverride`** (derived from the env var) purely so the Settings UI can show the "locked by environment variable" banner — this is a UI nicety, not required for the core mechanism.

---

## Reference Files (this repo)

- Concern | File
- **Generic key/value settings store + `login_mode`/`maintenance_message` keys | server/src/routes/settings.ts**
- Three-button toggle UI + maintenance message editor | client/src/pages/SettingsPage.tsx (search `Login Mode`, `handleLoginModeToggle`)
- Login page conditional rendering per mode | client/src/pages/LoginPage.tsx
- Select-mode login endpoint (no password) | server/src/routes/auth.ts — `POST /api/auth/login`
- Password-mode login endpoint | server/src/routes/auth.ts — `POST /api/auth/login-with-password`
- Env var override + info endpoint | server/src/routes/health.ts — `GET /api/info`
- Settings client helper (`getPublicSetting`/`updateSetting`) | client/src/api/settings.ts

---

## Prerequisites in the target project

Before porting, confirm the target project has (or is willing to add) equivalents of:

1. A generic **app settings key/value table** (or any config store) that supports "get by key" (public) and "set by key" (admin-only). If one doesn't exist, this is the first thing to add — it's reusable well beyond login mode.
2. A **JWT/cookie-based auth system** with at least one "no password" or low-friction sign-in path (for `select` mode) and a password-based path (for `password` mode). If the target project only has password auth, `select` mode can be scoped down or omitted (see Adaptation Notes).
3. An **admin/role check** helper (something like `req.user.role === 'administrator'`) to gate the `PUT` endpoint and the Settings UI panel.
4. A dedicated **Login page component** that currently renders one login form — it will be extended to branch on the mode.

---

## Step-by-Step Porting Guide

### Phase 1 — Backend: Settings Storage

1. If not already present, create/reuse a table like:

```sql
   CREATE TABLE IF NOT EXISTS app_settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );
```

1. Add a settings router (or extend an existing one) with:
- `GET /api/settings/:key` — public (no auth middleware). Look up the row; if missing, return a sensible default (e.g. `login_mode` defaults to `'select'`).
- `PUT /api/settings/:key` — behind `authenticateToken` + an admin-role check (403 otherwise). Upsert via `INSERT ... ON CONFLICT(key) DO UPDATE`.
- Maintain an **allow-list of valid keys** (`ALLOWED_KEYS` set) so arbitrary keys can't be read/written — always include `login_mode` and `maintenance_message` in this list.
1. Add the environment variable override **only in the GET handler** for `login_mode`:

```tsx
   if (key === 'login_mode') {
     const envOverride = process.env.LOGIN_MODE?.trim().toLowerCase()
     if (envOverride === 'maintenance' || envOverride === 'select' || envOverride === 'password') {
       res.json({ key: 'login_mode', value: envOverride })
       return
     }
   }
```

This keeps the override read-only from the API's point of view — a `PUT` while the env var is set still writes to the DB, but reads will keep returning the env value until the env var is removed. The Settings UI should treat this as "locked" (see Phase 3).

### Phase 2 — Backend: Login Endpoints

1. **Select-mode endpoint** (`POST /api/auth/login`): accepts a `userId` (and, if multi-tenant, an `organizationId`), skips password verification entirely, loads the user, issues a JWT, sets an auth cookie, returns `{ token, user }`. Also add a `GET` endpoint to list users (optionally scoped by org) for the dropdown.
2. **Password-mode endpoint** (`POST /api/auth/login-with-password`): accepts `{ email, password }`, looks up the user by email, verifies via a hashed-password comparison (bcrypt or equivalent), rejects with a single generic `401 Invalid email or password` message for both "user not found" and "wrong password" (avoid user-enumeration), then issues the JWT/cookie the same way.
3. Neither endpoint needs to know about `login_mode` — the mode is purely a **client-side rendering decision** for which form(s) to show. Both endpoints stay live regardless of mode (this is intentional: it lets a super admin use the `?admin=1` bypass to reach the password form even while `maintenance` is active).
4. Add an **admin bypass** convention for maintenance mode: reserve a query param (e.g. `?admin=1`) on the login route that, client-side only, reveals the password form even when `loginMode === 'maintenance'`. This is not a security boundary — the underlying endpoint was never blocked — it's just a discoverability affordance for admins/support staff.

### Phase 3 — Backend: Info Endpoint (optional but recommended)

Add (or extend) a lightweight `GET /api/info` endpoint that returns:

```tsx
{
  version: <app version>,
  loginModeOverride: <'select' | 'password' | 'maintenance' | null>, // from LOGIN_MODE env var
  // ...other non-sensitive build/env info the login page already shows (version, db mode, etc.)
}
```

The client uses `loginModeOverride` purely to render an informational banner in Settings ("locked by environment variable") and to disable the toggle buttons — it does not gate any security-relevant behavior.

### Phase 4 — Frontend: Settings Panel (3-button toggle)

1. Add a small section (can live in an existing "User Accounts"/"Security" settings panel or its own) with:
- Local state: `loginMode`, `loginModeSaving`, `loginModeError`, `loginModeSaved`, `loginModeOverride`.
- On mount: `getPublicSetting('login_mode')` → normalize to one of the three values (default `'select'`); `fetch('/api/info')` → store `loginModeOverride`.
- Three buttons (`Select User (Test)`, `Password (Production)`, `System Maintenance`), each calling a shared handler:

```tsx
     async function handleLoginModeToggle(nextMode) {
       const prev = loginMode
       setLoginMode(nextMode)          // optimistic
       setLoginModeSaving(true)
       try {
         await updateSetting('login_mode', nextMode)
         setLoginModeSaved(true)
       } catch (err) {
         setLoginMode(prev)            // rollback on failure
         setLoginModeError(err.message)
       } finally {
         setLoginModeSaving(false)
       }
     }
```

- Disable all three buttons when `loginModeSaving` or when `loginModeOverride` is set (env var wins), and show an amber banner explaining the lock + which env var to change.
- When `loginMode === 'maintenance'`, reveal an inline textarea bound to a `maintenance_message` draft state, with its own Save button (`updateSetting('maintenance_message', ...)`), following the same optimistic-save/rollback pattern.

### Phase 5 — Frontend: Login Page Branching

1. On mount, fetch `login_mode` (default to `'select'` while loading, so nothing flashes incorrectly) and `maintenance_message`.
2. Render logic (mirrors this repo's `LoginPage.tsx`):

```tsx
   {loginMode === 'maintenance' && !adminOverride && <MaintenanceNotice message={maintenanceMessage} />}

   {(loginMode === 'select' || loginMode === null) && <SelectUserForm ... />}

   {(loginMode === 'password' || loginMode === null || (loginMode === 'maintenance' && adminOverride)) &&
     <PasswordForm ... />}
```

- `loginMode === null` (still loading) intentionally renders **both** the select and password forms so the page isn't empty during the initial fetch; swap to the single correct form once the setting resolves.
- `adminOverride` reads a query param, e.g. `new URLSearchParams(location.search).get('admin') === '1'`.
1. Keep both underlying submit handlers (select-login, password-login) wired regardless of which form is visible — the mode only controls *visibility*, never which endpoints exist.

### Phase 6 — Wiring Up

1. Register the settings router and auth routes in the app's entry point if not already mounted.
2. Add `login_mode` and `maintenance_message` to the settings allow-list.
3. Document the `LOGIN_MODE` env var in the target project's README/deployment docs (valid values: `select`, `password`, `maintenance`; unset/invalid = no override).

---

## Adaptation Notes

- **No multi-tenancy in the target project?** Drop the organization dropdown from `select` mode — just list all users.
- **No "select user" concept desired at all?** You can implement only `password` and `maintenance` — the pattern still works with two buttons instead of three; the storage/env-override/Settings-UI mechanics are unchanged.
- **Need per-tenant login mode instead of global?** Change the setting key to be scoped (e.g. `organization_id` + `key` composite in the settings table) and pass the tenant id when reading/writing — the rest of the pattern (env override, admin gate, three-button UI, login-page branching) stays the same.
- **Security note:** `maintenance` mode as implemented here is a **UX-level gate only** — it hides the login form but does not block API access for already-authenticated sessions or the password endpoint itself. If you need maintenance mode to also reject all non-admin API traffic, add server-side middleware that checks `login_mode === 'maintenance'` and short-circuits with `503` for non-admin requests, in addition to (not instead of) the client-side rendering change.

---

## Verification Checklist (after porting)

1. Default state (no row in settings table, no env var): login page shows the select-user form.
2. Toggle to Password in Settings → login page now shows only the password form; select-user form no longer renders.
3. Toggle to System Maintenance → login page shows the maintenance message; entering `?admin=1` in the URL reveals the password form again.
4. Set the env var override (e.g. `LOGIN_MODE=maintenance`) → Settings UI shows the "locked" banner, buttons disabled, and the login page respects the env value even if the stored DB value differs.
5. Non-admin users get `403` when calling the `PUT` settings endpoint directly.
6. Unauthenticated `GET` of the setting still works (needed for the public login page).