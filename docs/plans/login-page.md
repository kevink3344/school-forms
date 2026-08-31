# Login Page Redesign — TeamSupportPro Style

**Date:** 2026-08-30
**Author:** Copilot
**Status:** Draft — for review
**Target:** `client/src/pages/LoginPage.tsx` (+ `client/src/styles/global.css`)
**Reference visual:** TeamSupportPro login (two-column: dark navy brand panel + right auth panel)

---

## Goal

Restyle the login page to match the attached reference: a **two-column layout** with a
dark navy brand panel on the left (logo, eyebrow label, big title, tagline, and **3 stat
boxes**) and the existing authentication form on the right (white card).

Rebrand it from "School Forms" to **"Google Submissions"**. The three stat boxes show
**Users**, **Schools**, and **Submissions** counts.

The current implementation renders a single centered card with the auth form. We keep ALL
existing login-mode behaviour (Select User test mode, Password production mode,
maintenance mode, `?admin=1` override) — this is purely a **visual/layout change** plus a
new public stats endpoint.

---

## What stays the same (do NOT touch)

- The three login modes and their branching logic in `LoginPage.tsx` (select / password / maintenance).
- `?admin=1` mode switcher.
- All auth endpoints (`/api/auth/login`, `/api/auth/select`, `/api/auth/refresh`, etc.).
- The `Centered` wrapper's role (signing in navigates away; loading state shows "Loading…").

---

## New backend: public login-stats endpoint

The login page renders before authentication, so the three counts must come from a
**public (no-auth) endpoint**.

### 1. Add a query helper in `server/src/db/queries.ts`

Add one function that returns the three counts for a given **organization** in a single
round-trip (three sub-selects in one `SELECT`), each scoped by `organization_id`:

```ts
export interface LoginStats {
  users: number;
  schools: number;
  submissions: number;
}

export async function getLoginStats(organizationId: number): Promise<LoginStats> {
  const rows = await execute<LoginStats>(
    `SELECT
       (SELECT COUNT(*) FROM dbo.users               WHERE organization_id = @orgId) AS users,
       (SELECT COUNT(DISTINCT s.id)
          FROM dbo.schools s
          JOIN dbo.forms f ON f.school_id = s.id
         WHERE f.organization_id = @orgId)                                              AS schools,
       (SELECT COUNT(*) FROM dbo.submissions         WHERE organization_id = @orgId) AS submissions`,
    { orgId: organizationId }
  );
  return rows[0] ?? { users: 0, schools: 0, submissions: 0 };
}
```

**Decision: stats are ORGANIZATION-WIDE.** The counts reflect the currently selected
organization (from the org dropdown in select mode), NOT global totals. Because the
login page is pre-auth, the client sends the selected org (by slug) so the server can
resolve it to an `organization_id`.

Notes:
- **Users & Submissions** carry a direct `organization_id` column (see
  `server/src/db/schema.ts`) — filter directly.
- **Schools** do NOT have `organization_id`. A school belongs to an org **through its
  forms** (`dbo.forms.school_id → dbo.schools.id`, and `dbo.forms.organization_id` is the
  tenant). So count `DISTINCT` schools that appear on forms in the org:
  `JOIN dbo.forms f ON f.school_id = s.id WHERE f.organization_id = @orgId`.
- **Default when no org is known:** if the client omits `org`, the server should default
  to the active/default org (the reference's "Legacy Default" behaviour) rather than
  returning the whole DB. Resolve the slug `default`/first active org.
- Guard for an empty result set (returns `0`s) so a cold/fresh DB never throws.

### 2. Add the route in `server/src/routes/health.ts`

The `/api/health` + `/api/info` router is the natural home (already mounted WITHOUT auth).
Add a `GET /api/health/stats` route that resolves the org slug → `organization_id`, then
calls `getLoginStats`:

```ts
import { getLoginStats } from "../db/queries.js";
import { getOrganizationBySlug } from "../db/queries.js";

healthRouter.get("/stats", async (req, res, next) => {
  try {
    const orgSlug =
      typeof req.query.org === "string" && req.query.org.trim()
        ? req.query.org.trim()
        : undefined;
    // Resolve slug -> org id; default to the first active org if no slug given.
    let organizationId: number | null = null;
    if (orgSlug) {
      const org = await getOrganizationBySlug(orgSlug);
      organizationId = org?.id ?? null;
    } else {
      const org = await getDefaultOrganization(); // returns first active org
      organizationId = org?.id ?? null;
    }
    if (organizationId == null) {
      res.json({ users: 0, schools: 0, submissions: 0 });
      return;
    }
    res.json(await getLoginStats(organizationId));
  } catch (err) {
    next(err);
  }
});
```

It should be **public** (no `requireAuth`) — the login page is not authenticated. Mount is
already wired: `app.use("/api/health", healthRouter)` in `server/src/index.ts`.

> **`getDefaultOrganization()`:** a small helper that returns the first active org (e.g.
> `SELECT TOP 1 * FROM dbo.organizations WHERE active = 1 ORDER BY id`). Used when the
> client doesn't pass `?org=`.

> **Alternative:** mount at `/api/stats` for a cleaner path, but `/api/health/stats`
> requires zero `index.ts` changes. Choose whichever; `/api/health/stats` is recommended.

### 3. TypeScript type in `client/src/types/index.ts`

```ts
export interface LoginStats {
  users: number;
  schools: number;
  submissions: number;
}
```

### 4. Client API method in `client/src/lib/api.ts`

Pass the selected org slug so the server can scope the counts to that org:

```ts
async getLoginStats(orgSlug?: string): Promise<LoginStats> {
  const qs = orgSlug ? `?org=${encodeURIComponent(orgSlug)}` : "";
  return request<LoginStats>(`/api/health/stats${qs}`, { auth: false });
}
```

---

## Frontend: layout & styling

### 5. Build the split layout in `LoginPage.tsx`

Replace the single `Centered` card with a full-screen two-column layout:

```
+--------------------------------------------------+-----------------------+
|  LEFT PANEL (navy)                               |  RIGHT PANEL (light)  |
|  - logo badge                                    |  - AUTHENTICATION     |
|  - eyebrow: ENTERPRISE STAFF SUPPORT             |  - SIGN IN            |
|  - title: Google Submissions                     |  - tagline            |
|  - tagline                                       |  - [form per mode]    |
|  - 3 stat boxes: Users / Schools / Submissions   |  - footer links       |
+--------------------------------------------------+-----------------------+
```

**Component structure (all inside the existing `LoginPage` default export):**

- `BrandPanel` (new inline sub-component) — takes `stats: LoginStats | null`.
  - Logo badge (reuse `.logo-badge` styling, `--accent` square).
  - Eyebrow label: `"ENTERPRISE STAFF SUPPORT"` (uppercase, letterspaced, muted white).
  - `<h1>` title: `"Google Submissions"`.
  - Tagline: `"Choose a test user and sign in instantly. The correct organization and team context will be applied automatically."` (**keep the reference text verbatim** — decided).
  - Three **static** stat boxes at the bottom: large number + uppercase label (`Users`,
    `Schools`, `Submissions`). NOT clickable (they only display on the homepage — decided).
    Numbers come from `stats`; show `—` while loading or `0` if null.
- `AuthPanel` (reuse existing form markup) — keep everything in the current `return`
  but move the form/login-mode logic into this panel. Only the wrapper changes.
- `Centered` wrapper replaced by a `LoginShell` with:
  ```tsx
  <div className="login-split">
    <BrandPanel stats={stats} />
    <div className="login-auth">
      {/* card with AUTHENTICATION / SIGN IN / form */}
    </div>
  </div>
  ```

**Keep the login-mode branching intact.** The three `effectiveMode` branches (select /
password / maintenance) still render inside the right panel. Only the `Centered`/card
wrapper changes to the two-column shell.

**State additions:**
```tsx
const [stats, setStats] = useState<LoginStats | null>(null);
```
Fetch in a `useEffect` that runs whenever the selected org changes (so switching org in
select mode refreshes the counts to that org). `ORG_OPTIONS` already defines the org
slugs:
```tsx
useEffect(() => {
  let cancelled = false;
  api.getLoginStats(orgSlug)   // org-wide scope, tied to the selected org
    .then((s) => { if (!cancelled) setStats(s); })
    .catch(() => { if (!cancelled) setStats(null); });
  return () => { cancelled = true; };
}, [orgSlug]);
```
`orgSlug` is the existing state already tracked for the select-mode org dropdown (default
`"academics"`), so no new state is needed for the org selector.

### 6. Add CSS to `client/src/styles/global.css`

Use existing design tokens (`--header-bg`, `--accent`, `--app-bg`, `--card-bg`,
`--text-muted`, `--radius`, `--font`). The left panel uses the navy `--header-bg` so it
matches the reference without new colors.

```css
/* ===== Login split layout ===== */
.login-split {
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(340px, 1fr);
  background: var(--app-bg);
}
.login-brand {
  background: var(--header-bg);
  color: #fff;
  padding: 56px 48px;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
}
.login-brand .brand-eyebrow {
  font-size: 11px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.12em; color: rgba(255,255,255,0.55); margin-top: 24px;
}
.login-brand h1 {
  font-size: 40px; font-weight: 700; line-height: 1.1; margin: 14px 0 0;
}
.login-brand .brand-tagline {
  color: rgba(255,255,255,0.72); font-size: 15px; line-height: 1.5;
  margin: 16px 0 40px; max-width: 420px;
}
.brand-stats {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 16px; max-width: 520px;
}
.brand-stat {
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: var(--radius);
  padding: 20px 18px;
}
.brand-stat .stat-num {
  font-size: 32px; font-weight: 700; line-height: 1;
}
.brand-stat .stat-label {
  font-size: 11px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.08em; color: rgba(255,255,255,0.6); margin-top: 8px;
}
.login-auth {
  display: flex; align-items: center; justify-content: center;
  padding: 32px;
}
.login-auth .card { width: 100%; max-width: 400px; padding: 32px; box-shadow: var(--shadow-card); }

@media (max-width: 900px) {
  .login-split { grid-template-columns: 1fr; }
  .login-brand { padding: 40px 24px; }
  .brand-stats { max-width: none; }
}
```

**Responsive:** below ~900px the left panel stacks above the form (2 columns → 1), matching
the reference's mobile behaviour intuitively.

---

## Files touched

| File | Change |
| --- | --- |
| `server/src/db/queries.ts` | Add `LoginStats` interface + `getLoginStats()` |
| `server/src/routes/health.ts` | Add public `GET /api/health/stats` |
| `client/src/types/index.ts` | Add `LoginStats` interface |
| `client/src/lib/api.ts` | Add `api.getLoginStats()` |
| `client/src/pages/LoginPage.tsx` | Split layout, brand panel, stat boxes, stats fetch |
| `client/src/styles/global.css` | Add `.login-split`, `.login-brand`, `.brand-stats`, responsive |

---

## Verification checklist

1. **Backend:** `GET /api/health/stats` returns `{ users, schools, submissions }` numbers
   (public, no token). `curl http://localhost:4000/api/health/stats`.
2. **Typecheck:** `cd client; npx tsc --noEmit` and `cd server; npm run build` (or
   `tsc --noEmit`) both pass.
3. **Layout:** Login page shows two columns — navy brand left, white auth card right.
4. **Title:** matches "Google Submissions". Eyebrow says "ENTERPRISE STAFF SUPPORT".
5. **Stat boxes:** three boxes labelled **Users**, **Schools**, **Submissions** with counts
   from the endpoint.
6. **Mode branching still works:** toggle Select / Password / Maintenance in Settings →
   login page right panel updates; `?admin=1` reveals password form in maintenance mode.
7. **Org-wide stats:** switching the org dropdown in select mode refreshes the three
   counts to that org (view changes to reflect the new org's users/schools/submissions).
8. **Loading state:** while stats load, boxes show `—`; once loaded, show real numbers.
9. **Responsive:** at < 900px the brand panel stacks above the form; no horizontal scroll.
10. **Static boxes:** stat boxes are non-clickable and purely informational.

---

## Resolved decisions

1. **Stat scope → ORGANIZATION-WIDE.** Counts are scoped to the currently-selected
   organization (from the select-mode org dropdown). If no org is chosen, default to the
   first active org. NOT global.
2. **Tagline → KEEP VERBATIM.** Use the reference text: "Choose a test user and sign in
   instantly. The correct organization and team context will be applied automatically."
3. **Stat boxes → STATIC.** Non-clickable; they only display on the homepage.
