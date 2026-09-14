# Reports Page — Implementation Plan

> **Status:** Draft for review
> **Date:** 2026-09-14
> **Source idea:** [`docs/features/report-idea.md`](../features/report-idea.md)
> **Audience:** Product & Engineering review

---

## 1. Summary

Add a **Reports** workspace — a new page where an admin (or an eligible staff
member) picks a form, chooses **any subset of that form's columns**, filters the
rows, previews the result, and exports it to **CSV, Excel, or PDF**. The chosen
configuration can be **saved as a named View** that reapplies automatically the
next time they open Reports.

Reports is deliberately a **self-contained workspace**, not a tweak to the
existing Submissions dashboard. It reuses the export plumbing that already exists
(`/api/export/*`, `getExportColumns`, `listSubmissions`, `buildExportRows`) but
adds the pieces the idea calls for that aren't there yet:

| Idea requirement | Status today | This plan |
| --- | --- | --- |
| View made of **all** submitted columns, user picks which to show | Partially — per-form `view_columns` drives the Admin grid, but it isn't per-user and isn't a report | ✅ per-view column selection |
| Staff-only columns "if they have the proper Role" | ✅ `fieldAccessRoles` / `filterColumnsForRole` exist | ✅ reuse as-is |
| **Filter rows** textbox | ❌ only structured filters (school/form/status/date) | ✅ new `q` filter |
| Export **CSV** | ✅ `/api/export/csv` | ✅ reuse |
| Export **Excel** | ❌ | ✅ new |
| Export **PDF** | ❌ | ✅ new |
| **Save a View** that returns on the next visit | ❌ | ✅ new `report_views` table |

---

## 2. Goals & non-goals

### Goals
1. **One page, one screen** for ad-hoc reporting: form → columns → filters → preview → export.
2. **Column picker over every column** of the selected form. Staff-only columns
   appear only when the viewer's role is granted access on that field.
3. **Row filter** (free text) plus the existing structured filters, applied
   *identically* to the preview and to every export format.
4. **Three export formats:** CSV, Excel (`.xlsx`), PDF.
5. **Saved Views:** named, per-user, with a default view that auto-applies on return.
6. **Server-enforced scoping:** staff/`cdm_contact` never leave their school;
   admin is org-scoped; staff-only data is never leaked to a role without access.

### Non-goals (v1)
- No scheduled or emailed reports.
- No cross-form / "all forms" report (columns are inherently per-form — see §18 Q5).
- No charts, pivots, or aggregation — this is a row-level report.
- No sharing of Views between users (personal views only; server model leaves room).
- No "export only selected rows" — the report exports the whole filtered set.
- No behavior change to `AdminDashboard`, `StaffQueue`, or the existing
  `ExportModal` (beyond an optional shared-component refactor, §12.3).

---

## 3. Current state (research baseline)

- **Existing export feature**
  - `server/src/routes/export.ts` → `GET /api/export/preview` and
    `GET /api/export/csv`, both `requireRoles("staff","cdm_contact","admin")`,
    **form-scoped** (`form_id` required), with `school_id` + `status` filters.
  - Helpers local to that file: `filterColumnsForRole`, `buildExportRows`,
    `csvEscape`, `formatSubmittedAt`.
  - `getExportColumns(formId)` (`db/queries.ts` :1372) → ordered
    `ExportColumn[] = { key: "field_N", label, staff_only, roles }`.
  - `listSubmissions({...})` (`db/queries.ts` :892) → `SubmissionRow[]`.
- **Existing per-form view config**
  - `dbo.forms.view_columns` + `getViewColumnsConfig` / `setViewColumns`
    (`db/queries.ts`), exposed at `GET|PUT /api/forms/:id/columns`
    (`routes/forms.ts` :295). This drives the **Admin Submissions grid only** and
    is *not* per-user. Reports is a different concern and will not reuse it (§18 Q8).
- **Client**
  - `client/src/components/ExportModal.tsx` — CSV-only drawer with a reusable
    `.col-picker` column UI, `preview` table, and `include staff-only` toggle.
  - `AdminDashboard.tsx` — filter bar + grid + export modal.
  - `api.exportPreview()` / `api.exportCsv()` in `client/src/lib/api.ts`.
- **Menu visibility** — `menu_items` setting toggles sidebar links per role.
  Keys live in **two** places that must stay in sync:
  `server/src/routes/settings.ts` (`MENU_ITEM_KEYS`) and
  `client/src/lib/settings.ts` (`MENU_ITEMS`, `MENU_ITEM_LABELS`).
- **Repetition that matters:** every mounted API route must be registered in
  **three** places, enforced by `server/src/swagger.test.ts`:
  1. `server/src/routes/inventory.ts` (`ROUTES`) — single source of truth,
  2. `server/src/swagger.ts` (`paths`),
  3. the actual router.

  New endpoints must not break that test (§17).

---

## 4. Recommended design decisions

| # | Decision | Recommendation | Why / alternative |
| --- | --- | --- | --- |
| D1 | Where the page lives | New page, routes `/admin/reports` (admin) and `/staff/reports` (staff + `cdm_contact`), sharing one component | The idea is role-aware ("Staff columns if they have the proper Role") and staff already have school-scoped export. Alt: admin-only v1 (see §18 Q4). |
| D2 | API surface | A **new `/api/reports` router** that imports extracted shared helpers | Keeps `/api/export/*` (a live contract used by `ExportModal`) frozen. Alt: bolt `q`/`format` onto `/api/export/*` — muddier and risks regressions. |
| D3 | Row filter | Server-side `q` added to `listSubmissions`, so preview **and** every export see the same rows | Client-only filtering would export unfiltered data — violates WYSIWYG (§14). |
| D4 | Excel | `exceljs` (MIT, pure JS) generated **server-side** | Real `.xlsx` with typed header + frozen row. Alt: SheetJS `xlsx`; or "Excel-compatible CSV" (no dep, but not a real workbook). |
| D5 | PDF | `pdfkit` (MIT, pure JS) generated **server-side**, landscape table with a repeating header | No Chromium needed on Azure App Service; scales with dataset. Alt: browser `window.print()` + print stylesheet (no dep, but no file, unreliable for big tables — §18 Q2). |
| D6 | Saved Views storage | New table `dbo.report_views`, one row per (user, view) | Personal, ordered, queryable, easy to extend to shared/org views later. Alt: JSON blob in `app_settings` keyed by user (not queryable). |
| D7 | Column config for Reports | Independent of `forms.view_columns`; stored **inside each saved View** (and in page state when unsaved) | `view_columns` is a per-form grid preference; a Report view is `{ form, columns, filters, format }` and belongs to a user. |
| D8 | Selecting columns sent to export | Send the chosen `columns` on the export request; server validates and applies them | Guarantees the file matches the preview. |

---

## 5. UI — Reports page

Layout follows the mock in the idea doc, with one addition (`Form`, required —
columns are per-form) and one split (`School` becomes a separate admin-only filter).

```
┌─ Reports ───────────────────────────────────────────────────────────────────┐
│ Form [ CDM ▾ ]   Saved View [ — ▾ ]   [ Select Columns (7) ]                │
│                                     Format [ CSV ▾ ]   [ Export ]  [ Save View ] │
├─────────────────────────────────────────────────────────────────────────────┤
│ School [ All ▾ ]  Status [ All ▾ ]  From [ ] To [ ]  Filter rows [ search… ] │
├─────────────────────────────────────────────────────────────────────────────┤
│ ☐  Date           Student Name   Course choice #1   Met Criteria?   Email …  │
│ ☐  9/10/26        John Smith     Math I             Yes             j…       │
│ …                                                                            │
│                                       12 of 132 rows · 7 columns             │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Toolbar row 1:** Form (required), Saved View dropdown, **Select Columns**
  button (opens the shared column picker), Format select, **Export**, **Save View**.
- **Toolbar row 2:** School (admin only — hidden for staff, who are locked to
  their own school), Status, Date from/to, **Filter rows** free-text input
  (debounced ~300 ms → refetch preview).
- **Preview grid:** sticky header, zebra rows, one checkbox column reserved for a
  future "export selection" feature (unused in v1). Columns are rendered from
  `viewKeys`; cell values read `row[key]` exactly like `ExportModal` does.
- **Empty/edge states:** no form selected → prompt; no columns selected → the
  picker footer warns and preview falls back to all role-visible columns
  (mirrors the `view_columns` "empty = all" safety rule).
- Reuse existing classes/tokens: `.filter-bar`, `.grid`, `.col-picker`,
  `.drawer`, `.badge`, `.primary-button`, `.secondary-button`.

---

## 6. API surface

All new endpoints are `requireAuth` + `requireRoles("staff","cdm_contact","admin")`
unless noted. **Tag:** `Reports`. Register each in `inventory.ts` **and** `swagger.ts`
(§17).

### 6.1 Preview & export

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/reports/preview` | Available columns + selected columns + preview rows + total. Powers the grid and the column picker. |
| `GET` | `/api/reports/export` | Download the filtered report as `format=csv\|xlsx\|pdf`. |

**Shared query contract** (mirrored 1:1 on preview and export):

```
form_id            integer  required
school_id          integer  optional  (admin only; staff forced to own school)
status             string   optional  (submitted|in_review|flagged|resolved)
from               date     optional  (ISO; submitted_at >=)
to                 date     optional  (ISO; submitted_at <=)
q                  string   optional  (free-text row filter, max 200 chars)
columns            string   optional  (comma-separated `field_N`; omit = all role-visible)
include_staff_only 0|1      optional  (admin only — same semantics as /api/export/csv)
format             csv|xlsx|pdf       (export only, default csv)
```

**`GET /api/reports/preview`** response:

```jsonc
{
  "available": [ { "key": "field_9", "label": "Student Name", "staff_only": false, "roles": null }, … ],
  "viewKeys": ["field_9", "field_12", "field_15"],   // effective selection
  "rows": [ { "submission_public_id": "CDM-1001", "submitted_at": "9/10/2026, 4:03:49 PM", "status": "submitted", "field_9": "John Smith", … } ],
  "total": 132
}
```

- `available` is the role-filtered column list for the picker (staff never see a
  staff-only column their role can't access; admin sees staff-only only when
  `include_staff_only=1` or when the saved view requested it).
- `rows` always carry **every** visible `field_N` value (same as
  `/api/export/preview`), so switching columns needs no refetch.
- `columns` in the request narrows `viewKeys`; unknown/unauthorized keys are
  dropped rather than 403'd (matches `getViewColumnsConfig`'s ghost-key handling).

### 6.2 Saved Views

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/reports/views` | List the caller's own views (`is_default` flagged). |
| `POST` | `/api/reports/views` | Create a view. |
| `PUT` | `/api/reports/views/:id` | Update a view (owner only). |
| `DELETE` | `/api/reports/views/:id` | Delete a view (owner only). |
| `POST` | `/api/reports/views/:id/default` | Mark as the user's default (clears any prior default). |

Optional: `POST /api/reports/views/:id/use` to stamp `last_used_at` when the page
applies a view (powering a "most recently used" fallback). Can be folded into
`GET` if we prefer fewer endpoints — see §11.

**View body (create/update):**

```jsonc
{
  "name": "CDM – missing contact info",
  "form_id": 1,
  "filters": { "school_id": 4, "status": "submitted", "from": "2026-08-01", "to": null, "q": "missing" },
  "columns": ["field_9", "field_12"],
  "format": "pdf",
  "is_default": true
}
```

Validated with a Zod schema in `server/src/schemas.ts`
(`reportViewSchema`: `name` 1–120 chars, `form_id` positive int,
`filters` a partial object of the contract above, `columns` array of
`/^field_\d+$/`, `format` enum). `is_default` is a convenience flag only —
`POST /views/:id/default` is the authoritative way to flip it.

---

## 7. Backend — extract shared export helpers

`routes/export.ts` currently owns `filterColumnsForRole`, `buildExportRows`,
`csvEscape`, and `formatSubmittedAt`. Reports needs all four. Extract them to a
new module so both routers consume one implementation (no behavior change):

```
server/src/export/table.ts        (new)
  export function filterColumnsForRole<T>(columns, role, includeStaffOnly): T[]
  export function formatSubmittedAt(value: Date): string
  export async function buildExportRows(formId, columns, submissions)
  export function csvEscape(value: unknown): string
  // New: a neutral table model the three writers share.
  export interface TableModel { headers: { header: string; key: string }[]; rows: Record<string, unknown>[] }
```

`routes/export.ts` then imports from `../export/table.js` — its responses stay
byte-identical. Reviewers can diff the CSV output before/after to confirm.

```
server/src/export/writers/
  csv.ts     → existing logic (BOM + CRLF + csvEscape), moved behind writeCsv(table)
  xlsx.ts    → exceljs workbook/sheet
  pdf.ts     → pdfkit landscape table
```

---

## 8. Backend — free-text row filter (`q`)

Add an optional `q` to `listSubmissions` (`db/queries.ts`). It is backward
compatible: callers that omit it behave exactly as today.

```ts
if (params.q) {
  clauses.push(`(
    s.public_id LIKE @q
    OR sch.name LIKE @q
    OR EXISTS (
      SELECT 1 FROM dbo.submission_values svq
      WHERE svq.submission_id = s.id
        AND CAST(svq.value AS NVARCHAR(MAX)) LIKE @q
    )
  )`);
  p.q = `%${params.q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
}
```

SQL is `... LIKE @q ESCAPE '\'` (add the `ESCAPE` clause) so a literal `%`/`_` in
the search term matches itself.

Notes for review:
- `submission_values.value` is stored as serialized text/JSON, so `LIKE` matches
  the **textual** form. Arrays (checkbox answers) match their stored text —
  acceptable for v1. A later upgrade can use `OPENJSON` for token-accurate array
  matching; call it out in code comments.
- Cap `q` at 200 chars in the route and reject overlong input with 400.
- The same clause builder is used by preview and export, so the filter can never
  diverge between "what you see" and "what you export".

---

## 9. Backend — export formats

All three formats consume the **same** `TableModel` built once per request from
the same filtered `listSubmissions` result, so the row/column set is identical
across formats.

### CSV (existing behavior, reused)
`\uFEFF` BOM + `\r\n` lines + `csvEscape` per cell. Header row uses the **field
label**; values are looked up by internal `field_N` key (existing convention).

### Excel — `exceljs`
- One worksheet named after the form (truncated to 31 chars, invalid chars stripped).
- Header row bold + frozen (`views: [{ state: "frozen", ySplit: 1 }]`), auto-filter on.
- Column widths derived from header + a sampled max cell width (clamped ~12–50).
- Values written as **strings** in v1 (matches current CSV semantics and avoids
  type-guessing); note in code that numeric/date typing is a possible follow-up.
- Filename: `{form_code}_{yyyymmdd}.xlsx`.

### PDF — `pdfkit`
- **Landscape** (`layout: "landscape", size: "LETTER"`), margins 36pt.
- Header block: title (form title), applied filters summary, generated timestamp,
  row/column count.
- Table: fixed-width columns derived from `available`/`viewKeys` proportionally,
  header row repeated per page, cell text wrapped with a max of 2–3 lines then
  ellipsized, alternating row shading.
- Footer: page `n` of `m`.
- Filename: `{form_code}_{yyyymmdd}.pdf`.
- **Known limitation (document in code):** `pdfkit`'s built-in Helvetica uses
  WinAnsi encoding — non-Latin characters won't render. If non-Latin support is
  needed, register a TTF font (`server/assets/fonts/…`). Flag in §18 Q2.

### Response headers
```
Content-Type:
  text/csv; charset=utf-8
  application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
  application/pdf
Content-Disposition: attachment; filename="<generated>"
```

### New dependencies
Add to `server/package.json` (both MIT, pure JS, no native build):
`exceljs`, `pdfkit` (+ `@types/pdfkit` in devDependencies).

---

## 10. Data model — `dbo.report_views`

One row per saved view, owned by a user. Add an idempotent `CREATE TABLE` batch to
`server/src/db/schema.ts` `DDL_STATEMENTS`, following the existing
`IF OBJECT_ID(...) IS NULL` convention:

```sql
IF OBJECT_ID('dbo.report_views', 'U') IS NULL
CREATE TABLE dbo.report_views (
  id              INT IDENTITY(1,1) PRIMARY KEY,
  user_id         INT NOT NULL,
  organization_id INT NULL,
  name            NVARCHAR(120) NOT NULL,
  form_id         INT NOT NULL,
  filters         NVARCHAR(MAX) NULL,   -- JSON: { school_id, status, from, to, q }
  columns         NVARCHAR(MAX) NULL,   -- JSON: ["field_9","field_12"]; NULL = all
  format          NVARCHAR(10) NOT NULL CONSTRAINT DF_report_views_format DEFAULT 'csv',
  is_default      BIT NOT NULL CONSTRAINT DF_report_views_is_default DEFAULT 0,
  last_used_at    DATETIME2 NULL,
  created_at      DATETIME2 NOT NULL CONSTRAINT DF_report_views_created_at DEFAULT SYSUTCDATETIME(),
  updated_at      DATETIME2 NOT NULL CONSTRAINT DF_report_views_updated_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_report_views_user FOREIGN KEY (user_id) REFERENCES dbo.users(id) ON DELETE CASCADE,
  CONSTRAINT FK_report_views_form FOREIGN KEY (form_id) REFERENCES dbo.forms(id) ON DELETE CASCADE
);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_report_views_user_name')
  CREATE UNIQUE INDEX UX_report_views_user_name ON dbo.report_views(user_id, name);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_report_views_user')
  CREATE INDEX IX_report_views_user ON dbo.report_views(user_id);
```

- `filters`/`columns` are JSON so the filter contract can grow without migrations
  (same rationale as `forms.view_columns`).
- Deleting a form cascades its views away (a view is useless without its form).
- `columns = NULL` means "all columns visible to this user" — the same safe
  fallback the grid uses.
- Queries go in `db/queries.ts`: `listReportViews(userId)`,
  `createReportView(...)`, `updateReportView(id, userId, patch)`,
  `deleteReportView(id, userId)`, `setDefaultReportView(id, userId)`.
  Every mutation is scoped by `user_id` in the `WHERE` clause (never trust the
  id alone — that's the ownership check).

---

## 11. Saved Views behavior

- **On load:** `GET /api/reports/views`. Apply, in order of preference:
  1. the user's `is_default` view,
  2. else the most recently used (`last_used_at DESC`) for the default form,
  3. else no view → form = first published, columns = all role-visible, format = CSV.
- **After a view is applied**, that view's `form_id`, `filters`, `columns`, and
  `format` populate page state; the preview loads from that state (single fetch).
- **Save View** opens a small modal: name (required, unique per user), optional
  "set as my default". Existing name → offer overwrite (client calls `PUT`).
- **Dirty tracking:** if the current state differs from the applied view, the
  Saved View dropdown shows an unsaved-changes dot and Save becomes "Save changes".
- **Rename / delete / set default** available from the dropdown's row actions.
- **last_used_at:** simplest option is to stamp it inside `GET /api/reports/views`
  when the client passes `?use=<id>`, avoiding a separate endpoint. Confirm in
  §18 Q9. Otherwise add `POST /views/:id/use`.

---

## 12. Frontend

### 12.1 New/changed files
- **`client/src/pages/reports/ReportsPage.tsx`** (new) — the shared page
  (toolbar, filter bar, preview grid, picker, save modal). Role from `useAuth()`
  decides whether the School filter is shown and which menu path is active.
- **`client/src/App.tsx`** — add routes:
  ```tsx
  <Route path="/admin/reports" element={<ProtectedRoute roles={["admin"]}><AppShell><ReportsPage /></AppShell></ProtectedRoute>} />
  <Route path="/staff/reports" element={<ProtectedRoute roles={["staff","cdm_contact"]}><AppShell><ReportsPage /></AppShell></ProtectedRoute>} />
  ```
- **`client/src/components/layout.tsx`** — sidebar links. Admin block gets
  `Reports` (icon `BarChart3` or `FileSpreadsheet`) next to Dashboard; staff block
  gets `Reports` next to Submissions. Both gated by `menuVisible("reports")`.
- **`client/src/lib/settings.ts`** — add `"reports"` to `MENU_ITEMS` and
  `MENU_ITEM_LABELS`. **`server/src/routes/settings.ts`** — add `"reports"` to
  `MENU_ITEM_KEYS`. (Two-place sync — the Settings → Menu Settings grid then lets
  an admin hide Reports per role.)
- **`client/src/lib/api.ts`** — new methods:
  ```ts
  reportPreview(params): Promise<ReportPreview>
  reportExport(params): Promise<void>          // blob → anchor download
  listReportViews(): Promise<ReportView[]>
  createReportView(input): Promise<ReportView>
  updateReportView(id, input): Promise<ReportView>
  deleteReportView(id): Promise<void>
  setDefaultReportView(id): Promise<ReportView>
  ```
  `reportExport` mirrors `exportCsv` (fetch with bearer token, `res.blob()`,
  `Content-Disposition` filename, object URL + anchor click).
- **`client/src/types/index.ts`** — add `ReportFormat = "csv" | "xlsx" | "pdf"`,
  `ReportFilters`, `ReportPreview { available; viewKeys; rows; total }`,
  `ReportView { id; name; form_id; filters; columns; format; is_default; last_used_at }`.
- **`client/src/styles/global.css`** — only if needed (`ReportPreview` reuses
  `.grid`/`.preview-table`; add `.toolbar-2` only if the mock's two-row toolbar
  needs its own class).

### 12.2 WYSIWYG state model
The page keeps **one** `ReportState` object; a single `buildReportQuery(state)`
serializes it to `URLSearchParams`, and preview + export both call it. There is no
second code path that can drift:

```ts
interface ReportState {
  formId: number | null;
  filters: ReportFilters;   // { school_id, status, from, to, q }
  columns: string[];        // field_N keys (empty = all visible)
  format: ReportFormat;
}
```

### 12.3 Shared column picker (recommended, low risk)
`ExportModal` already renders exactly the picker Reports needs (`.col-picker`,
Select-all, per-column `Staff` badge). Extract that markup into
`client/src/components/ColumnsPicker.tsx`:

```tsx
<ColumnsPicker
  columns={available}
  selected={selected}
  onToggle={...}
  onToggleAll={...}
  showStaffOnlyToggle={isAdmin}
  ...
/>
```

Then use it in **both** `ExportModal` and `ReportsPage`. If reviewers prefer zero
touch on `ExportModal`, duplicate the markup in v1 and note the follow-up — but
duplication here is the kind that drifts.

---

## 13. Scoping & security

| Concern | Rule |
| --- | --- |
| Route auth | `requireAuth` + `requireRoles("staff","cdm_contact","admin")` on every `/api/reports/*` route (views CRUD included). |
| Staff / `cdm_contact` school scope | `school_id` is **forced** to `req.user.school_id`; a `school_id` query param is ignored. A saved view's `filters.school_id` is also ignored for staff. |
| Admin scope | Requests carry `req.user.organization_id`; `school_id` is an optional narrowing filter. |
| Staff-only columns | `filterColumnsForRole(columns, role, includeStaffOnly)`: staff see a staff-only column only when `fieldAccessRoles(field)` includes their role; admin sees staff-only only with `include_staff_only=1`. `include_staff_only` is **ignored** for staff. Requested `columns` are intersected with the allowed set — an unauthorized key is silently dropped, never rendered. |
| Saved-view ownership | Every read/write is `WHERE user_id = req.user.id`. Another user's view id → 404 (not 403), so ids aren't probeable. |
| `q` safety | Capped at 200 chars; `%`/`_` escaped; parameterized (`@q`) — no string interpolation. |
| Export size | See §18 Q7. v1: cap the export at a configurable max rows (e.g. 10,000) and return 413/400 with a clear message if exceeded, rather than exhausting memory. |

---

## 14. "What you see is what you export"

This is the plan's core contract and the reason for D3 + D8:

```
        ┌──────────────────────────┐
state → │ buildReportQuery(state)  │ → ?form_id=&school_id=&status=&from=&to=&q=&columns=
        └────────────┬─────────────┘
                     │  same string, both calls
        ┌────────────┴─────────────┐
        ▼                          ▼
  /api/reports/preview      /api/reports/export
        │                          │
        └──── same clause builder + same column filter ────┘
                     │
                     ▼
        rows shown == rows exported
```

Acceptance test: for a given state, `preview.rows.length === preview.total` and
the exported file contains exactly those columns in `viewKeys` order and exactly
that many data rows.

---

## 15. Files to change

### Backend
| File | Change |
| --- | --- |
| `server/src/export/table.ts` | **New.** Extracted `filterColumnsForRole`, `buildExportRows`, `csvEscape`, `formatSubmittedAt`, `TableModel`. |
| `server/src/export/writers/csv.ts` | **New.** CSV writer (moved logic). |
| `server/src/export/writers/xlsx.ts` | **New.** `exceljs` workbook writer. |
| `server/src/export/writers/pdf.ts` | **New.** `pdfkit` landscape table writer. |
| `server/src/routes/export.ts` | Import shared helpers/writer; behavior unchanged. |
| `server/src/routes/reports.ts` | **New.** `/api/reports/preview`, `/export`, `/views*`. |
| `server/src/db/queries.ts` | Add `q` to `listSubmissions`; add `listReportViews` / `createReportView` / `updateReportView` / `deleteReportView` / `setDefaultReportView`. |
| `server/src/db/schema.ts` | Add `dbo.report_views` DDL + `ReportView` interface. |
| `server/src/schemas.ts` | Add `reportViewSchema`, `reportQuerySchema`. |
| `server/src/routes/settings.ts` | Add `"reports"` to `MENU_ITEM_KEYS`. |
| `server/src/routes/inventory.ts` | Register every new route (Swagger test enforces this). |
| `server/src/swagger.ts` | Add `paths` for the new routes + `Report*` schemas. |
| `server/src/index.ts` | Mount `app.use("/api/reports", reportsRouter)`. |
| `server/package.json` | Add `exceljs`, `pdfkit`; dev `@types/pdfkit`. |

### Frontend
| File | Change |
| --- | --- |
| `client/src/pages/reports/ReportsPage.tsx` | **New.** The page. |
| `client/src/components/ColumnsPicker.tsx` | **New** (extracted from `ExportModal`). |
| `client/src/components/ExportModal.tsx` | Use `ColumnsPicker` (or leave; see §12.3). |
| `client/src/App.tsx` | Routes `/admin/reports`, `/staff/reports`. |
| `client/src/components/layout.tsx` | Sidebar links + `menuVisible("reports")`. |
| `client/src/lib/settings.ts` | `MENU_ITEMS` / `MENU_ITEM_LABELS` += `reports`. |
| `client/src/lib/api.ts` | 7 new methods. |
| `client/src/types/index.ts` | `ReportFormat`, `ReportFilters`, `ReportPreview`, `ReportView`. |
| `client/src/styles/global.css` | Only if a new toolbar class is needed. |

### Docs
| File | Change |
| --- | --- |
| `docs/plans/report-plan.md` | This document. |

---

## 16. Phasing

**Phase 1 — Preview + CSV (end-to-end skeleton)**
- Extract `export/table.ts` + `csv.ts` (no behavior change), add `q` to `listSubmissions`.
- `reports.ts` with `/preview` + `/export?format=csv`.
- Reports page: form select, filters, row filter, column picker, preview grid, CSV export.
- Routes, sidebar link, `menu_items` key, Swagger + inventory entries.

**Phase 2 — Excel + PDF**
- `xlsx.ts` (`exceljs`) and `pdf.ts` (`pdfkit`); wire `format` into `/export`.
- Format selector in the toolbar.

**Phase 3 — Saved Views**
- `dbo.report_views` + queries + CRUD endpoints + Zod.
- Saved View dropdown, Save/rename/delete/set-default, default auto-apply.

**Phase 4 — Hardening**
- Export row cap, `q` escaping tests, role-matrix tests, Swagger coverage green,
  `npm run typecheck` on client + server, seed a demo view for the CDM form.

---

## 17. Testing & verification

- **Route inventory (blocking):** `server/src/swagger.test.ts` asserts every route
  in `inventory.ts` has a matching `swagger.ts` path/operation (and no orphans).
  Every new endpoint must be added to **both**, or the suite fails. Add a `Reports`
  tag group in the spec for tidiness.
- **Role matrix (new unit test):** for `admin`, `staff`, `cdm_contact` and a
  staff-only field with `roles: ["staff"]`, assert `filterColumnsForRole` and the
  preview `available` list match expectations; assert staff `school_id` is forced.
- **Filter parity (new test):** preview and export must return the same row count
  for the same query string (including `q`).
- **CSV regression:** snapshot `/api/export/csv` output before/after the helper
  extraction; must be byte-identical.
- **`q` escaping:** a term containing `%` / `_` matches literally.
- **Saved-view ownership:** user B cannot read/update/delete user A's view.
- **Manual:** `npm run typecheck` (`client` and `server`), `npm test` (server), and
  a browser pass on all three formats with a `staff` account vs an `admin` account.

---

## 18. Open questions / decisions needed

1. **The mock's first dropdown is labeled `[School Name]`, but the sample columns
   (`Course choice #1`, `Met Criteria?`) are form-specific.** Recommend `Form`
   (required) + a separate `School` filter, as drafted. Confirm — or is the
   intent "pick a school, then union the columns of every form used at it"?
2. **PDF engine:** `pdfkit` server-side (recommended) vs browser `window.print()`
   with a print stylesheet (no dependency). If non-Latin text must render, a TTF
   font asset is required.
3. **Excel engine:** `exceljs` (recommended) vs SheetJS vs "Excel-compatible CSV".
4. **Audience:** Reports for **admin + staff/`cdm_contact`** (recommended) or
   admin-only v1?
5. **Cross-form reports:** v1 is single-form (columns are per-form). Is an
   "all forms" report with the union of columns in scope later?
6. **Sharing:** views are personal in v1. Do we need org-shared or role-shared
   views eventually? (Model supports adding `shared`/`organization_id` later.)
7. **Volume:** what's the realistic max row count for an export, and is a hard cap
   acceptable? (Affects in-memory vs streaming generation.)
8. **Relationship to `forms.view_columns`:** confirm Reports is independent
   (recommended) — the Forms Designer's "View Columns" card should not change
   Reports behavior.
9. **`last_used_at`:** fold into `GET /views?use=<id>` (fewer endpoints) or add
   `POST /views/:id/use`?
10. **Should Reports appear for staff at all,** given staff already export CSV from
    their queue? If yes, should staff see *other* schools' data ever? (No — §13.)

---

## 19. Appendix — reference mock (from the idea doc)

```
[School Name]   [ Select Columns]   Select Format: [ PDF/CSV/Excel]

[ Filter rows (textbox) ]

Date | Student Name  |  Course choice #1 | Met Criteria? | Email | Phone | Parent Name
9/10/26  John Smith    Math I      Yes      jsmith@gmail.com   (919) 999-3333  Karen Smith
```

Mapping into this plan: `School` → separate admin-only filter (+ required `Form`
selector so columns resolve); `Select Columns` → `ColumnsPicker` bound to
`viewKeys`; format select → `ReportFormat`; `Filter rows` → `q` (server-side);
the header row → the preview grid rendered from `viewKeys` in that order.
