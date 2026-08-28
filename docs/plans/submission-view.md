# Per-Form Submission View Columns — Plan

> **Status:** Draft for review
> **Date:** 2026-08-27
> **Audience:** Product & Engineering review

---

## 1. Problem

On the **Admin → Submissions** dashboard, when a specific form is selected, the spreadsheet grid
renders **every** field column returned by the export preview. The CDM form has ~8+ columns that
push well past the page width, forcing horizontal scrolling and hiding the always-relevant
`Status` / `Submitted` columns.

The admin has **no way** to choose which columns appear in the **on-screen view**. At the same
time, the **Export** feature must stay exactly as it is — the CSV/export preview already lets the
admin pick columns *for export* and is a separate concern.

### Goals
1. Let an admin configure which columns are **displayed** in the submission view **per form**.
2. That configuration must **NOT** affect the Export modal or the CSV (export columns stay as-is).
3. The grid should never break layout (add a horizontal-scroll safety net regardless of config).

### Non-goals / constraints
- **Export is untouched.** No change to `/api/export/preview`, `/api/export/csv`, `ExportModal`,
  `getExportColumns()`, or `buildExportRows()`.
- **Staff queue view is untouched.** This is an admin-only dashboard feature.
- Column **reordering** is optional (Phase 2); the core ask is *choosing which columns* display.

---

## 2. Current behavior (research baseline)

### Frontend — `client/src/pages/admin/AdminDashboard.tsx`
- Loads forms + schools once; defaults `filters.form_id` to the first form.
- When a form is chosen, it calls `api.exportPreview({ form_id, school_id, status })` and passes
  the **whole** `preview.columns` to `<SpreadsheetGrid columns={preview.columns} rows={preview.rows} …>`.
- `SpreadsheetGrid` renders a checkbox column, then **every** `columns[]` entry, then `Status` and
  `Submitted` (hard-coded). The columns carry keys like `field_9`; cell data is read from
  `row[c.key]`.
- `ExportModal` independently re-fetches `exportPreview` and has its own checkbox picker + preview.

### Backend
- `GET /api/export/preview` (admin) → `{ columns: [{key,label,staff_only}], rows, total }`.
  Columns come from `getExportColumns(formId)` = **all** fields ordered by `sort_order`.
- `GET /api/export/csv` (admin) → same columns (optionally filtered by `include_staff_only`).
- `getExportColumns(formId)` in `server/src/db/queries.ts` is only referenced by `routes/export.ts`.

### Data model
- `dbo.forms` (id, title, description, school_id, designer_id, status, organization_id, created_at, updated_at)
- `dbo.form_fields` (id, form_id, label, type, options, required, staff_only, sort_order, placeholder)

---

## 3. Proposed design

Introduce a **per-form "view columns" configuration** stored on the form row, independent of the
field definitions and independent of export.

### 3.1 Storage — add `forms.view_columns`

Add a nullable `NVARCHAR(MAX)` column `view_columns` to `dbo.forms` that holds a JSON array of
field ids, e.g. `"[1,3,4]"`.

- `NULL` or empty → **default**: show **all** columns (current behavior) — fully backward compatible.
- Non-empty → show **only** those field ids, **in that order**.

```ts
// server/src/db/schema.ts — idempotent migration (own batch, COL_LENGTH guard)
`IF COL_LENGTH('dbo.forms', 'view_columns') IS NULL
   ALTER TABLE dbo.forms ADD view_columns NVARCHAR(MAX) NULL;`,
```

> Rationale for a JSON column over a per-field BIT: it lets the admin control *order* and any
> *subset* (including skipping a field) without mutating `form_fields`, and it keeps the view
> config independent of the form's field list. Field **deletion** is already handled by
> `reconcileFormFields`; a view key pointing at a deleted field is simply ignored at render time.

### 3.2 New canonical "columns" query

Add a single query that resolves the effective, ordered list of view columns from the config,
falling back to all fields (in `sort_order`) when unset. It returns the full available column list
(for the picker) **plus** the currently-selected keys (for the grid).

```ts
// server/src/db/queries.ts
export interface ViewColumnsConfig {
  columns: ExportColumn[];   // all available, in sort_order (with field_id)
  viewKeys: string[];        // effective ordered selection ("field_N"); all when unset
}

export async function getViewColumnsConfig(formId: number): Promise<ViewColumnsConfig> {
  const fields = await execute<{ id: number; label: string; staff_only: boolean }>(
    `SELECT id, label, staff_only FROM dbo.form_fields WHERE form_id = @formId ORDER BY sort_order`,
    { formId }
  );
  const columns: ExportColumn[] = fields.map((r) => ({
    key: `field_${r.id}`, label: r.label, staff_only: Boolean(r.staff_only),
  }));

  const form = await execute<{ view_columns: string | null }>(
    `SELECT view_columns FROM dbo.forms WHERE id = @formId`, { formId }
  );
  let configured: number[] = [];
  try {
    const raw = form[0]?.view_columns;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) configured = parsed.map(Number).filter(Number.isInteger);
    }
  } catch { configured = []; }

  const idSet = new Set(fields.map((f) => f.id));
  const viewKeys = configured.length
    ? configured.filter((id) => idSet.has(id)).map((id) => `field_${id}`)
    : columns.map((c) => c.key);
  return { columns, viewKeys };
}

export async function setViewColumns(formId: number, viewKeys: string[]): Promise<void> {
  const keys = viewKeys.map((k) => (m = /^field_(\d+)$/.exec(k)) ? Number(m[1]) : NaN)
    .filter(Number.isInteger);
  const json = keys.length ? JSON.stringify(keys) : null;
  await execute(
    `UPDATE dbo.forms SET view_columns=@json, updated_at=SYSUTCDATETIME() WHERE id=@id`,
    { id: formId, json }
  );
}
```

> Field-id `NaN` tolerance: invalid keys are dropped; an all-invalid result collapses to `NULL`
> (show all), preserving the safety default.

### 3.3 New API endpoints (admin only, org-scoped)

Add to `server/src/routes/forms.ts` (the forms router, which already has `requireRoles("admin")`).
Swagger annotations mirror the existing form endpoints.

**`GET /api/forms/:id/columns`** — returns the columns config for the form.

```ts
formsRouter.get("/:id/columns", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const form = await getForm(id, req.user!.organization_id);
    if (!form) { res.status(404).json({ error: "Form not found" }); return; }
    const cfg = await getViewColumnsConfig(id);
    res.json(cfg);
  } catch (err) { next(err); }
});
```

Response shape:

```jsonc
{
  "columns": [ { "key": "field_1", "label": "Student Name", "staff_only": false }, … ],
  "viewKeys": ["field_1", "field_4"]
}
```

**`PUT /api/forms/:id/columns`** — persists the selection.

```ts
formsRouter.put("/:id/columns", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const form = await getForm(id, req.user!.organization_id);
    if (!form) { res.status(404).json({ error: "Form not found" }); return; }
    const keys = Array.isArray(req.body?.view_keys) ? req.body.view_keys : [];
    if (keys.some((k: unknown) => typeof k !== "string" || !/^field_\d+$/.test(k))) {
      res.status(400).json({ error: "view_keys must be an array of field_N keys" }); return;
    }
    await setViewColumns(id, keys);
    res.json(await getViewColumnsConfig(id));
  } catch (err) { next(err); }
});
```

> **Export isolation is preserved:** these new endpoints only read/write `forms.view_columns`.
> `getExportColumns()` (used by `/api/export/*`) ignores it entirely.

### 3.4 `client/src/lib/api.ts` — new methods

```ts
async getFormViewColumns(id: number): Promise<{ columns: ExportColumn[]; viewKeys: string[] }> {
  return request(`/api/forms/${id}/columns`, { auth: true });
},
async setFormViewColumns(id: number, viewKeys: string[]): Promise<{ columns: ExportColumn[]; viewKeys: string[] }> {
  return request(`/api/forms/${id}/columns`, { method: "PUT", auth: true, body: { view_keys: viewKeys } });
},
```

The existing `ExportColumn` type is reused. `viewKeys: string[]` can be added to the return type.

### 3.5 Frontend — AdminDashboard grid uses view columns (export untouched)

- When a form is selected, fetch **both**:
  1. `api.exportPreview(...)` → rows (already contains every field keyed by `field_N`).
  2. `api.getFormViewColumns(formId)` → `{ columns, viewKeys }` for the **display** selection.
- Pass `viewColumns` (the resolved `viewKeys` → label map) to `SpreadsheetGrid`.
- `SpreadsheetGrid` renders the checkbox column, then **only** the requested view columns, then
  `Status` and `Submitted`. Cell values are read from `row[key]` exactly as today.

State sketch:

```ts
const [viewCfg, setViewCfg] = useState<{ columns: ExportColumn[]; viewKeys: string[] } | null>(null);

// inside the form-selected effect, after exportPreview resolves:
api.getFormViewColumns(formId).then((cfg) => {
  if (!cancelled) setViewCfg(cfg);
}).catch(() => { if (!cancelled) setViewCfg(null); });
```

```tsx
<SpreadsheetGrid
  columns={viewCfg?.columns ?? preview.columns}
  viewKeys={viewCfg?.viewKeys}
  rows={preview.rows}
  selectedForm={selectedForm?.title || ""}
  onOpen={(id) => navigate(`/admin/submissions/${id}`)}
/>
```

In `SpreadsheetGrid`, filter the render list:

```tsx
const visible = viewKeys
  ? columns.filter((c) => viewKeys.includes(c.key))
  : columns;
```

> **Why keep using `exportPreview` for rows?** It already returns every field value in each row,
> so the grid can choose which to render without a new data path. Export stays intact because
> `ExportModal` keeps calling `exportPreview` independently and is unaffected by `view_columns`.

### 3.6 Frontend — "Columns" config UI (on the Form Designer page)

The column-selection UI lives in the **Form Designer** page (per-form configuration while
designing), not on the Submissions page. When a form is open in the designer, a **"View Columns"**
card lists all available field columns as checkboxes, pre-checked to the current `viewKeys`
(selecting a fresh or unconfigured form defaults to all checked). **Save** calls
`api.setFormViewColumns(formId, checkedKeys)`.

- Show `staff_only` columns with a `Staff` badge (same as export picker), but allow toggling them
  on/off for the view.
- Default when no config exists: all checked (matches current behavior).
- Reordering (move up/down) is **deferred (Phase 2)** — the initial picker just chooses *which*
  columns show.
- The **Submissions page is unchanged** in terms of UI: it only *reads* the saved config (via
  `getFormViewColumns`) and renders the filtered grid. No Columns button/modal there.

### 3.7 CSS safety net — horizontal scroll

Even with a configured subset, guard the grid against any future overflow:

```css
.grid-wrap { overflow-x: auto; }
table.grid { min-width: 100%; }
```

Ensure `thead th` and the grid footer span the full width; add `scrollbar` styling only if desired.

---

## 4. Files to change

### Backend
| File | Change |
|------|--------|
| `server/src/db/schema.ts` | Add idempotent `ALTER TABLE dbo.forms ADD view_columns NVARCHAR(MAX) NULL` batch. |
| `server/src/db/queries.ts` | Add `getViewColumnsConfig(formId)` + `setViewColumns(formId, viewKeys)`. Reuse `ExportColumn`. |
| `server/src/routes/forms.ts` | Add `GET /:id/columns` and `PUT /:id/columns` (admin, org-scoped, Swagger-annotated). |
| `server/src/schemas.ts` | (Optional) add `viewColumnsSchema` for `PUT` body validation. |

### Frontend
| File | Change |
|------|--------|
| `client/src/lib/api.ts` | Add `getFormViewColumns()` + `setFormViewColumns()`. |
| `client/src/types/index.ts` | Add `ViewColumnsConfig` interface (`{ columns: ExportColumn[]; viewKeys: string[] }`). |
| `client/src/pages/admin/AdminDashboard.tsx` | Fetch view config; pass `viewKeys` to `SpreadsheetGrid` (render-time filter only — no edit UI). |
| `client/src/pages/admin/AdminFormDesigner.tsx` | Add a "View Columns" card with a checkbox picker; calls `getFormViewColumns` + `setFormViewColumns`. |
| `client/src/styles/global.css` | `.grid-wrap { overflow-x: auto; }` safety net. |
| `client/src/components/` (optional) | Extract a reusable `ColumnsPicker` component if the picker grows. |

---

## 5. Backward compatibility & edge cases

- **Default = all columns.** A form with no `view_columns` rows (or `NULL`) renders exactly as
  today. No migration of existing rows needed.
- **Deleted fields.** `getViewColumnsConfig` filters configured ids against existing fields, so a
  stale key is dropped rather than crashing.
- **Empty selection.** An admin unchecking everything saves `view_keys: []` → `setViewColumns`
  stores `NULL` → the grid falls back to showing **all** columns (safe, no crash, no "no columns"
  empty state). Communicated in the picker footer.
- **Export untouched.** `view_columns` is never read by `getExportColumns` / `/api/export/*`.
- **Staff queue.** Unaffected — it uses `listSubmissions` / `SubmissionRow`, not the grid.

---

## 6. Testing

1. **Default**: select a form with no config → grid shows all columns (current behavior).
2. **Configure**: open the form in the designer, uncheck some columns in the "View Columns"
   card, Save → on the Submissions page the grid updates to the chosen subset.
3. **Persistence**: reload the page / re-select the form → selection persists (from DB).
4. **Export isolation**: set a narrow view, then open the Export modal / download CSV → export
   still shows/exports **all** columns (or the admin's export choices), ignoring `view_columns`.
5. **All columns back**: check all, Save → grid returns to full width.
6. **Empty selection**: uncheck everything, Save → grid falls back to all columns (no crash).
7. **Type-check**: `npm run typecheck` in both `server/` and `client/`.

---

## 7. Rollout / deployment

- The `schema.ts` ALTER runs idempotently at startup (COL_LENGTH guard) — no manual migration.
- Deploy server, then client. Both features are additive; no data reset.

---

## 8. Decisions (confirmed 2026-08-27)

1. **Empty selection → show all.** An admin unchecking every column saves an empty list, which
   `setViewColumns` collapses to `NULL`, so the grid falls back to showing all columns (no crash,
   no "no columns" empty state). Communicated in the picker footer.
2. **Reordering is deferred to Phase 2.** The initial picker only chooses *which* columns display.
3. **The config UI lives on the Form Designer page**, not the Submissions toolbar. The Submissions
   page only reads the saved config and renders the filtered grid.
