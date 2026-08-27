# School Import — Implementation Plan

> **Status:** Draft for review
> **Date:** 2026-08-27
> **Audience:** Product & Engineering review

---

## 1. Overview

Add a **table of schools** that is populated from a public ArcGIS GeoJSON source, with
one **column per entry in `SCHOOL_TABLE_COLUMNS`**. This gives admins a browsable,
searchable list of schools (instead of only a dropdown picker), and future-proofs the
`schools` table with the extra attributes the district publishes.

**Data source (from `.env`):**

| Env var | Value |
|---------|-------|
| `SCHOOL_JSON` | `https://services2.arcgis.com/oqISN6Dt6ax5xklN/arcgis/rest/services/wcpss_location_details_opendata_public/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson` |
| `SCHOOL_TABLE_COLUMNS` | `Name, GradeLevel, Calendar` |

The GeoJSON returns a `FeatureCollection` where each `feature.properties` carries the
school attributes. Sample keys observed: `NAME`, `NAME_SHORT`, `GRADELEVEL`, `CALENDAR`,
`ADDR_FULL`, `DISTRICT`, `FID`, `MAGNET`, `BASE`, `WEBSITE`.

### Core loop

```
  ArcGIS GeoJSON (SCHOOL_JSON)         dbo.schools            Admin "Schools" page
  ──── fetch + parse ────►   upsert by source id  ────►   grid (por SCHOOL_TABLE_COLUMNS)
```

### School visibility scope

**Only admins see the full school list.** Every other authenticated user (staff) sees
**only the school tied to their profile** (`users.school_id`). This applies everywhere a
school list is shown:

| Surface | Admin | Staff |
|---------|-------|-------|
| Register page school picker | full list | full list (needed to pick on registration) |
| Admin Schools page (`/admin/schools`) | all, paginated | — |
| Admin Dashboard school filter | all schools | pinned to `school_id`, no "All schools" toggle |
| Admin Forms school selector | all schools | pinned to `school_id` |

This is enforced server-side so the API returns only what the caller may see; the frontend
also disables the broader selector for staff so the UI never implies access it doesn't have.

---

## 2. Goals / Non-goals

### Goals
- Populate `dbo.schools` from the remote ArcGIS feed.
- Render an admin **Schools** page whose table columns are exactly `SCHOOL_TABLE_COLUMNS`.
- Keep existing behavior working unchanged (register/school picker, submission scoping,
  admin filter by school) — the new columns are additive.
- Make the import **idempotent** (safe to re-run; no duplicate rows).
- **Scope school visibility**: non-admins see only their own school everywhere.

### Non-goals
- Not editing school data from the UI (read-only list for this iteration).
- Not making the `schools` columns **dynamic at runtime**. SQL Server columns are fixed at
  DDL time, so `SCHOOL_TABLE_COLUMNS` drives the **grid columns** and the **column→property
  mapping**, while the DB gets the specific new columns listed below.
- **No auto-import.** Import is **manual only** (an admin "Import" button). No scheduler,
  cron, or startup refresh in this iteration.
- **No auto-paging toggle** — pagination is fixed at **50 rows per page** and lives on the
  admin Schools page.

---

## 3. Design decisions

### 3.1 Column source of truth = `SCHOOL_TABLE_COLUMNS`
`SCHOOL_TABLE_COLUMNS` is a comma-separated list of **display labels**. Each label maps
(case-insensitive, spaces stripped) to a GeoJSON property and to a snake_case DB column:

| Label | GeoJSON property | DB column |
|-------|------------------|-----------|
| `Name` | `NAME` | `name` (exists) |
| `GradeLevel` | `GRADELEVEL` | `grade_level` (new) |
| `Calendar` | `CALENDAR` | `calendar` (new) |

Mapping rule: normalize the label to upper case and strip spaces (`Name`→`NAME`,
`GradeLevel`→`GRADELEVEL`); if that property is missing in a feature, the column is `null`.

### 3.2 Dedupe/identity
GeoJSON features include a stable `FID` and a `TAG`. We add a **`source_id`** column to
store the `FID`, and **upsert** on it. This keeps the import idempotent: re-running the
feed updates in place instead of inserting duplicates. The existing unique index on
`name` stays for name-based lookups (registration picker), but `source_id` becomes the
import key.

> Existing rows (e.g. the seeded `Sample School`) have no `source_id` → treated as `null`.
> Upsert only keys off rows that already have a `source_id`; rows without one are left
> untouched by the importer.

### 3.3 Fetch happens server-side
The ArcGIS feed is fetched by the **server** (Node), not the browser (avoids CORS and
keeps the URL/secret internal). Node 20+ has a built-in `fetch`, so no new dependency.

---

## 4. Config — `server/src/config/env.ts`

Add:

```ts
schoolImport: {
  url: required("SCHOOL_JSON", ""),
  columns: (process.env.SCHOOL_TABLE_COLUMNS ?? "")
    .split(",")
    .map((s) => s.trim().trim())
    .filter(Boolean),
},
```

> Validation note: `required("SCHOOL_JSON", "")` — because the URL is long and stored in
> `.env`, falling back to `""` and letting the import log a "not configured" error is safer
> than throwing at boot for local devs who omit it. If `url` is empty, the import endpoint
> returns `400 { error: "School import not configured" }`.

---

## 5. DB — `server/src/db/schema.ts`

### 5.1 Typed row shape
Extend the `School` interface:

```ts
export interface School {
  id: number;
  source_id: number | null;
  name: string;
  grade_level: string | null; // from SCHOOL_TABLE_COLUMNS column "GradeLevel"
  calendar: string | null;    // from SCHOOL_TABLE_COLUMNS column "Calendar"
  district: string | null;    // kept for backward compat (existing picker/filter)
  created_at: Date;
}
```

### 5.2 Idempotent DDL migration
The table already exists in Azure, so the existing `IF OBJECT_ID ... CREATE` won't add the
new columns. Add an idempotent **`ALTER TABLE ADD`** guarded by `COL_LENGTH`:

```sql
IF COL_LENGTH('dbo.schools', 'source_id') IS NULL
  ALTER TABLE dbo.schools ADD source_id INT NULL;
IF COL_LENGTH('dbo.schools', 'grade_level') IS NULL
  ALTER TABLE dbo.schools ADD grade_level NVARCHAR(50) NULL;
IF COL_LENGTH('dbo.schools', 'calendar') IS NULL
  ALTER TABLE dbo.schools ADD calendar NVARCHAR(50) NULL;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_schools_source_id')
  CREATE UNIQUE INDEX UX_schools_source_id ON dbo.schools(source_id) WHERE source_id IS NOT NULL;
```

Append these to `DDL_STATEMENTS` so `initDb()` applies them at startup. Schema type:
`source_id INT NULL`, `grade_level NVARCHAR(50) NULL`, `calendar NVARCHAR(50) NULL`.

---

## 6. Queries — `server/src/db/queries.ts`

- **Update `listSchools()`** to accept an optional `schoolId` scope and select the new
  columns. This powers the scoped admin dashboard / staff picker:
  - `listSchools(schoolId?: number | null)` → `SELECT id, source_id, name, grade_level,
    calendar, district, created_at FROM dbo.schools` + `WHERE id = @schoolId` when scoped,
    `ORDER BY name`.
- **Update `getSchool()`** likewise.
- **Add `listSchoolsPage({ page, pageSize })`** → returns `{ rows, total }` for the admin
  Schools page, using `OFFSET ... FETCH` (SQL Server) + a separate `COUNT(*)`.
- **Add `upsertSchoolFromSource(...)`**:

```ts
export async function upsertSchoolFromSource(s: {
  sourceId: number;
  name: string;
  gradeLevel: string | null;
  calendar: string | null;
  district: string | null;
}): Promise<School> {
  const rows = await execute<School>(
    `MERGE dbo.schools AS tgt
     USING (SELECT @sourceId AS source_id) AS src
       ON tgt.source_id = src.source_id
     WHEN MATCHED THEN
       UPDATE SET tgt.name = @name, tgt.grade_level = @gradeLevel,
                  tgt.calendar = @calendar,
                  tgt.district = COALESCE(@district, tgt.district)
     WHEN NOT MATCHED THEN
       INSERT (source_id, name, grade_level, calendar, district)
       VALUES (@sourceId, @name, @gradeLevel, @calendar, @district)
     OUTPUT INSERTED.id, INSERTED.source_id, INSERTED.name, INSERTED.grade_level,
            INSERTED.calendar, INSERTED.district, INSERTED.created_at;`,
    { sourceId: s.sourceId, name: s.name, gradeLevel: s.gradeLevel, calendar: s.calendar, district: s.district }
  );
  return rows[0];
}
```

> `MERGE` within a `WHEN MATCHED`/`WHEN NOT MATCHED` runs as a single statement, so no
> separate read-back is needed. Guard the other edits — `submissions.school_id` and
> `forms.school_id` are untouched (we add columns, not rows).

### 6.1 Parse helper
Add a small pure helper (in `queries.ts` or a new `schoolImport.ts`) to convert a raw
GeoJSON `FeatureCollection` into `upsert` inputs:

```ts
export function normalizeSchoolLabel(label: string): string {
  return label.replace(/\s+/g, "").toUpperCase();
}

export function featureToSchool(feature: any, columns: string[]): {
  sourceId: number;
  name: string;
  gradeLevel: string | null;
  calendar: string | null;
  district: string | null;
} {
  const p = feature?.properties ?? {};
  const get = (label: string) => {
    const key = normalizeSchoolLabel(label);
    const v = p[key];
    if (v === undefined || v === null || String(v).trim() === "") return null;
    return String(v).trim();
  };
  // "Name" is the primary display name; fall back to NAME_SHORT.
  const name = get("Name") || get("NameShort") || `School ${feature.id}`;
  return {
    sourceId: Number(feature.id ?? p.FID ?? 0),
    name,
    gradeLevel: get("GradeLevel"),
    calendar: get("Calendar"),
    district: get("District"),
  };
}
```

`columns` is `SCHOOL_TABLE_COLUMNS`, used to loop and build the row generically so
**adding a column to `SCHOOL_TABLE_COLUMNS` automatically flows through** to the grid.

---

## 7. Route — `server/src/routes/schools.ts`

Add an **admin-only** import + list columns endpoint, and make the list endpoint
**school-scoped** so non-admins only get their own school.

- **`GET /api/schools`** (no change to auth, but scoped) → if the caller is **staff**, return
  `listSchools(req.user!.school_id)`; if **admin**, return the full list. The registration
  picker calls the **public** `GET /api/auth/schools` which is unaffected (public, full list).
- **`GET /api/schools/columns`** (admin) → returns `env.schoolImport.columns` so the
  frontend renders exactly the configured table columns, in order.
- **`GET /api/schools/page?page=1&pageSize=50`** (admin) → paginated list for the Schools
  page. Returns `{ rows, total, page, pageSize, totalPages }`. `pageSize` is capped at 50.
- **`POST /api/schools/import`** (admin) → fetches `SCHOOL_JSON`, parses, upserts each
  feature, returns `{ total }`.

```ts
import { env } from "../config/env.js";
import { listSchools, upsertSchoolFromSource, featureToSchool } from "../db/queries.js";

// GET /api/schools — staff sees only their school; admin sees all.
// (Existing public listSchools used by registration is /api/auth/schools and stays public.)
schoolsRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const scope = req.user!.role === "admin" ? undefined : req.user!.school_id;
    const schools = await listSchools(scope);
    res.json(schools);
  } catch (err) { next(err); }
});

const MAX_PAGE_SIZE = 50;

schoolsRouter.get("/columns", requireAuth, requireRoles("admin"), (_req, res) => {
  res.json({ columns: env.schoolImport.columns });
});

schoolsRouter.get("/page", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.pageSize) || MAX_PAGE_SIZE));
    const { rows, total } = await listSchoolsPage({ page, pageSize });
    res.json({ rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
  } catch (err) { next(err); }
});

schoolsRouter.post("/import", requireAuth, requireRoles("admin"), async (_req, res, next) => {
  try {
    if (!env.schoolImport.url) {
      res.status(400).json({ error: "School import not configured (SCHOOL_JSON empty)" });
      return;
    }
    const resp = await fetch(env.schoolImport.url);
    if (!resp.ok) {
      res.status(502).json({ error: `School feed returned ${resp.status}` });
      return;
    }
    const geojson = await resp.json();
    const features = geojson?.features ?? [];
    for (const f of features) {
      await upsertSchoolFromSource(featureToSchool(f, env.schoolImport.columns));
    }
    res.json({ total: features.length });
  } catch (err) { next(err); }
});
```

> **Imported vs updated:** `MERGE` doesn't easily report which happened, so the endpoint
> returns `{ total: features.length }` and the UI shows "Imported N schools". Simple and
> unambiguous.

---

## 8. Frontend

### 8.1 Types — `client/src/types/index.ts`
Extend `School`:

```ts
export interface School {
  id: number;
  source_id: number | null;
  name: string;
  grade_level: string | null;
  calendar: string | null;
  district: string | null;
  created_at: string;
}
```

### 8.2 API — `client/src/lib/api.ts`
```ts
listSchoolColumns(): Promise<{ columns: string[] }> {
  return request("/api/schools/columns", { auth: true });
},
listSchoolsPage(page = 1, pageSize = 50): Promise<{
  rows: School[]; total: number; page: number; pageSize: number; totalPages: number;
}> {
  return request(`/api/schools/page?page=${page}&pageSize=${pageSize}`, { auth: true });
},
importSchools(): Promise<{ total: number }> {
  return request("/api/schools/import", { method: "POST", auth: true });
},
```

### 8.3 New page — `client/src/pages/admin/AdminSchools.tsx`
A read-only, **paged** table whose **headers come from `listSchoolColumns()`**, with an
**Import** button that calls `importSchools()` then refetches page 1.

- Fetch columns once (`useEffect`), then `api.listSchoolsPage(page, 50)`.
- State: `page`, `totalPages`, `total`, `rows`.
- Render `<table className="grid">` with a `<th>` per column label.
- For each school row, map each column label → value via the same normalization used
  server-side, using `School` fields `name`, `grade_level`, `calendar`.
- **Pagination footer**: "‹ Prev / Next ›" buttons, "Page X of Y", "N schools (*50* / page)".
  `pageSize` is fixed at 50 (client always sends 50).
- Row click → no detail page yet (out of scope).

### 8.4 Routing — `client/src/App.tsx`
```tsx
<Route
  path="/admin/schools"
  element={
    <ProtectedRoute roles={["admin"]}>
      <AppShell><AdminSchools /></AppShell>
    </ProtectedRoute>
  }
/>
```

### 8.5 Nav — `client/src/components/layout.tsx`
Add a "Schools" sidebar link in the admin block, below Forms:

```tsx
<NavLink to="/admin/schools" className="sidebar-link">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 21h18M5 21V7l7-4 7 4v14" />
    <line x1="9" y1="9" x2="9" y2="9.01" />
    <line x1="15" y1="9" x2="15" y2="9.01" />
  </svg>
  <span className="s-label">Schools</span>
</NavLink>
```

---

## 9. Files changed

| File | Change |
|------|--------|
| `server/src/config/env.ts` | add `schoolImport` config |
| `server/src/db/schema.ts` | extend `School` interface; add idempotent `ALTER TABLE` DDL |
| `server/src/db/queries.ts` | update `listSchools` (scope), `getSchool`; add `listSchoolsPage`, `upsertSchoolFromSource`, `normalizeSchoolLabel`, `featureToSchool` |
| `server/src/routes/schools.ts` | scope `GET /`; add `GET /columns`, `GET /page`, `POST /import` |
| `server/src/routes/auth.ts` | scope `GET /api/auth/schools` for logged-in non-admins (public only when not authenticated) |
| `server/src/auth.ts` | add `optionalAuth` middleware (so `/api/auth/schools` can scope only when a token is present) |
| `client/src/types/index.ts` | extend `School` |
| `client/src/lib/api.ts` | add `listSchoolColumns`, `listSchoolsPage`, `importSchools`; make `listSchools` scoped-aware |
| `client/src/pages/admin/AdminSchools.tsx` | new page (paged, import) |
| `client/src/pages/admin/AdminDashboard.tsx` | staff-proof the school filter (pin to `school_id`, remove "All schools") |
| `client/src/pages/admin/AdminForms.tsx` | staff-proof the school selector (pin to `school_id`) |
| `client/src/App.tsx` | add `/admin/schools` route |
| `client/src/components/layout.tsx` | add "Schools" nav link |
| `client/src/styles/global.css` | add pagination + staff-proofed filter styles |

---

## 10. Decisions (resolved)

1. **Import trigger — MANUAL.** An admin clicks **Import** on the Schools page. No
   scheduler / cron / startup refresh.
2. **Pagination — 50 rows/page.** Fixed on the admin Schools page. The server caps
   `pageSize` at 50; the client always requests 50.
3. **School visibility — scoped.** Non-admin users see **only their own school**
   (`users.school_id`) in every school list. Admins see all. Enforced server-side; the
   frontend disables the broader selectors for staff so the UI never implies more access.
4. **`district`** — leave `district` untouched by the importer (admin-managed). Only set it
   when previously null; never overwrite an existing value.
5. **Deletion / sync — KEEP.** Schools that vanish from the feed are retained (no delete),
   preserving FK references from `users`, `forms`, and `submissions`.

---

## 11. Open questions for the reviewer

1. **Column set** — `SCHOOL_TABLE_COLUMNS` currently is `Name, GradeLevel, Calendar`.
   Should we also surface `ADDR_FULL` (full address) or `NAME_SHORT` as columns? Adding one
   to `SCHOOL_TABLE_COLUMNS` should "just work" given the generic mapping.
2. **Default school filter for staff on the dashboard** — with the selector pinned to their
   school, should the dashboard still show the (single, disabled) school row, or hide the
   filter entirely and rely on a subtitle like "All submissions for {school}"? Recommendation:
   show a disabled, read-only selector so the layout stays consistent.

---

## 12. Rollout & testing

1. Add the env vars to Azure App Settings (`SCHOOL_JSON`, `SCHOOL_TABLE_COLUMNS`).
2. Run `npm run build` — confirm `tsc` passes server + client.
3. Deploy; hit `/api/health` → `dbReady: true`.
4. `POST /api/schools/import` (as admin) → `{ total: N }`.
5. `GET /api/schools` as **admin** → full list with `grade_level`/`calendar` populated.
6. `GET /api/schools` as **staff** → only their school.
7. `GET /api/schools/page?page=1&pageSize=50` → `{ rows, total, totalPages }`.
8. Check `/admin/schools` renders the configured columns, is paginated, and the Import
   button populates data.
9. Regression: registration school picker; admin "Filter by school" (full list); staff
   dashboard/filter pinned to their school.
