# Dashboard Column Chooser, Frozen First Column & Editable Staff-Only Columns — Plan

> **Status:** **Implemented** (2026-09-15) — all of §3 and §4 are built; §6 records what was
> verified and how.
> **Date:** 2026-09-15
> **Audience:** Engineering
> **Relation to other docs:** supersedes the UI decisions in `docs/plans/submission-view.md`
> and resolves the empty-file item §9.8 in `docs/plans/feature-backlog.md`.
>
> **Four things changed during implementation, all recorded in place below:**
> 1. **A shipping data-layer bug was found by live-testing this feature.**
>    `updateSubmissionValues` used a T-SQL `IF EXISTS … ELSE …` upsert, which the libSQL
>    driver cannot parse, so **every staff-only save returned `500` under `DB_MODE=turso`**.
>    Fixed with `UPDATE` + `INSERT … SELECT … WHERE NOT EXISTS`; see §3.6 and
>    `docs/features/swagger-ui.md` §8.4. Typecheck, build and the test suite were all green
>    while it was broken.
> 2. **The frozen-column CSS needed a correction.** The first draft pinned every `<th>` with
>    `left: 0` rather than only `th:first-child`, which stacked the whole header row on the
>    frozen column as soon as the grid was scrolled sideways. See §3.5.
> 3. **The feature was extended to every role, which invalidated decision D1.** The initial
>    scope was the admin dashboard only. It was then reported that staff and School Contacts
>    had no COLUMNS control at all, and the user chose to roll the whole thing out to them.
>    That required **per-user** storage (the per-form store let one role silently overwrite
>    another's selection) and a shared grid (the staff page had its own table). **§9 is the
>    authoritative description of the shipped behaviour; the per-form wording in §2, §3.4,
>    §4 and D1 below is the pre-roll-out design and is deliberately left in place as a
>    record.
> 4. **The set of removable columns was then widened, so only the first column is fixed.** The
>    standard columns (Submission ID, Status, Submitted, Actions) were protected by §3.1, on the
>    grounds that an empty selection must never produce a blank grid. The user asked for
>    *"Except the first column, all columns should be removable. when you click on 'Columns'"*.
>    They are now ordinary chooser rows, and the store records what was **hidden** rather than
>    what was shown — which is what keeps every existing saved selection valid on upgrade. **§11
>    is the authoritative description of the shipped behaviour; §3.1's four-fixed-columns table
>    is the earlier design, deliberately left in place as a record.****


---

## 1. Problem

The admin Submissions dashboard (`client/src/pages/admin/AdminDashboard.tsx`) renders a
fixed five-column grid:

| Student / School | Submission ID | Status | Submitted | Actions |
| --- | --- | --- | --- | --- |

Every column is hard-coded. None of the data actually submitted on a form — neither the
parent's answers nor the staff-only fields — is visible on this page. To see any submitted
value an admin has to open a submission one at a time, or run an Export.

The four things we want:

1. **Column chooser** — let the user pick which form-field columns the grid shows.
2. **Frozen first column** — "Student / School" stays put while the grid scrolls right.
3. **Staff-only fields appended at the end and editable there** — so an admin can correct a
   staff-only value from the dashboard instead of opening each submission.
4. **The existing five columns remain** — Student/School, Submission ID, Status, Submitted,
   Actions are not part of the chooser and Actions stays last.
   *(+ **Reversed in §11**, which put everything but Student / School in the chooser. Actions
   still stays last.)*

### Goals

- One column chooser for the dashboard grid, offering the selected form's field columns.
- Staff-only columns pinned to the end of the grid (before Actions) and marked as staff.
- Click-to-edit on staff-only cells, saved through the existing staff-fields endpoint.
- The first column frozen on desktop.
- The choice is remembered per form. *(+ **per user** — see §9; the store moved from
  `forms.view_columns` to `user_form_view_columns`.)*

### Non-goals / constraints

- **Not** a rebuild of the column store. The backend for this already exists and is
  completely unused (§2.2). The bulk of the work is client-side.
- **No column reordering.** Deferred in `submission-view.md` decision 2 and still deferred
  here; the server already honours a caller-supplied order, so this stays a cheap Phase 2.
- **No inline editing of non-staff fields.** Only staff-only cells get an editor. Parent
  answers stay read-only (`updateSubmissionValues` would accept them, but they belong to the
  parent and `staff_only: true` would mislabel the audit trail).
- **No per-user views.** The chosen store is per-form and shared (§3.4). Per-user report
  views remain the separate concern described in `docs/plans/report-plan.md` (decision D7).
  > **Reversed by §9 (2026-09-16).** This constraint did not survive contact with the
  > all-roles roll-out: the store *is* now per-user, because a per-form row means whoever
  > saves last decides what everyone else sees. The line between "a grid column preference"
  > and "a report view" is still real (`report-plan.md` D7 stands), but the grid preference
  > is no longer shared.
- **Export is untouched.** The grid's column choice does not change the Export modal or the
  CSV. Export keeps its own selection.
- **Staff-only columns only make sense for one form.** A table has one header row, so a
  staff-only column is only meaningful when every row belongs to the same form. Under
  "All forms" the staff-only columns and the chooser are unavailable (confirmed decision).
  **Still true after the roll-out** — this is the one gate that applies to every role, and
  §9 keeps it, but makes the reason visible instead of relying on a hover tooltip.

---

## 2. Current behavior (research baseline)

### 2.1 The dashboard grid today

`AdminDashboard.tsx` (287 lines):

- `interface Filters { school_id; form_id; status; from; to }`, five `.filter-group`
  controls in a `.filter-bar`, then a `.filter-spacer` and a `button.clear`.
- Effect 1 loads `Promise.all([api.listForms(), api.listSchools()])` once.
- Effect 2 loads `api.listSubmissions({ school_id?, form_id?, status?, from?, to? })` keyed
  on the five filter values.
- `clearFilters` resets `school_id`, `status`, `from`, `to` — **but not `form_id`**.
- `PageHead` actions are "+ New Form" and "Export" (the latter opens `ExportModal`).
- `SubmissionsGrid` is a local function in the same file. It is **not** wrapped in
  `.grid-wrap`; it is a bare `<table className="grid" style={{ width: "100%",
  borderCollapse: "collapse" }}>` inside a `.card`, after a `.card-head`.

`api.listSubmissions` returns `SubmissionRow[]`, which is the source of all four base
columns: `student_name` and `school_name` (computed in the SQL of `listSubmissions`),
`public_id`, `status`, `submitted_at`. **It carries no form field values at all** — that is
the whole reason §2.3 matters.

### 2.2 What already exists and is not wired up

The column-selection store was built (and tested, and documented) but never consumed by any
UI. Verified end to end:

| Layer | Artifact | Location | Wired up? |
| --- | --- | --- | --- |
| DB (SQL Server) | `dbo.forms.view_columns NVARCHAR(MAX)` | `server/src/db/schema.ts:78`, migration `:436-437` | yes |
| DB (Turso) | `view_columns TEXT` | `server/src/db/dialect/turso.ts:101` | yes |
| Query | `ViewColumnsConfig { columns, viewKeys }` | `server/src/db/queries.ts:1546` | yes |
| Query | `getViewColumnsConfig(formId)` | `server/src/db/queries.ts:1555` | yes |
| Query | `setViewColumns(formId, viewKeys)` | `server/src/db/queries.ts:1606` | yes |
| Route | `GET /api/forms/:id/columns` | `server/src/routes/forms.ts:303` | yes |
| Route | `PUT /api/forms/:id/columns` (body `{ view_keys }`) | `server/src/routes/forms.ts:309` | yes |
| Inventory | both entries, role `admin` | `server/src/routes/inventory.ts:53-54` | yes |
| Swagger | `ViewColumnsConfig` schema + both paths | `server/src/swagger.ts:217`, `~936`, `~970` | yes |
| Client api | `getFormViewColumns(id)` | `client/src/lib/api.ts:499` | **never called** (now called by `useSubmissionGrid`) |
| Client api | `setFormViewColumns(id, viewKeys)` | `client/src/lib/api.ts:503` | **never called** (now called by `useSubmissionGrid`) |
| Client type | `ViewColumnsConfig` | `client/src/types/index.ts:268` | **unused** (now consumed — see §9) |
| Client UI | any consumer | — | **does not exist** (now `useSubmissionGrid` + `ColumnsDrawer`) |

> The three D1-era backend layers listed below were **re-pointed at a new per-user table**
> in §9. `getViewColumnsConfig` and `setViewColumns` kept their names and shapes but gained a
> `userId` argument; the routes, inventory entries and swagger paths are otherwise the same.

Semantics as implemented:

- `getViewColumnsConfig` reads the columns via `getExportColumns`, reads `view_columns`, and
  **returns every column key when the stored value is `NULL`, empty, or unparseable JSON**.
  Stored entries are normalised to `field_N` (a `number` → `field_N`, `"field_N"`, or a bare
  numeric string). Keys whose field no longer exists are dropped; if *every* entry was a
  ghost, it falls back to all columns.
- `setViewColumns` maps `field_N` → numeric ids and **collapses an empty array to `NULL`**,
  which reads back as "all columns".
- `getExportColumns(formId)` (`queries.ts:1519`) returns
  `{ key: "field_" + id, label, staff_only, roles }` ordered by `sort_order`, and **already
  partitions staff-only columns to the bottom** (a stable filter, not a sort, documented
  there as the rule that keeps picker, grid and file in one order). *This satisfies
  "staff-only fields at the end" with no new ordering logic.*

### 2.3 Where field values can come from

`GET /api/export/preview` (`server/src/routes/export.ts:31`) is the data source the grid
needs, and it needs **no changes**:

- It hard-codes `filterColumnsForRole(rawColumns, req.user!.role, true)`. The `true` makes
  every staff-only column visible to an admin, and the role branch ignores the flag for
  staff-like roles so they get exactly the staff-only columns their `roles` grant. One
  unparameterised request therefore returns every column the caller may see.
- `buildExportRows` always emits `submission_public_id`, `submitted_at` (formatted) and
  `status` in every row, plus `row[field_N] = value` for each requested column.
- It accepts `form_id` (required, 400 without it), `status`, `school_id`. It **ignores any
  `columns` parameter**. `api.exportPreview({ form_id, school_id?, status? })`
  (`client/src/lib/api.ts:649`) already matches exactly.
- **There is no row cap.** `listSubmissions` has none either, so the preview and the
  dashboard's own row list always cover the same submissions — the join is complete.
- Its `columns` array is mapped to `{ key, label, staff_only, type, options }` — **`roles` is
  still not returned** even though `ExportColumn.roles` is typed `string[] | null`. Don't
  depend on it. `type` and `options` were added in §9 precisely so a role that cannot call
  `GET /api/forms/:id` can still render and edit a cell (see §2.4).
- It does **not** accept `from`/`to`. A date filter therefore makes the preview a superset;
  harmless, because rows are joined on `public_id` and unmatched preview rows are discarded.

Because one request yields every column, **toggling columns afterwards is pure client-side
rendering with zero refetch** — the same trick `ReportsPage.tsx` already relies on.

### 2.4 Field metadata for the editors

Neither `getExportColumns` nor the preview response carries `type` or `options`, and an
inline editor cannot be rendered without them. `api.getForm(id)` (`api.ts:406`) returns
`FormWithFields` → `FormField[]` with `id, label, type, options, required, staff_only,
sort_order, placeholder, roles`, and `field_N` maps to `id: N`. One extra request, only when
a single form is selected.

> **Superseded by §9.** `GET /api/forms/:id` is **admin-only**, so this extra request would
> have returned `403` for a staff user or a School Contact — it is the reason §3.2's
> `Promise.all` was a latent bug rather than merely inelegant. The fix was to stop fetching
> field metadata separately at all: `/api/export/preview` now emits `type` and `options` on
> every column it returns, so the four-field `fieldMeta` map is built from
> `preview.columns` with no second call. Prefer this pattern for any future grid — the
> metadata travels with the column list, which is already role-filtered.

### 2.5 Reconciliation with `docs/plans/submission-view.md`

That plan (332 lines, drafted 2026-08-27) covered the column-selection half of this request.
Its status now:

| `submission-view.md` section | Status |
| --- | --- |
| §3.1 storage `forms.view_columns` + migration | **Shipped** |
| §3.2 canonical query + `getViewColumnsConfig` | **Shipped** |
| §3.3 the two endpoints | **Shipped** |
| §3.4 api methods | **Shipped** (but unused) |
| §3.5 dashboard grid reads view columns | **Stale** — it assumed the grid's rows came from `exportPreview`, and references a `SpreadsheetGrid` component that has never existed. The shipped grid is an inline function fed by `api.listSubmissions` + `SubmissionRow`, which has no field values. §3.2 of *this* plan replaces it. |
| §3.6 "View Columns" card on the Form Designer | **Never built** — `AdminFormDesigner.tsx` has no such card. **Superseded**: the user wants the chooser on the dashboard. |
| §3.7 CSS horizontal-scroll safety net | **Already exists** (`.grid-wrap { overflow-x: auto }`). |
| Decision 1 — empty selection shows all | **Kept**, with one refinement in §3.4. |
| Decision 2 — reordering deferred | **Kept.** |
| Decision 3 — config UI on the Form Designer | **Superseded** by this plan (chooser on the dashboard). |

Nothing in `submission-view.md` needs deleting; it should get a one-line pointer to this
document.

### 2.6 CSS baseline and its traps

- `.grid-wrap { border: 1px solid var(--border); border-radius: var(--radius); background:
  var(--card-bg); overflow-x: auto; }` (`global.css:402`).
- `table.grid thead th { … position: sticky; top: 0; white-space: nowrap; }`
  (`global.css:403-408`) — **the header is already sticky in the same scroll container the
  frozen column will live in**, so the two must cooperate on `z-index` (§3.5).
- `table.grid tbody td` has **no background**; row backgrounds come from
  `tr:hover { background: var(--panel-bg) }` and `tr.selected { background: var(--tint) }`
  (`global.css:411-416`). A sticky cell with a transparent background would let scrolled
  content show through, so each state needs an explicit background.
- There are only four `@media` blocks (lines 355, 697, 706, 1013) and **all are
  `max-width`** — there is no `min-width` block anywhere, so "freeze only on desktop" means
  adding one.
- Below 768px the table becomes a stack of cards: `thead` is hidden, each `tr` becomes a
  bordered card, and each cell's visible label comes from
  `td::before { content: attr(data-label) }` (`global.css:835`). **Every new cell must carry
  an accurate `data-label`.**
- The Submissions grid's own wrapper is `.grid-scroll` (§3.5), which is what
  `position: sticky` resolves against. `ReportsPage`, `AdminSettings` and
  `StaffDocuments` all use `.grid-wrap` and have no frozen column; the two wrappers must
  not be conflated. §10 adds a second scroll container beside `.grid-scroll`.

---

## 3. Proposed design

### 3.1 Column model

The grid becomes: **the pinned Student / School column + the standard columns (Submission ID,
Status, Submitted) + the form's field columns (staff-only last) + Actions last.**

| # | Column | Value source | Always shown | Editable |
| --- | --- | --- | --- | --- |
| 1 | Student / School | `SubmissionRow.student_name` + `school_name` | yes — frozen, and the only locked row | no |
| 2 | Submission ID | `SubmissionRow.public_id` via `shortId()` | chooser, default **checked** | no |
| 3 | Status | `SubmissionRow.status` → `StatusBadge` | chooser, default **checked** | no |
| 4 | Submitted | `SubmissionRow.submitted_at` → `formatDate()` | chooser, default **checked** | no |
| 5…n | form field columns | preview row `row[field_N]` | chooser, default **unchecked** | no |
| n+1…m | staff-only field columns | preview row `row[field_N]` | chooser, default **checked** | **yes** |
| last | Actions | — | chooser, default **checked** | no |

> Rows 2, 3, 4 and *last* were fixed until **§11** put them in the chooser, defaulting to
> shown. Only row 1 is locked.

Ordering falls out of `getExportColumns`, which already returns non-staff columns first and
staff-only columns last, each group in `sort_order`. No new ordering code, and the chooser,
the grid and the CSV stay in one order by construction.

An empty selection can never produce a blank grid. The *guarantee* held; what *carries* it
moved in **§11** — it is now Student / School alone that cannot be turned off, rather than the
four standard columns being kept out of the chooser altogether.

### 3.2 Data flow

When `filters.form_id` is empty ("All forms") nothing changes — the current single
`listSubmissions` call and the current five columns.

When a single form is selected, load three things together:

```ts
const formId = Number(filters.form_id);
const [rows, saved, preview] = await Promise.all([
  api.listSubmissions({ ... }),                     // base columns (existing call)
  api.getFormViewColumns(formId),                   // { columns, viewKeys, configured } — the dormant store
  api.exportPreview({ form_id: formId, status, school_id }), // every authorized column + values + type/options
]);
```

Then merge once:

```ts
// Keyed by public_id because buildExportRows always emits it, whatever was asked for.
const valuesByPublicId = new Map(
  (preview?.rows ?? []).map((r) => [String(r.submission_public_id), r])
);
```

and render each extra cell as `valuesByPublicId.get(row.public_id)?.[fieldKey]`.

Notes:

- The preview is **not** given a `columns` parameter — the route ignores it, and getting all
  columns up front is what makes toggling instant. It is also not given `include_staff_only`;
  `/api/export/preview` does not use that flag (unlike `/api/export/csv` and
  `/api/reports/*`, which both require an admin to pass it explicitly).
- `preview.columns` is the authoritative, already-role-filtered list of available columns and
  is what feeds the picker. `saved.viewKeys` is only used to seed the checked set.
- `form.fields` is joined by `field_N → id: N` to give each editor its `type` and `options`.
  **Removed in §9** — those two properties now ride on `preview.columns`, which is what lets
  a non-admin load the grid at all.
- A failure in the preview or field-metadata requests must not blank the grid: fall back to
  the base columns and log, exactly like today's `.catch(() => setSubmissions([]))` spirit but
  without losing the rows we did get.

### 3.3 The chooser

- A **"Columns"** button joins "+ New Form" and "Export" in the `PageHead` actions, with a
  lucide column icon. It is `disabled` under "All forms", with
  `title="Select a single form to choose columns"` — the same rule that gates the staff-only
  columns.
- **The reason is also printed beside the button** (`.head-hint`, rendered only while
  `!formId`). A disabled button explains nothing by itself and its `title` appears only on
  hover, so the gate read as a permissions problem in testing — an admin signed in, saw a
  greyed-out COLUMNS, and had no way to learn why without hovering. The hint removes that
  guesswork at the cost of one conditional span; it disappears the moment a form is picked.
- It opens a modal/drawer reusing `ExportModal`'s shell classes, containing the existing
  `ColumnsPicker` component:

  ```tsx
  <ColumnsPicker
    heading="Form columns"
    columns={preview.columns}
    checked={checked}
    onToggle={toggleColumn}
    onToggleAll={toggleAll}
  />
  ```

  > The shipped heading is **"Form fields"**, and the drawer carries the scope wording
  > "…remembered for this form, just for you" (§9). **§11** then dropped the heading and
  > widened the list to every column.

  `ColumnsPicker` is already purely presentational, already renders the `Staff` badge for
  `staff_only` columns, and is already shared by `ExportModal` and `ReportsPage`.
- A one-line note under the heading states why the first columns are missing from the list:
  *"Student / School, Submission ID, Status, Submitted and Actions are always shown."*
  (Optional polish: an additive `lockedKeys?: Set<string>` prop on `ColumnsPicker` to render
  them disabled instead. Deferred — it would touch two other callers for cosmetics.)
  > **Built in §11** under the name `locked`, and for a better reason than cosmetics: that
  > note became untrue the moment the standard columns could be turned off, and one locked row
  > is easier to explain than a list of five exclusions.
- Selection state mirrors `ReportsPage`: a `Set<string>`, a `toggleColumn(key)`, a
  `toggleAll()`, and `selectedKeys = preview.columns.filter(c => checked.has(c.key))` so
  render order always follows the server's canonical order.

### 3.4 Persistence

> **⚠️ Superseded by §9.** Everything in this section was built, shipped and verified — and
> then replaced when the feature was extended to staff and School Contacts. The store is now
> **`user_form_view_columns (user_id, form_id, view_columns)`** with a unique index on
> `(user_id, form_id)`, so two people with access to the same form keep independent
> selections. The `configured` flag, the `'[]'`-not-`NULL` rule and the "no write-on-read"
> behaviour all survive unchanged; only the key widened from `form_id` to
> `(user_id, form_id)`. Read §9 for the shipped design; the text below is the original
> per-form version, kept as the record of what was verified at the time.

Store: **`forms.view_columns`** (confirmed). Per form, shared between admins, no schema
change, reuses the shipped and tested query + routes.

- Seed `checked` from `api.getFormViewColumns(formId)` on form change, keeping an existing
  selection when its keys still exist (the `ReportsPage` effect pattern).
- Persist with **one `api.setFormViewColumns(formId, selectedKeys)` when the drawer closes**,
  not per toggle. No write-on-read: an unconfigured form stays unconfigured until the user
  actually changes something.
- **The default when the form has never been configured is: staff-only columns checked, form
  field columns unchecked.** That reproduces "add the Staff Only fields at the end" on first
  open and never explodes into a 20-column grid.

**One small backend change is required to make that default representable.** Today
`getViewColumnsConfig` returns *all* keys for both "never configured" (`NULL`) and
"configured to nothing" (a stored `[]`), because `setViewColumns` collapses `[]` to `NULL`.
The dashboard cannot then tell "the user wants nothing extra" from "nobody has chosen yet".
Minimal, contained fix:

| Change | Detail |
| --- | --- |
| `setViewColumns(formId, [])` | Persist `'[]'` instead of `NULL`. Non-empty selections are unchanged. |
| `getViewColumnsConfig` | A parsed, **empty** array now returns `viewKeys: []` instead of falling back to all keys. `NULL`/absent/unparseable still returns all keys, and a non-empty array that becomes empty after ghost-key removal still falls back to all keys — both existing safety rules preserved. |
| Response shape | Add `configured: boolean` (`false` only when `view_columns` is `NULL`/absent/unparseable). Non-breaking — additive. |

Then the dashboard rule is simply: `configured ? viewKeys : staffOnlyKeys`.

This is safe because **nothing consumes these endpoints today** (§2.2) and any form with
`view_columns = NULL` behaves exactly as before. It does change documented semantics, so
`ViewColumnsConfig` in `client/src/types/index.ts:268` and in `server/src/swagger.ts:217`
gain `configured`, and `docs/features/swagger-ui.md` is updated. No route is added, so
`server/src/routes/inventory.ts` and `swagger.test.ts` coverage are unaffected.

### 3.5 Frozen first column

Two CSS changes, both new, both scoped so nothing else moves.

**a. A scroll container that adds no chrome.** `.grid-wrap` cannot be reused inside the
card — it brings its own border, radius and background, which would double up on `.card`. Add
a chrome-free wrapper instead and use it in `SubmissionsGrid`:

```css
/* Dashboard grid: horizontal scrolling only. Deliberately not .grid-wrap, which
   also paints a border/radius/background that would stack inside .card. */
.grid-scroll { overflow-x: auto; }
```

**b. Pin the first column, desktop only.**

```css
@media (min-width: 769px) {
  /* `th:first-child`, NOT a bare `th` — see the correction note below. */
  .grid-scroll table.grid > thead > tr > th:first-child,
  .grid-scroll table.grid > tbody > tr > td:first-child {
    position: sticky; left: 0;
  }
  /* The header cells keep `top: 0` from the base rule. Explicit z-index on all
     three layers matters: `position: sticky` leaves the header cells painted at
     z-index auto, so a body cell with any z-index at all would scroll *over* the
     header. */
  .grid-scroll table.grid > thead > tr > th { z-index: 2; }
  /* The frozen corner also needs its own opaque background: the base
     `table.grid thead th` rule is `background: transparent`, so the columns
     scrolling underneath would read through its text. */
  .grid-scroll table.grid > thead > tr > th:first-child { z-index: 3; background: var(--card-bg); }
  .grid-scroll table.grid > tbody > tr > td:first-child { z-index: 1; }
  /* An opaque background is mandatory or the scrolled columns show through the
     frozen cell — and it must track the row state, since td has no background
     of its own. */
  .grid-scroll table.grid > tbody > tr > td:first-child { background: var(--card-bg); }
  .grid-scroll table.grid > tbody > tr:hover > td:first-child { background: var(--panel-bg); }
  .grid-scroll table.grid > tbody > tr.selected > td:first-child { background: var(--tint); }
  /* Hairline seam so the frozen column reads as pinned. */
  .grid-scroll table.grid > thead > tr > th:first-child,
  .grid-scroll table.grid > tbody > tr > td:first-child { box-shadow: 1px 0 0 var(--line-soft); }
}
```

> **Correction applied during implementation.** The first draft of this block wrote the
> selector above as `.grid-scroll table.grid > thead > tr > th,` — a bare `th`, with the
> comment "they now stick on both axes". That is wrong twice over. It pinned **every**
> header cell (not just the frozen corner) to `left: 0`, so scrolling the grid sideways
> stacked the whole header row on top of the frozen column; and it left the frozen corner
> transparent, so the columns sliding underneath showed through its text. Measured after
> the fix at `scrollLeft: 400`: the first `th` reports `left: 0px` and stays at offset `0`
> while `th[1]` reports `left: auto` at offset `-140` and `th[5]` at `356` — i.e. exactly
> one column pinned. A test that only checks the *first* cell's computed style cannot see
> this class of bug; the second cell's `left` value must be asserted too.

Specificity is fine: the selector above is `(0,3,4)` versus `table.grid thead th`'s
`(0,1,2)`, so `left: 0` applies and the base `top: 0` is inherited untouched.

Two practical consequences to handle while editing `SubmissionsGrid`:

- The first cell is already `whiteSpace: "nowrap"` inline. A frozen column that grows with a
  long school name would eat the viewport, so it gets `max-width: 260px` with ellipsis on the
  school name while the student name keeps priority.
- `@media (min-width: 769px)` is the **first** min-width block in the file; the existing
  `max-width: 768px` block at line 697 already turns the first cell into a stacked card row,
  where sticky positioning is meaningless and correctly not applied.

### 3.6 Inline editing of staff-only cells

**Affordance.** In-place editing (confirmed) — the whole staff-only cell is the click target,
with a small pencil icon that appears on hover as the hint, plus `title="Click to edit"`.
That keeps the "edit icon per row" intent without an extra click.

**State.** One editor at a time, at most:

```ts
const [editing, setEditing] = useState<{ publicId: string; fieldId: number } | null>(null);
const [draft, setDraft] = useState<AnswerValue | null>(null);
const [saving, setSaving] = useState(false);
const [error, setError] = useState<string | null>(null);
const [savedCells, setSavedCells] = useState<Set<string>>(new Set()); // brief "saved" flash
```

**Editor rendering.** Reuse the existing type→control mapping from
`StaffSubmissionDetail.tsx` rather than writing a second one (§3.7), so a value written from
the grid is byte-identical to one written from the detail page — including the deliberate
single-option-checkbox → `.toggle` switch used by staff-only "Generate document" fields.

| `FieldType` | Inline control |
| --- | --- |
| `text` (default) / `email` / `number` / `date` | `<input>` in place; `Enter` commits, `Escape` cancels, `blur` commits |
| `textarea` | `<textarea>` in place, `min-height`, `resize: vertical`; `Escape` cancels |
| `select` | `<select>` in place, `— Select —` empty option; commits on change and closes |
| `checkbox`, 1 option | `.toggle` switch in place; commits on change and closes |
| `checkbox`, n options | `radio` | **Portal-rendered option menu** anchored to the cell's `getBoundingClientRect()` |

The portal is not optional for the multi-option types. `.grid-scroll` has
`overflow-x: auto`, which makes it a clipping container (and computes `overflow-y` to `auto`
as well), so an absolutely-positioned popover inside a cell would be cut off by the scroll
edge. Rendering into `document.body` with `position: fixed` sidesteps it entirely. This is
the one genuinely tricky piece of the feature.

**Save path — this is the part that must not be improvised:**

```ts
await api.updateSubmissionValues(
  row.public_id,
  [{ field_id: fieldId, value: draft }],
  { staffOnly: true }   // required, not cosmetic
);
```

`PUT /api/submissions/:publicId/values` with `staff_only: true` is required for two
independent reasons:

1. It writes the staff audit trail (`staff_fields_updated_by` / `staff_fields_updated_at`),
   which is what makes the edit attributable. Note this is **one submission-level
   `(user, timestamp)` pair — there is no per-field timestamp**, so any staff edit stamps the
   whole submission. Accepted.
2. It is the only path that runs `maybeGenerateDocument` (`server/src/google/docs.ts:442`),
   which fires when the saved payload contains a truthy value for the staff-only `checkbox`
   labelled "Generate document". A bespoke per-cell `PATCH` would silently break document
   generation: the admin would tick the box in the grid and no Google Doc would ever be
   created. `generateDocument` is already idempotent (at most one active document per
   submission), so repeated toggles are safe.

Server-side this is already correct and needs no change: the route is
`requireRoles("staff","cdm_contact","admin")`, validates via `updateSubmissionValuesSchema`
(`answers.length >= 1`, `value` may be `string | number | boolean | string[] | null`),
404s on an unknown submission, and checks `canAccessSchool` — which always passes for an
admin (`isSchoolScoped` is `cdm_contact`-only, so `scopedSchoolId` returns `undefined`).
`updateSubmissionValues` is a per-field upsert that also bumps `submissions.updated_at`.

> **⚠️ "No backend change" was wrong — corrected during implementation.** The claim above
> held right up to the point of clicking a cell in a browser. `updateSubmissionValues` was
> written as a T-SQL conditional batch:
>
> ```sql
> IF EXISTS (SELECT 1 FROM dbo.submission_values WHERE submission_id = @submissionId AND field_id = @fieldId)
>   UPDATE dbo.submission_values SET value = @value WHERE …
> ELSE
>   INSERT INTO dbo.submission_values (submission_id, field_id, value) VALUES (…);
> ```
>
> The libSQL driver is a **token rewriter, not a SQL parser** — it handles `dbo.`, the
> `SYSUTCDATETIME()` conversion, `NVARCHAR(MAX)` and `N'…'`, and passes everything else to
> SQLite verbatim. It cannot parse `IF`, so **every** staff-only save raised
> `SQL_PARSE_ERROR … near IF` and returned `500` under `DB_MODE=turso`. This is a
> **pre-existing** bug on the shipped `PUT /api/submissions/:publicId/values` route, not
> something this feature introduced; the dashboard merely made it reachable in one click.
> Nothing caught it: `npm run typecheck`, `npm run build` and all 36 tests were green.
>
> The fix is `UPDATE` followed by `INSERT … SELECT … WHERE NOT EXISTS` — the same SQL on
> both dialects, and needing no schema change:
>
> ```ts
> await execute(`UPDATE dbo.submission_values SET value = @value
>                 WHERE submission_id = @submissionId AND field_id = @fieldId`, params);
> await execute(`INSERT INTO dbo.submission_values (submission_id, field_id, value)
>                SELECT @submissionId, @fieldId, @value
>                 WHERE NOT EXISTS (SELECT 1 FROM dbo.submission_values
>                                    WHERE submission_id = @submissionId AND field_id = @fieldId)`, params);
> ```
>
> **Rejected alternatives, for the record.** T-SQL `IF` in any spelling is unparseable.
> `INSERT … ON CONFLICT (submission_id, field_id) DO UPDATE` needs a UNIQUE constraint that
> *neither* dialect declares — `schema.ts` and `dialect/turso.ts` both create only two
> separate non-unique indexes — and adding one is a live SQL Server migration this code
> cannot verify. A generalised `dialect.upsertSetting()`-style helper would need that same
> index. A probe confirmed the data is clean (184 value rows, 184 distinct
> `(submission_id, field_id)` pairs, 0 duplicate groups, 0 null/orphan keys), so the index
> *could* be added later, but `INSERT … SELECT … WHERE NOT EXISTS` gets there today with no
> migration.
>
> **Regression guard:** `server/src/db/driver/libsql.test.ts` gained a fifth entry in its
> `TSQL_ONLY` list —
> `["IF EXISTS (…) conditional batch", /\bIF\s+EXISTS\s*\(/i]` — so an `IF EXISTS` cannot
> ship again. `IF NOT EXISTS` is deliberately *not* matched (the regex requires `IF` and
> `EXISTS` to be adjacent); it is legal SQLite DDL and is used throughout `dialect/turso.ts`,
> which that scan also covers. Hand-checked: the old statement matches, and
> `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` and the replacement code all
> do not.

**Commit/cancel semantics.**

- Success: write the new value into `valuesByPublicId` locally (no refetch — the PUT returns
  the full `SubmissionDetail`, which the grid does not need), clear `editing`, and add the
  cell to `savedCells` for ~1.2 s for a subtle confirmation tint.
- Failure: keep the editor open, show the error inside the cell, and leave the stored value
  untouched — no optimistic write that could be silently lost.
- Changing a filter, the form, or the picker selection while editing discards the draft
  (nothing is written); a `blur` commits first, which makes the destructive case rare.
- Two admins editing the same cell: last write wins, same as the detail page today.

### 3.7 Extracting the field editor

`Field` (`StaffSubmissionDetail.tsx:462`) and `renderEditor` (`:492`) are private to the
staff detail page, and `renderEditor` is exactly the type→control mapping the grid needs —
all eight `FieldType` branches, plus the single-option-checkbox → `.toggle` special case.

Extract them to a shared component (e.g. `client/src/components/FieldValue.tsx`) exporting:

- `FieldValue` / `FieldEditor` for the read/edit pair,
- the pure `renderEditor(type, options, value, onChange, radioName)` for callers that supply
  their own wrapper (the grid's compact cell does not want the `.field` / `.f-label` /
  `.f-value` block),
- and the small helpers they depend on: `toStr`, `isEmpty`, `formatValue`, `valuesToDraft`.

`StaffSubmissionDetail.tsx` then imports them instead of defining them. This is a pure
move — no behavior change — and it is what guarantees the grid and the detail page can never
disagree about how a value is serialised or displayed.

### 3.8 Mobile

Below 769px the grid is a stack of cards and labels come from `data-label`. So:

- Every new cell gets an accurate `data-label={column.label}`.
- No sticky behavior is applied (it is inside the `min-width: 769px` block).
- The portal option menu positions off `getBoundingClientRect()`, so it works in the card
  layout too — but the menu should be width-capped to the viewport.
- The staff-only cells must still be reachable and editable in the card layout; the card
  layout already gives each cell a full-width row (`td:not([data-label])`), so the editor
  should render in a cell that has a `data-label` and left-aligned contents rather than one
  that hides its label.

### 3.9 Interaction with Export

`ExportModal` and the CSV keep their own independent column selection and their own
`include_staff_only` semantics. The dashboard's saved `view_columns` is a *grid* preference;
`report-plan.md` decision D7 already establishes that Reports are independent, and the same
reasoning applies here. The only shared thing is the underlying `getExportColumns` order.

---

## 4. Files to change

### Backend

| File | Change |
| --- | --- |
| `server/src/db/queries.ts` | `getViewColumnsConfig`: return `viewKeys: []` for a stored empty array; add `configured: boolean`; keep the `NULL`/invalid → all-keys and ghost-key fallbacks. `setViewColumns`: persist `'[]'` rather than `NULL` for an empty selection. |
| `server/src/swagger.ts` | Add `configured` to the `ViewColumnsConfig` schema (`:217`) and describe the empty-vs-unset rule on the two `/api/forms/{id}/columns` paths. |
| `server/src/db/queries.ts` | **(found during implementation)** `updateSubmissionValues`: replace the T-SQL `IF EXISTS … ELSE …` upsert with `UPDATE` + `INSERT … SELECT … WHERE NOT EXISTS`. The original raised `SQL_PARSE_ERROR` on every staff-only save under Turso. See §3.6. |
| `server/src/db/driver/libsql.test.ts` | **(found during implementation)** Add `IF EXISTS (` to the `TSQL_ONLY` list so the construct cannot return. |
| `server/src/db/queries.ts` | **(§9)** `ExportColumn` gains `type` and `options`; `getExportColumns` selects them. `getViewColumnsConfig` / `setViewColumns` gain a `userId` argument and read/write `user_form_view_columns`. |
| `server/src/db/dialect/{types,sqlserver,turso}.ts` | **(§9)** `upsertUserFormViewColumns()` — `MERGE` on SQL Server, `INSERT … ON CONFLICT(user_id, form_id) DO UPDATE … RETURNING id` on Turso, plus the table DDL, the `UX_ufvc_user_form` unique index and a one-off backfill from `forms.view_columns`. |
| `server/src/db/schema.ts` | **(§9)** The `IF OBJECT_ID(…,'U') IS NULL CREATE TABLE dbo.user_form_view_columns …` batch, its unique index and the backfill, appended to the migration ladder. |
| `server/src/db/migrate-turso.ts` | **(§9)** `user_form_view_columns` added to `TABLES`. |
| `server/src/routes/forms.ts` | **(§9)** Both `/columns` routes change from `requireRoles("admin")` to `requireRoles("staff","cdm_contact","admin")` and pass `req.user!.id`. |
| `server/src/routes/export.ts` | **(§9)** `/preview` emits `type` and `options` per column and its guard becomes `requireRoles("staff","cdm_contact","admin")`. |
| `server/src/routes/inventory.ts`, `server/src/swagger.ts` | **(§9)** Both `/api/forms/{id}/columns` entries move from `admin` to `staff`; `ExportColumn` documents `type`/`options`; the column operations are re-labelled "(admin, staff, School Contact)". |

No new routes, so `server/src/routes/inventory.ts` and `server/src/swagger.test.ts` are
untouched. `routes/forms.ts`, `routes/export.ts`, `routes/submissions.ts` and
`export/table.ts` need **no** changes.

### Frontend

| File | Change |
| --- | --- |
| `client/src/types/index.ts` | `ViewColumnsConfig` gains `configured: boolean`. |
| `client/src/components/FieldValue.tsx` | **New** — `FieldValue` / `FieldEditor` / `renderEditor` / `toStr` / `isEmpty` / `formatValue` / `valuesToDraft`, moved out of `StaffSubmissionDetail.tsx`. |
| `client/src/pages/staff/StaffSubmissionDetail.tsx` | Delete the moved definitions; import them. Pure refactor. |
| `client/src/pages/admin/AdminDashboard.tsx` | The bulk. Add `checked` state + toggle handlers; the extra data loads and the `public_id` → values merge; `form fields` metadata for editor types; the "Columns" toolbar button (disabled under "All forms") and picker drawer; persist on drawer close; extend `SubmissionsGrid` to render the extra columns, wrap the table in `.grid-scroll`, and add the inline editor. |
| `client/src/lib/api.ts` | No change needed — `getFormViewColumns`, `setFormViewColumns`, `exportPreview`, `getForm` and `updateSubmissionValues(…, { staffOnly: true })` all already exist with the right shapes. |
| `client/src/types/index.ts` | **(§9)** `ExportColumn` gains `type: FieldType` and `options: string[] \| null`; the `ViewColumnsConfig` comment is re-worded to per-user/per-form. |
| `client/src/lib/useSubmissionGrid.ts` | **New (§9)** — the grid's load/merge/pick/edit behaviour, shared by both pages. `menuPosition()`, `useSubmissionGrid()`, and the exported `cellKey()` live here. |
| `client/src/components/ColumnsDrawer.tsx` | **New (§9)** — the "Select Columns" slide-out, extracted so the two pages cannot drift. Takes `scopeLabel` (`"this form"` / `"this report"`). |
| `client/src/components/SubmissionsGrid.tsx` | **(§9)** **Moved** out of `pages/admin/`, and made page-agnostic: `submissionPath(publicId)` and `emptyMessage?` replace the hard-coded `/admin` href and the admin-only empty text. |
| `client/src/pages/staff/StaffQueue.tsx` | **(§9)** The local `<table className="grid">`, the cards/view toggle, `StatusBadge`, `shortId` and `formatDate` are deleted; the page is rebuilt on `SubmissionsGrid` + `useSubmissionGrid` + `ColumnsDrawer`, and gains the same Columns button and `.head-hint` gate. |
| `client/src/pages/admin/AdminDashboard.tsx` | **(§9)** Reduced to filters + row loading: ~150 lines of local preview/fieldMeta/checked/editing state replaced by one `useSubmissionGrid({ formId, status, schoolId })` call. |

### CSS and docs

| File | Change |
| --- | --- |
| `client/src/styles/global.css` | Add `.grid-scroll`, the `@media (min-width: 769px)` frozen-column block, the cell editor's inline control styles, and a `.cell-saved` flash. |
| `docs/features/swagger-ui.md` | Document `configured` and the empty-selection rule. |
| `docs/plans/submission-view.md` | One-line pointer to this document (§2.5). |
| `docs/plans/feature-backlog.md` | Close §9.8 (this file is no longer empty) and note the superseded decision 3. |

---

## 5. Backward compatibility & edge cases

- **No form selected ("All forms").** Today's exact behavior: one `listSubmissions` call,
  five columns, chooser disabled. This is a hard requirement — staff-only columns are
  meaningless per-row across forms.
- **Form with no staff-only fields.** Picker lists only the parent field columns, all
  unchecked by default; the grid is today's five columns until the user picks one.
- **A field removed from the form after being selected.** `getViewColumnsConfig` drops
  ghost keys, so the stored config self-heals. The client should also intersect the seeded
  `checked` set with `preview.columns` so a stale key can never render an empty column.
- **Empty selection.** Impossible to produce a blank grid: Student / School is outside the
  chooser (née "four base columns and Actions are outside the chooser" — §11 replaced the
  protected set with a single locked row). Unchecking everything now yields a one-column grid
  rather than a reset to the standard five.
- **A submission whose preview row is missing.** Extra cells render `—`. Cannot normally
  happen given the matching row sets, but the merge is defensive by construction.
- **`from`/`to` filters.** The preview is not date-filtered, so it can contain rows the grid
  does not show. Harmless; the reverse (a grid row absent from the preview) is what would
  show blanks, and it cannot occur because the preview's filter set is a subset.
- **Read-only staff fields.** Admins are superusers and see every field
  (`fieldAccessRoles` / `filterColumnsForRole` admin branch), so all staff-only columns are
  editable by an admin — consistent with what the detail page already allows.
- **Audit granularity.** Editing any staff-only cell stamps the submission's single
  `(staff_fields_updated_by, staff_fields_updated_at)` pair. There is no per-field timestamp
  and none is being added.
- **Repeated document generation.** Ticking "Generate document" from the grid runs
  `maybeGenerateDocument`, which is idempotent (one active document per submission).
- **`clearFilters` does not reset `form_id`.** Pre-existing quirk, not introduced here. Worth
  fixing in this file while we are in it, since `form_id` now also drives column state —
  flagged as an open question rather than assumed.
- **Payload size.** The preview carries every column for every matching submission. Fine at
  current scale (22 submissions, ~14 columns). If a form grows large, the fix is a `columns=`
  parameter on `/api/export/preview` — a server change deliberately out of scope here.
- **Sticky header regression.** The z-index ladder in §3.5 is what keeps the frozen corner
  above the body cells and the body cells below the header. Without it, row 1 would paint
  over the header as you scroll.

---

## 6. Testing

1. `/admin` with "All forms": the grid shows exactly today's five columns, scrolling is
   unchanged, the Columns button is disabled with its tooltip, and no preview request fires.
2. Select one form with no staff-only fields → the picker lists only parent field columns,
   none checked, grid unchanged. Check two → both appear after Submitted, before Actions.
3. Select a form **with** staff-only fields → on first open the staff-only columns are
   already shown at the end, marked with the `Staff` badge in the picker, and the parent
   columns are not. This is the headline acceptance test.
4. Reload the page → the saved selection comes back (per-form, shared).
5. Uncheck everything and save → the grid falls back to the base columns and stays that way
   after a reload (this is the `configured` change in §3.4; without it, "nothing" would read
   back as "everything"). *§11 re-ran this with every standard column removable: the grid
   collapses to Student / School alone — still never blank, no error, and the top mirror from
   §10 hides cleanly.*

> Tests 4 and 5 were re-run **per user** after §9: two accounts with access to the same form
> keep independent selections, confirmed both in the browser and at
> `GET /api/forms/2/columns` for the admin, a staff user and a School Contact.
6. Scroll the grid right on a desktop viewport → the first column stays pinned, no content
   bleeds through it, its background matches the hover/selected tint, and the header stays
   above the rows while scrolling down.
7. Below 769px → cards with correct labels on every column, no sticky, staff cells still
   editable.
8. Inline edit each staff-only type: text, number, date, email, textarea, select,
   checkbox-1-option, checkbox-n, radio. Save, reload, confirm the new value persisted. Check
   the same submission on the detail page and confirm the value and the staff audit line
   match.
9. Tick the staff-only "Generate document" toggle **from the grid** → confirm a Google Doc is
   created for that submission (this is the regression that a bespoke endpoint would cause).
10. Force a save failure (stop the server, or edit a submission outside the admin's
    organization) → the editor stays open with an inline error and the stored value is
    unchanged.
11. Keyboard: `Enter` commits text-like editors, `Escape` cancels and restores, `Tab`/`blur`
    commits.
12. Picker: "Select all" / "Clear all", and the count matches the grid's column count.
13. Filter by School / Status / date range with staff columns on → values still line up with
    the correct rows.
14. `npm run typecheck` and `npm run build` from the repo root, and `npm test` in `server/`
    (swagger/inventory coverage must stay green).
15. Regression: `/reports` preview grid is visually unchanged, and the Export modal's columns
    are still independent of the dashboard's.

---

## 7. Rollout / deployment

1. Backend change first (§3.4) — additive and inert; no consumer is affected.
2. Shared `FieldValue` extraction as its own commit — pure move, verifiable by the detail
   page still working.
3. CSS (`.grid-scroll`, frozen block, editor styles), then the grid's extra columns, then the
   picker drawer, then inline editing. Each step is independently shippable: the grid with
   extra columns but no persistence is still useful, and the chooser with no staff columns is
   harmless.
4. No migration beyond the already-applied `view_columns` column. No env vars, no config, no
   seed data.
5. Existing forms read `view_columns = NULL`, so every form starts unconfigured and renders
   the new default — today's five columns plus the staff-only ones.

---

## 8. Decisions (confirmed 2026-09-15)

| # | Decision | Choice |
| --- | --- | --- |
| D1 | Where the column selection is stored | **`forms.view_columns`** — reuse the existing per-form store and its two routes. No new table, no schema change, no per-user state. **Reversed by §9:** the shipped store is `user_form_view_columns(user_id, form_id)`. The reason it had to change is the one this row dismissed — "no per-user state" means the last person to touch the picker decides what everyone else sees. |
| D2 | Staff-only columns under "All forms" | **Not available.** Staff-only columns and the column chooser are enabled only when exactly one form is selected, because a table has a single header row. |
| D3 | Editing staff-only values | **In place in the cell**, one editor at a time. `Enter`/`blur` commits, `Escape` cancels; `select` and `checkbox`/`radio` commit on change. A pencil appears on hover as the affordance. |
| D4 | Save path for an inline edit | **`PUT /api/submissions/:publicId/values` with `staff_only: true`** — never a per-cell endpoint, so the audit trail and `maybeGenerateDocument` both keep working. |
| D5 | Column model | Four fixed base columns + form field columns + staff-only columns (last, before Actions) + Actions. Actions remains the final column. Order comes from `getExportColumns`; no reordering UI. **§11 reverses "fixed": the three middle standard columns are chooser entries like any other, and only Student / School is locked.** |
| D6 | Frozen column | Column 1, "Student / School", desktop only (`min-width: 769px`), `position: sticky; left: 0` with an explicit per-state background and a z-index ladder that coexists with the existing sticky header. Scoped to `.grid-scroll`, so `ReportsPage` is unaffected. |
| D7 | Default selection for an unconfigured form | Staff-only columns checked, parent field columns unchecked — matching "add the Staff Only fields at the end" without exploding the grid. |
| D8 | Empty selection | Always falls back to the four base columns; the grid can never be blank. Requires the `configured` flag and `'[]'`-not-`NULL` change in §3.4 to be distinguishable from "never configured". **§11 keeps the guarantee and moves what carries it: Student / School is locked, so "uncheck everything" now means a one-column grid, not a reset to the standard five.** |
| D9 | Chooser UI | A "Columns" button in the dashboard toolbar opening a drawer containing the existing, unmodified `ColumnsPicker`. The same component the Export modal and Reports already use. **§9 keeps this** but extracts the surrounding drawer into `components/ColumnsDrawer.tsx` so the staff page shares it, and adds the `.head-hint` that explains the disabled state. `ColumnsPicker` itself is still untouched — the `lockedKeys` polish noted in §3.3 remains deferred. **§11 builds that polish as `locked` and uses it for the grid's first column.** |
| D10 | Prior plan | `submission-view.md` is largely shipped; its Form-Designer placement decision is superseded, and its dashboard section is stale. This document is the current source of truth. |
| D11 | **(§9)** Which roles get the chooser and the grid | **All three** — admin, `staff` and `cdm_contact`. The gate is the same for everyone and is about *form selection*, not role: staff-only columns only make sense when exactly one form is selected, because a table has one header row. |
| D12 | **(§9)** Ties and overwrites | **Last write wins, per user.** Nobody can read or overwrite anyone else's selection; the unique index on `(user_id, form_id)` makes that a database guarantee, not a UI convention. |

### Open questions for review

1. **Should parent (non-staff) field columns be offered at all in Phase 1?** This plan says
   yes — they are free (the preview already returns them) and they are what makes "select the
   columns they want to see" true. They default to unchecked. If the intent was strictly
   *staff-only* columns, Phase 1 shrinks to the staff-only subset and D7 becomes moot.
2. **Fix `clearFilters` not resetting `form_id`** while we are in this file? It now also
   clears the column state, so resetting it is more defensible than before.
3. **Column reordering** — still deferred (Phase 2), as in `submission-view.md`. Confirm.
4. **Should the picker's selection also seed the Export modal?** Default: no (D9 / §3.9).
5. **Per-editor UX for multi-option checkboxes** in a narrow cell: portal option menu (this
   plan) versus simply sending the admin to the detail page for those types.

---

## 9. Post-implementation change — the feature goes to every role (2026-09-16)

> **This section is authoritative.** Where it disagrees with §1–§8 above, §9 wins.

### 9.1 What was reported

> *"I do not see the COLUMNS for staff or school contacts. This feature should be for all."*

Three independent causes, only one of which was a bug:

| # | Cause | Nature |
| --- | --- | --- |
| 1 | `/staff` is a **different page** (`StaffQueue.tsx`) with its own hand-written table. It never had a Columns button, a chooser or staff-only columns. | Scope — the original feature was built into the admin page only. |
| 2 | `GET`/`PUT /api/forms/:id/columns` were `requireRoles("admin")`. A staff user would have received `403` even with the button. | Bug, given the new intent. |
| 3 | The store was `forms.view_columns` — **per form, shared**. Two roles picking different columns would have overwritten each other. | Design decision, made explicit and reversed by the user. |

Causes 2 and 3 were fixed on the server and proven live before any client work: the admin's
backfilled `field_11,field_9` read back intact while a staff user and a School Contact each
saw `configured=false` with the full 19-column list.

### 9.2 Storage — per user, per form

`user_form_view_columns(user_id, form_id, view_columns, updated_at)` with a **unique index on
`(user_id, form_id)`**. `forms.view_columns` is left in place, untouched, as the backfill
source: a one-off `INSERT … SELECT` seeds each form's designer (`forms.designer_id`) with the
legacy value, so the admin who built the feature keeps the selection they had.

| Dialect | Upsert |
| --- | --- |
| SQL Server | `MERGE dbo.user_form_view_columns USING (SELECT @userId, @formId, @value) …` |
| Turso | `INSERT INTO user_form_view_columns … ON CONFLICT(user_id, form_id) DO UPDATE SET … RETURNING id` |

Sibling dialect methods: `upsertUserFormViewColumns()`, declared on the `Dialect` interface.
`getViewColumnsConfig(formId, userId)` and `setViewColumns(formId, userId, viewKeys)` carry the
extra argument; `setViewColumns` no longer touches `dbo.forms.updated_at`, so a column
preference does not masquerade as a form edit.

> **Note for anyone re-probing this on Turso:** the libSQL driver is a token rewriter, not a
> parser (§3.6). `MERGE`, `SELECT TOP n`, `OUTPUT INSERTED`, `OFFSET … FETCH` and the
> two-statement `IF`-style upsert all need a hand-written Turso variant. The `TSQL_ONLY` scan
> in `server/src/db/driver/libsql.test.ts` enforces this; `IF NOT EXISTS` must stay legal
> (it is used for the DDL in `dialect/turso.ts`).

### 9.3 Metadata rides on the columns

`ExportColumn` gained **`type: FieldType`** and **`options: string[] | null`**, and
`/api/export/preview` emits them on every column it returns. This is what makes the grid
role-agnostic: `GET /api/forms/:id` is admin-only, so §2.4's extra `getForm` call would have
403'd for both new roles. The client now builds its four-field `fieldMeta` map from
`preview.columns` — no second request, and the metadata is already role-filtered.

`/api/export/preview`'s own guard became `requireRoles("staff","cdm_contact","admin")`.

### 9.4 The client refactor

The staff page could not simply be given a button, because it rendered a **different table**.
Three extractions, all behaviour-preserving, make one grid serve both pages:

| Piece | Role |
| --- | --- |
| `client/src/lib/useSubmissionGrid.ts` | Owns the load (`Promise.all([getFormViewColumns, exportPreview])`), the `public_id` → values merge, the checked-set seeding, the picker's dirty flag, and the whole inline-edit block. Exports `cellKey()` and `menuPosition()`. |
| `client/src/components/ColumnsDrawer.tsx` | The chooser shell. `scopeLabel` supplies the per-page wording ("this form" / "this report"). |
| `client/src/components/SubmissionsGrid.tsx` | **Moved** from `pages/admin/`. Made page-agnostic via `submissionPath(publicId)` and an optional `emptyMessage`; the hard-coded `/admin` href and `menuPosition` were removed. |

`AdminDashboard` shrank to filters + row loading plus one hook call; `StaffQueue` dropped its
local table, its cards/view toggle, `StatusBadge`, `shortId` and `formatDate` and was rebuilt
on the same three pieces.

Two behaviours worth recording:

- **The staff page's cards/view toggle was deleted, not ported.** `table.grid` already becomes
  a stack of cards below 769px via `td::before { content: attr(data-label) }`, and the shared
  grid emits `data-label` on every cell — so no mobile behaviour was lost. The toggle also
  could not host inline editing, which would have made it a second, poorer grid.
- **Preserved selection, deliberate writes only.** A reframe of the same form keeps the
  user's current selection; and `pickerDirtyRef` means opening the drawer and closing it
  without touching anything sends no `PUT`. Verified in the browser by watching the network:
  open → Done produced **zero** non-GET requests; tick one box → Done produced exactly one
  `PUT /api/forms/2/columns`.

### 9.5 The `.head-hint` gate, now on both pages

The Columns button stays `disabled` until a single form/report is chosen — the gate is
unchanged and still correct (a table has one header row). What changed is that the reason is
now **printed beside the button** as `.head-hint`: *"Select a single report to choose
columns"* on `/staff`, *"Select a single form to choose columns"* on `/admin`. This follows
the fix in §3.3 rather than repeating the mistake it documents.

### 9.6 Verified

Every row below was checked in a real browser against the running dev servers, plus
`npx tsc --noEmit` (server and client), `npx vitest run` (36/36) and `npm run build`
(1909 modules) — all green.

| Check | Actor | Result |
| --- | --- | --- |
| Columns button enabled once one form is chosen | School Contact (user 4), staff (user 3) | ✅ both |
| Hint shown while "All reports" is selected | staff | ✅ hint present, button disabled; both clear on selection |
| Staff-only columns render with `Staff` badge + edit affordance | both | ✅ (3 for the contact, 5 for staff — role-filtered) |
| Drawer seeds from the user's own saved selection | both | ✅ `3 of 16` for the contact, `5 of 18` for staff |
| Wording is per-user | both | ✅ "…remembered for this report, **just for you**" |
| Done persists; selection survives a full reload | staff | ✅ `PUT` fired, columns unchanged after reload |
| Toggle "Select all" / off / partial | staff | ✅ `18 of 18` → `0 of 18` → `5 of 18` |
| Open + Done with no change writes nothing | admin | ✅ zero non-GET requests |
| Inline edit saves | staff | ✅ `PUT /api/submissions/CDM2-00014/values` with `staff_only: true` |
| `Escape` cancels without saving | staff | ✅ cell reverted, no request |
| Per-user isolation | all three | ✅ user 1 `field_9,field_11` · user 3 `field_9,field_16,field_30,field_31,field_35,field_37` · user 4 `field_12,field_16,field_30,field_37` — three distinct rows, no cross-talk |
| Admin grid unchanged by the refactor | admin | ✅ same columns, same frozen first column, same drawer |

### 9.7 Things this section did **not** change

- `ColumnsPicker`, `ExportModal` and `ReportsPage` — untouched; the Export modal's columns are
  still independent of the grid's (§3.9). *(`ColumnsPicker` did change in §11 — one optional
  `locked` flag on a row — but the Export modal and Reports pass no locked rows, so neither
  behaviour moved.)*
- The four fixed base columns, the frozen first column, the z-index ladder and the mobile card
  layout (§3.1, §3.5, §3.8). *("Fixed" is undone by §11 for all but the first column.)*
- `lockedKeys` is still deferred. *(Built in §11 as `locked`.)*
- `clearFilters` still does not reset `form_id` (§8 open question 2).

---

## 10. Post-implementation change — the grid's scrollbar, mirrored at the top (2026-09-16)

**Asked for as:** *"Can the same scrollbar at the bottom of the grid be added to the top?"*

A grid wider than its container has its **one** horizontal scrollbar at the *bottom* of the
table, so reaching it costs a scroll past every row. `.grid-scroll-top` is now a second,
empty scroll container directly above `.grid-scroll`, holding a single spacer that
`useGridScrollMirror` (`SubmissionsGrid.tsx`) sizes to the grid's scroll width.

**Why a mirror rather than a CSS trick.** A native scrollbar cannot be duplicated with CSS.
Two scroll containers share a range when their **client** widths match (both simply fill the
card) and their **content** widths match (the spacer is set to the grid's `scrollWidth`).

| Piece | Detail |
| --- | --- |
| Placement | A **sibling** of `.grid-scroll`, never a parent — so the sticky header and the frozen first column still resolve against the grid's own scroll container (§3.5). |
| Sync | Two `scroll` listeners, each assigning `scrollLeft` **only when it differs**. Assigning the value a box already holds is a no-op that fires no event, so the pair cannot bounce off each other and no lock flag is needed. |
| Re-measure | A `ResizeObserver` on the grid **and on the table**. The wrapper alone is not enough: adding a column to an already-overflowing grid changes the table's box, not the container's. |
| Range | Equal to the pixel — both sides max out at `775.2` for a 1700px table in a 925px container. |
| Height | Read off the grid as `offsetHeight − clientHeight`, never hard-coded, so a platform with overlay scrollbars collapses the strip to nothing rather than reserving a blank band. Measured here: **15px**. |
| When hidden | An overflow of ≤ 1px leaves the `-active` class off (`display: none`) — a narrow grid gains no dead strip. Mobile carries a hard `display: none !important` too, since the rows become cards and there is nothing left to scroll (§3.8). |

**The trap that cost a round trip — the spacer must be `1px` tall, not `0`.** At `height: 0`
the spacer still lays out at its full width (measured 1700px) but is a *degenerate,
zero-area* descendant, which the engine does not count as scrollable overflow. The container
then reports `scrollWidth === clientWidth` (925), reserves the strip, and cannot be scrolled
at all — a bar that looks present and does nothing; both sync directions returned `0`. At
`height: 1px` the same container reports `scrollWidth` 1700 against a client width of 925 and
scrolls normally. None of this is visible without reading `scrollWidth` and driving
`scrollLeft`, which is why it is written down.

**Not changed:** the `ReportsPage`, `AdminSettings` and `StaffDocuments` grids use
`.grid-wrap` (§2.6) and are untouched — each still has its only horizontal scrollbar at the
bottom. Extending this means applying the same mirror to `.grid-wrap`.

---

## 11. Post-implementation change — every column but the first can be removed (2026-09-16)

**Asked for as:** *"Except the first column, all columns should be removable. when you click on
'Columns'"*

Until now the grid had a protected core: Student / School, Submission ID, Status, Submitted and
Actions were fixed, and the drawer listed form fields only. §3.1 gave the reason — "an empty
selection can never produce a blank grid". The ask reverses it. What survives is the narrower,
more defensible version of the same guarantee: **the grid can never be blank because Student /
School can never be turned off.**

**Why Student / School is the exception**, stated as three reasons rather than one badge. It
names the row — every other cell is a value *of* that row. It is the link to the submission,
which matters more now that Actions can be hidden, since the student's name opens the same page.
And it is the frozen column on desktop (§3.5), so removing it would leave nothing to freeze and
a sticky-offset ladder pointing at an empty cell.

The row is **listed, not omitted**. A row that is missing reads as an oversight; a checked,
disabled row badged **Always shown** reads as a decision. `ColumnsPicker` gained one optional
`locked` flag for this. Locked rows are excluded from the "Select all" tally — otherwise the box
would stay ticked after every removable column was off, and clicking it would look like it had
done nothing.

**Where the state lives.** One set, `checked`, in `useSubmissionGrid`, now covering standard
columns and field columns alike; `hiddenBase` is *derived* from it as the negation over
`GRID_BASE_COLUMNS`, so the two can never disagree. The pinned key is deliberately absent from
`GRID_BASE_COLUMNS`, which is what makes it impossible to hide.

### 11.1 Files touched

| File | Change |
| --- | --- |
| `server/src/db/queries.ts` | `ViewColumnsConfig` gains `hiddenBase`; `getViewColumnsConfig` parses `{fields, hidden}` **and** a bare array; `setViewColumns` takes `hiddenBase` and writes the new shape. |
| `server/src/routes/forms.ts` | `PUT /api/forms/:id/columns` accepts and shape-validates `hidden_base` (optional, defaults to `[]`). |
| `server/src/swagger.ts` | `hiddenBase` on `ViewColumnsConfig`; `hidden_base` on the PUT request body. |
| `client/src/components/SubmissionsGrid.tsx` | Exports `GRID_BASE_COLUMNS` / `GRID_PINNED_COLUMN`; new `hiddenBase?: Set<string>` prop; each standard `<th>`/`<td>` pair is guarded. |
| `client/src/components/ColumnsPicker.tsx` | Exported `PickerColumn` type; new `locked` flag; locked rows render checked + disabled + badged and are excluded from "Select all". |
| `client/src/components/ColumnsDrawer.tsx` | Takes `PickerColumn[]` instead of `ExportColumn[]`, lists every column, and rewrites the two notes that asserted the old always-shown rule. |
| `client/src/lib/useSubmissionGrid.ts` | One `checked` set covering every column; derives `hiddenBase` and `pickerColumns`; the pinned key refuses to toggle and is re-added by `toggleAll`. |
| `client/src/pages/admin/AdminDashboard.tsx`, `client/src/pages/staff/StaffQueue.tsx` | Pass `hiddenBase` to the grid and `pickerColumns` to the drawer. Both dropped the now-unused `availableColumns` from their destructure. |
| `client/src/types/index.ts`, `client/src/lib/api.ts` | `hiddenBase` on `ViewColumnsConfig`; third argument on `setFormViewColumns`. |
| `client/src/styles/global.css` | `.cp-item.locked`. |
| `docs/plans/{css-style,submission-view,report-plan,feature-backlog}.md`, `docs/features/swagger-ui.md` | The claims this change falsified — see §11.4. |

### 11.2 Storage: the hidden set, not the shown set

`user_form_view_columns.columns` now holds **`{"fields":[12,16,…],"hidden":["base_status",…]}`**
instead of a bare array of field ids. Every part of that is deliberate:

| Choice | Why |
| --- | --- |
| Store **what is hidden**, not what is shown | Absence then means *shown*. A row written before this change is a bare array, which parses as "nothing hidden" — so nothing any existing user had chosen disappears, with no migration and no version marker. |
| A base column added later defaults to **on** | The same polarity. A new standard column is in nobody's `hidden` list, so it appears rather than silently vanishing for every existing user. Storing the shown set would have needed a version marker to tell "hid it" from "did not exist yet". |
| Accept **both shapes** on read | `getViewColumnsConfig` parses an array *or* `{fields, hidden}` and never rewrites. Old and new rows coexist indefinitely; because the write path is already the new shape, each row migrates itself the first time that user closes the drawer. |

### 11.3 The server stores keys it does not understand

`base_*` keys are shape-checked (`/^base_[a-z0-9_]+$/`) and otherwise **opaque** to the server.
The standard columns are a client rendering concern — they come from `/api/submissions`, not from
the export preview — so the server has no list to validate against, and a second allow-list here
would be a copy free to drift from the grid. An unknown `base_*` key is stored and then ignored
by the client: harmless, and strictly better than a 400. This is the opposite of `field_N`, which
the server *does* own and *does* validate against the form's real fields.

The two arrays also carry **opposite polarity** — a field key means "show", a base key means
"hide" — which the route comment spells out, because it is exactly the kind of thing the next
person to touch it reverses.

### 11.4 Verified (School Contact, `/staff`, form 2, live dev servers)

`npx tsc --noEmit` (server and client), `npx vitest run` (36/36) and `npm run build`
(1909 modules) — all green.

| Check | Result |
| --- | --- |
| Drawer lists every column: 1 locked + 4 standard + 16 fields | ✅ pinned row `checked`, `disabled`, badged "Always shown"; `Staff` badges still on the staff-only fields |
| Untick Status / Submitted / Actions | ✅ live grid 9 → 6 columns, cells in step, footer `6 of 21` |
| Untick the locked row | ✅ ignored — the input is `disabled`, `toggleColumn` returns early, and `hiddenBase` only ever covers `GRID_BASE_COLUMNS` |
| "Select all" round trip | ✅ `21 of 21` → `1 of 21` (Student / School alone, with the extreme-state note) → `21 of 21`; the box never reads ticked while a removable column is off |
| `hiddenBase` round trip through the API | ✅ `PUT /api/forms/2/columns` → 200, `"hiddenBase":["base_status","base_submitted","base_actions"]` |
| Survives a full reload | ✅ 18 columns, the same three still unticked, pinned row still locked |
| "All reports" (no form chosen) | ✅ all five standard columns shown — an empty `checked` here would have read as "hide everything" |
| One-column grid doesn't break the top mirror (§10) | ✅ no error, no dead strip |

The reviewer's saved selection was restored afterwards — an earlier pass through this table had
overwritten it, and the exact original (`field_12,field_16,field_30,field_37`, nothing hidden)
was written back. Per-user isolation is unchanged from §9.2: the new keys ride in the same
`user_form_view_columns(user_id, form_id)` row.

**Claims corrected elsewhere.** Four documents asserted the old rule and were edited rather
than left to contradict the code: `submission-view.md` §8.1 ("the grid falls back to the four
base columns plus Actions" — now Student / School alone), `report-plan.md` §5 (its Reports-page
"empty = all" was described as mirroring the grid's rule, which is no longer the grid's rule),
`feature-backlog.md` §9.10 (new row), and `css-style.md`'s class inventory (which had no
column-picker entry at all — `.cp-item.locked` forced the gap to be filled).
