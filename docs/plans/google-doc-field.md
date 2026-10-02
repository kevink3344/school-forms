# Google Document field type — Implementation Plan

**Status:** ✅ **Implemented + verified 2026-10-02** (19 gate tests, 20 behavioural checks, live-DB
end-to-end). Not yet committed.
**Date:** 2026-10-02
**Area:** Form Designer (`/admin/forms/:id`) · Submissions grid · Submission detail · Reports / export
**Related:** `docs/plans/google-doc.md` (generated documents — a *different* feature), `docs/plans/google-form-url.md`

> **Deploying?** Read §11 first. Short version: the schema change is two idempotent CHECK-widening
> batches that run at boot, so **no manual migration is needed** — but verify them (§11.2).

---

## 1. What was asked

> *"I need a plan for a new field type, that of Google Document. When a form is submitted, the
> Google Form only sends the document ID. When this is of type Google Document, I want to wrap each
> ID in the url: `https://docs.google.com/document/d/[document-id]/view`. This way it becomes a link
> the person can click on. Staff will manage permissions so users have access to the location where
> the documents are stored."*

Concretely:

1. A **new field type** — `google_doc` — selectable in the Form Designer, alongside Text / Number /
   Date / Email / Select / Radio / Checkbox.
2. The Apps Script webhook sends the **bare document ID** (e.g. `1qcUzzb0Ej9eIO4UkkSKYCn36f_de3ZTj`),
   not a URL.
3. Wherever that answer is **displayed**, it renders as a **clickable link** to
   `https://drive.google.com/file/d/<id>/view` — **corrected 2026-10-02, see §12**.
4. **Access is not this app's problem.** Staff grant Drive permissions on the folder/file; the app
   only builds the link.

### 1.1 The screenshot that prompted this

A submission detail page showed the raw stored value:

```
Upload the Governor's School Application    ["1qcUzzb0Ej9eIO4UkkSKYCn36f_de3ZTj"]
```

Two defects are visible in that one cell, and they are **independent**:

- **(a) The link is not a link.** The value renders as text.
- **(b) The brackets and quotes are leaking.** The value is a **JSON-encoded array** being printed
  with `Array.prototype.join` semantics that never ran, because the field type is not recognised as
  a collection.

Defect (b) is the more interesting one and is explained in §2.2 — it is **not** caused by this
feature and would need fixing regardless of whether the field type is added.

---

## 2. Current state (measured, not assumed)

### 2.1 The type list is written out in NINE places

| # | File | What lives there | Derived? |
|---|---|---|---|
| 1 | `server/src/db/schema.ts` L33 | `FIELD_TYPES` tuple — the **source of truth** | — |
| 2 | `server/src/db/schema.ts` **L1074** | `CHECK (type IN (…))` on `dbo.form_fields` | ❌ hand-written |
| 3 | `server/src/db/schema.ts` **L1201** | `CHECK (type IN (…))` on `dbo.submission_adhoc_fields` | ❌ hand-written |
| 4 | `server/src/schemas.ts` L235 | `const fieldTypeEnum = z.enum(FIELD_TYPES)` | ✅ derived |
| 5 | `client/src/types/index.ts` L24 | `FieldType` union — the client's copy | ❌ hand-written |
| 6 | `client/src/pages/admin/AdminFormDesigner.tsx` L10 | `FIELD_TYPES` — the designer's `<select>` | ❌ hand-written |
| 7 | `server/src/swagger.ts` L127 | `enum: ["text", …]` | ❌ hand-written |
| 8 | `server/src/swagger.ts` L238, L329, L1887, L1923 | four more copies of the same literal | ❌ hand-written |

Plus the **renderers** that switch on the type:

| # | File | Role |
|---|---|---|
| 9 | `client/src/components/FieldValue.tsx` `renderEditor()` | the type → **edit control** mapping |
| 10 | `client/src/components/FieldValue.tsx` `formatValue()` | the type → **display string** mapping |

**★ Only ONE of the eight declaration sites is derived.** Everything else is a hand-copy of
`FIELD_TYPES` — the "hand-kept copy of a machine-maintained set" defect family this repo has hit
repeatedly (see `docs/plans/staff-only-field-access-toggles.md`). Adding to `FIELD_TYPES` alone:
leaves the designer without the option, the client union without the member, the API docs describing
a type that cannot be chosen, **and the database refusing the value outright** (rows 2 and 3 — see
§5.1). **Nothing fails at build time**; the type simply cannot be selected, and if it somehow were,
the INSERT 500s.

This plan adds gates G1 and G6 (§8) to diff the copies against the source.

### 2.2 Why the value renders as `["…"]` — the collection-detection bug

`server/src/db/queries.ts` stores answer values as text. On write (`createSubmission`,
`updateSubmissionValues`):

```ts
typeof a.value === "string" ? a.value :
typeof a.value === "number" ? String(a.value) :
typeof a.value === "boolean" ? (a.value ? "1" : "0") :
JSON.stringify(a.value),          // ← arrays land here
```

On read, `parseSubmissionValue(value, fieldType)` decides whether to `JSON.parse`:

```ts
const isCollection = fieldType === "checkbox" || fieldType === "multiselect";
if (!isCollection || typeof value !== "string") return value;
```

**★ The `fieldType` argument decides whether the stored JSON is decoded.** For any type not in that
two-item list (including the new `google_doc`), the raw string `'["1qcUzz…"]'` is returned verbatim
and rendered literally — brackets, quotes and all.

So the value in the screenshot proves **the webhook sent an array**, and the app **stored it as
JSON**, and the read path **declined to decode it** because the type is not `checkbox`.

**This is the key design decision of the plan** (§4.1): the new type must be added to the
collection-detection rule, or it will keep rendering brackets.

> **Note for the reader:** the screenshot's field is currently typed as something else (text or
> textarea) — the brackets appear *today*. Fixing the type to `google_doc` **and** extending
> `isCollection` fixes both halves at once. If the field is left as text, the brackets stay.

### 2.3 What the webhook actually sends

`server/src/schemas.ts` `submissionAnswerSchema` accepts `value` as
`string | number | boolean | string[] | null`. The Apps Script (`docs/plans/google-script.md`) sends
whatever the Google Form question's answer is. A Google Forms **file-upload** question returns an
**array of Drive file IDs** — hence the array in the screenshot. So:

- The stored value is legitimately `string[]` — **one or many** documents.
- A Google Forms **short-answer** question could equally carry a single ID as a plain string.

**★ The renderer must handle both shapes** — `string[]` and a bare `string`. Do not assume an array.

### 2.4 Where a value is displayed

| Surface | Renderer | Notes |
|---|---|---|
| Submission detail (staff/admin) | `FieldValue.tsx` → `formatValue()` | `<span className="f-value">` |
| Admin Submissions grid | `SubmissionsGrid.tsx` L471 / L560 → `displayValue()` | delegates to `formatValue()` |
| Reports preview grid | `ReportsPage.tsx` | renders `formatValue`-equivalent cell text |
| Exports (CSV / XLSX / PDF) | `server/src/export/table.ts` `buildExportRows` | **server-side**, plain text |
| Parent confirmation | `ParentConfirmation.tsx` | `f-value` spans |

**★ The export path is server-side and cannot render a link.** A CSV cell has no hyperlink concept
(XLSX *can* carry one, but the current writer does not). This plan **exports the URL as text** — see
§4.4 — so a spreadsheet reader can still click it, and so the export stays WYSIWYG with the grid.

---

## 3. Design decisions

### 3.1 The type key: `google_doc`

Stored in `form_fields.type` as the literal `"google_doc"`.

**Why not `url` or `link`?** A generic URL type would imply the app can link *any* URL, which would
then raise "should we validate the scheme?" and "what about javascript: URLs?" — a security surface
this feature does not need. `google_doc` is narrow, and the app **constructs** the URL rather than
trusting the stored value, which removes the injection question entirely (§4.2).

### 3.2 The app builds the URL — it never stores one

The stored value is the **file ID**. The URL is derived at render time:

```
https://drive.google.com/file/d/<id>/view
```

**Why this matters:** the stored value stays the raw ID the webhook sent, so a future change to the
URL shape (a different host, an added query param) is a one-line renderer change with no data
migration. It also means a value that is *already* a URL is handled explicitly rather than
double-wrapped (§4.3). **This was proved out in practice — the host changed once already (§12).**

### 3.3 Rendering is display-only — the stored value is unchanged

Adding the type does **not** rewrite any stored value. `formatValue` gains a branch that *renders*
the link; the database keeps `'["1qcUzz…"]'` exactly as it is. This keeps the change additive and
reversible.

### 3.4 No permission handling, by explicit decision

The user's words: *"Staff will manage permissions so users have access to the location where the
documents are stored."* So:

- **No Drive API call.** The app never checks whether the viewer can open the document.
- **No `documents` table row.** This is not the generated-document feature (`docs/plans/google-doc.md`);
  nothing is created, tracked or retried.
- **The link may 403 for some viewers.** That is expected and is the staff's responsibility. The
  UI should not imply otherwise — see §7.3's wording.

---

## 4. Design detail

### 4.1 ★ The collection rule must accept the new type

`parseSubmissionValue` (`server/src/db/queries.ts` ~L1138) is the single place that decides whether a
stored string is JSON. It must become:

```ts
// Field types whose stored value is a JSON-encoded ARRAY. `google_doc` belongs here
// because a Google Forms file-upload question answers with an ARRAY of Drive file
// ids, and the write path JSON.stringify's any array. Without this the raw text
// '["1qcUzz…"]' is served to every renderer and printed with its brackets — which is
// exactly what the submission detail page showed.
const COLLECTION_FIELD_TYPES = new Set(["checkbox", "multiselect", "google_doc"]);

function parseSubmissionValue(value, fieldType) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(String);
  if (!COLLECTION_FIELD_TYPES.has(fieldType) || typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : value;
  } catch {
    return value;   // not JSON — surface the raw string rather than dropping it
  }
}
```

**★ Extracting the set is deliberate.** The old inline `fieldType === "checkbox" ||
fieldType === "multiselect"` is a hand-copy of a rule that now has three members; a named `Set`
gives the next reader one place to look and gives the test in §8 something to import.

**★ `parseSubmissionValue` is called from two places** — `listSubmissionValues` (single) and
`listSubmissionValuesBatch` (bulk, used by exports). Both pass `ff.type AS field_type` from the same
join, so **one change covers both**. Verify by grep before editing (test G2).

**★ A non-array JSON string must survive.** A short-answer question sends a bare string like
`"1qcUzz…"`, which is **not** valid JSON — `JSON.parse` throws and the `catch` returns the raw
string. That is correct: the renderer then treats it as a single ID. The `Array.isArray(parsed)`
guard covers the third case, a JSON string that parses to a non-array (e.g. a stored `"42"`).

### 4.2 URL construction — one shared helper, on the client

New file `client/src/lib/googleDoc.ts`:

```ts
/** The Docs viewer URL for a Drive document id. */
export function googleDocUrl(id: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
}

/**
 * The document ids carried by a google_doc answer, in order.
 *
 * Handles BOTH shapes the webhook can produce: an array (a Google Forms
 * file-upload question) and a bare string (a short-answer question). Blank
 * entries are dropped so a trailing empty answer does not render a dead link.
 */
export function googleDocIds(value: unknown): string[] { … }

/** True when a value is already an absolute http(s) URL. */
export function isAbsoluteUrl(v: string): boolean { … }
```

**★ `encodeURIComponent` on the id.** A Drive id is URL-safe in practice, but encoding costs nothing
and means a malformed value cannot break out of the path segment. This is the whole reason the app
builds the URL instead of interpolating into JSX.

**★ Why client-side and not shared with the server?** The server's export path needs the *same* URL
(§4.4) but cannot import from `client/`. Two options were considered:

- **(A) Duplicate the one-line template in `server/src/export/table.ts`.** Rejected-ish: two copies
  of a URL shape drift.
- **(B) Put the constant in `server/src/db/schema.ts` and have the client hard-code it too.**
  Rejected: the client cannot import server code.

**Decision: (C) — the URL template is a one-line constant in each of the two places that need it,
and a test asserts they are byte-identical** (§8, test G3). This is the same technique the repo
already uses for `MENU_ITEM_KEYS` ↔ `MENU_ITEMS` and for the two dialects' index-name lists: a
hand-copy is acceptable **only** when a gate diffs it.

### 4.3 A value that is already a URL

If a form's Apps Script is later changed to send a full URL, or an admin types one into the field
manually, the renderer must not produce
`https://drive.google.com/file/d/https://drive.google.com/…/view`.

Rule: **if the value already looks like an absolute `http(s)` URL, link it as-is.** Otherwise treat
it as an id and wrap it. This is `isAbsoluteUrl()` in §4.2.

**★ Guard against the obvious over-reach:** do **not** render arbitrary `javascript:` or `data:`
URLs. `isAbsoluteUrl` must match **only** `https?://` — a `startsWith("http://") ||
startsWith("https://")` test, not "contains a colon". This is the one place a link renderer can
become an XSS vector, so the allowlist is explicit and the test in §8 (G4) asserts a
`javascript:` value is **not** linked.

### 4.4 Display vs export

| Context | Rendering |
|---|---|
| Submission detail | `<a href={url} target="_blank" rel="noopener noreferrer">` |
| Admin grid cell | an `<a>` inside the cell (see §4.5) |
| Reports preview | an `<a>` (same helper) |
| CSV / XLSX / PDF export | the **URL as plain text** |

**★ `rel="noopener noreferrer"` is not optional.** Without `noopener` the opened document gets a
`window.opener` handle back into the app; without `noreferrer` the app's URL leaks in the Referer.
Every existing external link in this app already does this (`StaffDocuments.tsx` uses
`ExternalLink` + `target="_blank"`), so this is consistency, not a new convention.

**★ For a multi-document answer, the display shows a numbered list of links; the export joins the
URLs with a space.** A CSV cell holding several URLs separated by spaces is the honest
representation — a spreadsheet auto-links the first one and the rest stay readable text. Do **not**
join with a comma: a comma is the CSV delimiter and would need quoting, and a comma-joined list of
URLs reads as one URL.

### 4.5 The grid cell — a link inside a clickable row

`SubmissionsGrid.tsx` renders each cell through `displayValue(value, type)`, which returns a
**string**. A string cannot be a link.

**★ This is the subtle part of the change.** The grid rows are clickable (they open the submission),
and `StaffSubmissionDetail` / the admin grid use `renderEditor` for in-place editing. So:

- The **read-only** cell must render JSX, not a string.
- `displayValue` is used in **three** places in `SubmissionsGrid.tsx` (L471 read cell, L504 the
  saving-state cell, L560 the fallback cell). All three must agree, or a cell changes appearance the
  moment it is edited and back.

**Decision:** add a sibling to `formatValue` rather than changing its signature:

```tsx
/** The read-only renderer for an answer. Returns a string for every type except
 *  google_doc, which returns links. Kept separate from `formatValue` (which stays
 *  string-returning for exports and for the grid's plain-text states). */
export function renderValue(v: unknown, type?: string): ReactNode
```

`formatValue` keeps returning a **string** (exports and `displayValue` depend on it);
`renderValue` wraps it and special-cases `google_doc`. `displayValue` keeps returning a string for
every non-`google_doc` type and is left alone.

**★ Do not make `formatValue` return JSX.** It is called by `displayValue`, which is called by the
export table builder's client-side sibling and by the grid's saving/failed states — all of which
compare or concatenate the result. Changing its return type would break them silently at runtime
(a React element is truthy, so `|| "—"` would never fire).

### 4.6 The edit control

`renderEditor` gains a `google_doc` branch. Two sub-decisions:

- **When a value exists:** show the link(s) plus a small "Edit" affordance, because the common case
  is *viewing* the document, not retyping its id.
- **When editing:** a plain text input holding the raw id(s), matching every other type.

**★ Simplest correct shape for v1:** render the same `<input className="edit-input" type="text">` as
`text`, and render the **link below it** when the current value resolves to at least one id. This
avoids inventing a new control, keeps the grid's in-place editor working unchanged (it wraps
`renderEditor` in a cell and commits on Enter), and still gives the click-through the user asked for.

The value typed is stored as-is (a bare string), which `parseSubmissionValue` returns verbatim and
`googleDocIds` splits into one id. No special write path.

### 4.7 The Form Designer

Add to `AdminFormDesigner.tsx` `FIELD_TYPES`:

```ts
{ value: "google_doc", label: "Google Document" },
```

**★ Placement: after `email`, before `select`** — grouping the "single free-text-ish" types
together and keeping the choice types last, which is the existing order.

**★ No options editor — and this is already correct, verified.** The options textarea is gated by an
**allowlist**, not a denylist: `const isOptionsField = field.type === "select" || field.type ===
"radio" || field.type === "checkbox";` (L738) and the render branch repeats the same three-way test
(L825). So `google_doc` shows no options editor **with no change to that code** — do not "add it to
the exclusion list", because there is no exclusion list to add it to.

---

## 5. Data model

### 5.1 ★★ There IS a schema change — two unnamed CHECK constraints

**Measured, and it contradicts the first draft of this plan:** `form_fields.type` carries a SQL
`CHECK` constraint, declared **inline and unnamed** in the `CREATE TABLE`:

```sql
-- server/src/db/schema.ts L1074
 type NVARCHAR(20) NOT NULL CHECK (type IN ('text','textarea','number','date','select','checkbox','radio','email')),
```

**A second, identical constraint** sits on `submission_adhoc_fields.type` (L1201), which holds the
per-submission staff-only fields.

So `FIELD_TYPES` is **not** the only source of truth — the database refuses the new value until the
constraint is widened. Inserting `google_doc` without this step fails at the INSERT with SQL Server
error 547, which the app does not translate (`no error-code translation layer` — see the dual-db
notes), so it surfaces as a **500 naming a constraint**.

**★ Both constraints must be widened, and both are UNNAMED**, so the drop must be dynamic — the
exact pattern the repo already uses for `CK_users_role` (`schema.ts` ~L324-340) and for the
`resolved`→`completed` status rename:

```sql
-- One batch per table. Find the auto-named CHECK whose definition names the type
-- list but NOT the new value, drop it, then re-add it under an explicit name.
DECLARE @ck sysname;
SELECT TOP 1 @ck = name FROM sys.check_constraints
 WHERE parent_object_id = OBJECT_ID('dbo.form_fields')
   AND definition LIKE '%textarea%'
   AND definition NOT LIKE '%google_doc%';
IF @ck IS NOT NULL EXEC('ALTER TABLE dbo.form_fields DROP CONSTRAINT ' + @ck);

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_form_fields_type')
  ALTER TABLE dbo.form_fields WITH CHECK ADD CONSTRAINT CK_form_fields_type
    CHECK (type IN ('text','textarea','number','date','select','checkbox','radio','email','google_doc'));
```

…and the same pair for `submission_adhoc_fields` → `CK_submission_adhoc_fields_type`.

**★ `definition LIKE '%textarea%'` is the discriminator, not a name.** The constraint is auto-named
by SQL Server (`CK__form_fiel__type__…`), so there is no stable name to match — and
`definition NOT LIKE '%google_doc%'` makes the batch **idempotent**: after the first run the new
constraint contains `google_doc`, so it is not selected and the drop is skipped. That is what lets
this run on every boot with no version table.

**★ `WITH CHECK` (not `WITH NOCHECK`) on the re-add.** `WITH NOCHECK` would add the constraint
**without validating existing rows**, so a table that had somehow acquired a bad value would keep it
while the constraint claimed otherwise. The existing rows are all in the old list by construction,
so the validating add cannot fail — and if it ever did, that failure is information.

### 5.2 Both dialects

- **SQL Server:** the two batches above go into `SQLSERVER_DDL_STATEMENTS` (the cumulative ladder).
- **Turso:** `TURSO_DDL` is the **final shape** with `CREATE TABLE IF NOT EXISTS`, which is a no-op
  on an existing table — so the constraint there must be right in the `CREATE TABLE` **and** the
  existing database needs the same drop-and-recreate. SQLite **cannot** `ALTER TABLE … DROP
  CONSTRAINT`, so this is the one case where the Turso path genuinely differs: it needs a
  **table rebuild** (create new, copy, drop, rename) or — the honest alternative — **do not put a
  CHECK on `type` in the Turso DDL at all**, and let the zod enum be the only validator there.
  **Decide this deliberately**; the repo's precedent (`dual-db.md`) is that a divergence must be
  recorded, not discovered. *(Turso is not the live mode today — `DB_MODE=sqlserver` — so this can be
  deferred with a note, but it must not be silently skipped.)*

### 5.3 No data migration

No stored value is rewritten. A field already holding `'["1qcUzz…"]'` starts rendering as a link the
moment its type is changed to `google_doc` — which is the intended upgrade path for the field in the
screenshot. **But changing a `form_fields.type` is a write to whatever database `.env` names**, and
the widened CHECK must be applied **before** that write or the UPDATE 547s.

---

## 6. File-by-file change table

| File | Change |
|---|---|
| `server/src/db/schema.ts` | add `"google_doc"` to `FIELD_TYPES`; **widen both unnamed `type` CHECK constraints** (§5.1) |
| `server/src/db/dialect/turso.ts` | the `type` CHECK in `TURSO_DDL` — see §5.2 (SQLite cannot drop a constraint) |
| `server/src/db/queries.ts` | extract `COLLECTION_FIELD_TYPES`; add `google_doc` (§4.1) |
| `server/src/export/table.ts` | `google_doc` → join `googleDocUrl(id)` values with a space (§4.4) |
| `server/src/schemas.ts` | **no change** — `fieldTypeEnum` derives from `FIELD_TYPES` |
| `client/src/types/index.ts` | add `"google_doc"` to the `FieldType` union |
| `client/src/lib/googleDoc.ts` | **NEW** — `googleDocUrl`, `googleDocIds`, `isAbsoluteUrl` |
| `client/src/components/FieldValue.tsx` | `renderValue()` (NEW); `renderEditor` branch; `formatValue` branch |
| `client/src/components/SubmissionsGrid.tsx` | the three `displayValue` call sites → `renderValue` |
| `client/src/pages/admin/AdminFormDesigner.tsx` | `FIELD_TYPES` entry only — the options editor is an allowlist, so it needs no change (§4.7) |
| `client/src/pages/reports/ReportsPage.tsx` | the preview cell → `renderValue` |
| `client/src/styles/global.css` | a `.doc-link` class (link colour, `word-break: break-all` for long ids) |
| `docs/guides/user-guide.md` | a paragraph on the new field type (§7.3) |

**★ Files that look like they need changing but do not:**

- `server/src/swagger.ts` — **it DOES need changing, in five places.** The enum is **hand-written**,
  not derived: `enum: ["text", "textarea", "number", "date", "select", "checkbox", "radio",
  "email"]` appears at **L127, L238, L329, L1887 and L1923** (plus a bare `field_type: { type:
  "string" }` at L200 that needs nothing). Miss one and the Swagger UI documents a type set that
  cannot be chosen. Test G6 is what catches this.
- `server/src/routes/inventory.ts` — no new route, so no entry.
- `server/src/db/dialect/*` — **no new statement**, but `turso.ts`'s `type` CHECK is affected (§5.2).
  Do not add a dialect *member*; this is a DDL edit only.
- `client/src/pages/parent/*` — a parent sees their own submission; the confirmation page renders
  `f-value` spans for a fixed set of metadata fields, not the answers. Verify before editing.

---

## 7. Behavioural specification

### 7.1 Value shapes and their rendering

| Stored value | Type | Renders as |
|---|---|---|
| `'["abc123"]'` | `google_doc` | one link → `…/document/d/abc123/view` |
| `'["abc123","def456"]'` | `google_doc` | two numbered links |
| `'abc123'` (not JSON) | `google_doc` | one link → `…/document/d/abc123/view` |
| `'https://drive.google.com/file/d/abc123/view'` | `google_doc` | that URL, unchanged |
| `'javascript:alert(1)'` | `google_doc` | **plain text, not a link** |
| `'[]'` | `google_doc` | blank (`—` in a grid cell) |
| `null` | `google_doc` | blank |
| `'["abc123"]'` | `text` | **unchanged** — brackets still show (type is what decodes) |

### 7.2 Round-trip

Editing a `google_doc` field writes a bare string (the id, or a space/comma-separated list as typed).
It is stored verbatim; `googleDocIds` splits on whitespace and commas. **An array value is never
re-written as an array** — the edit control produces a string, which is the same shape a short-answer
webhook produces, so both paths converge.

### 7.3 Copy — what the UI says about permissions

The user asked for links, not permission management. The UI must not promise access it cannot grant.
Where a link appears in the **submission detail** (not in a dense grid cell), add one muted line:

> *Opens in Google Docs. Access is managed by staff — if you cannot open it, ask a staff member to
> share the document with you.*

**★ This is the honest counterpart to §3.4.** A link that silently 403s reads as a broken app; a
link that says who to ask reads as a permissions policy. Same principle as the "empty arrival names
its reason" rule in `docs/plans/…` — a destination that can legitimately fail should say so.

---

## 8. Verification plan

### 8.1 Gates (durable, in the existing suites)

| # | Gate | Where |
|---|---|---|
| G1 | `FIELD_TYPES` (server) and the designer's list (client) name the **same set** — both directions, reporting missing and extra by name | `server/src/db/*.test.ts` (source scan of `AdminFormDesigner.tsx`) |
| G2 | Every call site of `parseSubmissionValue` passes a field type that is in `COLLECTION_FIELD_TYPES` or is deliberately excluded — i.e. the set is the **only** collection rule | `server/src/db/*.test.ts` |
| G3 | The URL template in `client/src/lib/googleDoc.ts` and in `server/src/export/table.ts` are **byte-identical** | a source scan test |
| G4 | `isAbsoluteUrl("javascript:alert(1)")` is **false**; `googleDocUrl` output starts with `https://drive.google.com/file/d/` | `client` unit test (or a server-side scan if the client has no runner) |
| G5 | The widened `type` CHECK **accepts** `google_doc` and **still rejects** a bogus value — both directions, on **both** tables. ★ Include a control that the parser found the constraint at all | `server/src/db/*.test.ts` |
| G6 | **Every** `FieldType` enum literal in `swagger.ts` names the same set as `FIELD_TYPES` — scan for the literal, assert the count of sites found is ≥5, and diff each | `server/src/swagger.test.ts` |

**★ G1, G3 and G6 are all "a hand-copy must equal its source" checks.** That is the pattern this
repo needs here: the type list is copied into four files and the URL into two, and **a comment saying
"keep in step" has never once worked** (measured — see the `APP_OWNED_TABLES` note in memory).

### 8.2 Behavioural checks (throwaway probe, not committed)

1. **The screenshot case, end to end.** Seed a submission whose `google_doc` answer is
   `["1qcUzzb0Ej9eIO4UkkSKYCn36f_de3ZTj"]`; assert the detail page renders an `<a>` whose `href` is
   exactly `https://drive.google.com/file/d/1qcUzzb0Ej9eIO4UkkSKYCn36f_de3ZTj/view`, and that the
   cell's `textContent` **does not contain `[` or `"`**.
2. **The control that proves (1) is meaningful:** the same value on a `text` field renders **with**
   the brackets. If both render the same, the type is not being read.
3. **Multi-document:** `["a","b"]` renders **two** links, in order.
4. **Already-a-URL:** a stored `https://…/view` renders one link to that exact URL (no double-wrap).
5. **Injection:** a stored `javascript:alert(1)` renders as **text**, and
   `document.querySelectorAll('a[href^="javascript:"]').length === 0`.
6. **Export:** `GET /api/reports/export?format=csv` for a form with a `google_doc` column emits the
   **URL text**, and the cell contains no `[` or `"`.
7. **Grid consistency:** the read cell, the saving-state cell and the fallback cell in
   `SubmissionsGrid.tsx` all render the same thing for the same value (open the editor and commit
   the same value; the cell must not change appearance).

**★ Check 5 must include the negative control in the same run** — a `javascript:` href count of 0 is
only evidence if the same probe finds the legitimate `https://drive.google.com/…` href. Otherwise a
selector typo produces the same number.

### 8.3 Manual / visual

- Designer: the new option appears in the type `<select>`, and selecting it does **not** show the
  options textarea.
- A long id does not overflow its grid cell (`word-break`), and the page does not gain a horizontal
  scrollbar (`document.documentElement.scrollWidth === clientWidth`).
- The link opens in a new tab and the app's tab is still on the submission.

---

## 9. Traps (read before implementing)

1. **★★ The type list lives in FOUR code files — and the Swagger copy is hand-written FIVE times
   inside one of them.** Measured: `FIELD_TYPES` (`schema.ts` L33), the client union
   (`types/index.ts` L24), the designer's list (`AdminFormDesigner.tsx` L10) and **five separate
   enum literals in `swagger.ts` (L127, L238, L329, L1887, L1923)**. Adding to `FIELD_TYPES` alone
   leaves the designer without the option, the client union without the member, and the API docs
   describing a type that cannot be chosen — and **nothing fails**; the type simply cannot be
   selected. Gates G1 and G6 exist for this. **★ A regex for the literal must assert it found ≥5
   sites**, or a pattern that matches nothing "passes" by finding nothing to check.
2. **★★ `parseSubmissionValue`'s `fieldType` argument is what decides whether the stored JSON is
   decoded.** A new collection-shaped type that is not added to that rule renders its raw
   `["…"]` text. This is the defect visible in the screenshot and it is *not* fixed by adding the
   type to `FIELD_TYPES`.
3. **★ `formatValue` must keep returning a string.** It feeds `displayValue`, which feeds the grid's
   saving/failed states and the export path. Returning JSX from it breaks those silently — a React
   element is truthy, so `formatValue(v) || "—"` never falls back.
4. **★ Three `displayValue` call sites in `SubmissionsGrid.tsx` must change together** (L471 read,
   L504 saving, L560 fallback), or a cell changes appearance when edited and back.
5. **★ `rel="noopener noreferrer"` on every generated link**, and **`isAbsoluteUrl` must allowlist
   `https?://` only** — never "contains a colon". This is the one place the feature can become an
   XSS vector.
6. **★ Do not join multiple URLs with a comma** in the export — a comma is the CSV delimiter and a
   comma-joined URL list reads as one URL. Join with a space.
7. **★ The webhook may send a bare string OR an array.** A Google Forms *file-upload* question
   answers with an array of Drive ids; a *short-answer* question answers with a string. Handle both.
8. **★ `parseSubmissionValue` is called from two functions** (single and batch). One change covers
   both **only because** both read `ff.type` from the same join — verify with grep before editing.
9. **★ A field already holding the value needs only its TYPE changed** — no data migration. But
   changing a `form_fields.type` is a **write to whatever database `.env` names**, which in this repo
   has been production more than once. **Read `.env` line ~29 before running any update.**
10. **★★ The `type` CHECK is a SECOND source of truth, and it is UNNAMED on TWO tables.**
    `FIELD_TYPES` is not enough: `form_fields.type` (L1074) and `submission_adhoc_fields.type`
    (L1201) each carry an inline, auto-named `CHECK (type IN (…))`. Inserting `google_doc` before
    widening them 500s with SQL Server error 547 naming a generated constraint name. The drop must
    be **dynamic** (find by `definition LIKE '%textarea%' AND definition NOT LIKE '%google_doc%'`),
    which is also what makes it idempotent. **A `CREATE TABLE` edit does NOT change an existing
    table** — the ladder batch is the fix, not the declaration.
11. **★ `docs/plans/google-doc.md` is a DIFFERENT feature** (generating documents from a template,
    with a `dbo.documents` table and a retry path). Do not merge the two, and do not reuse
    `dbo.documents` for this — a Google Document *field* creates nothing.

---

## 10. Open questions — ANSWERED 2026-10-02

| # | Question | Answer | Effect on the plan |
|---|---|---|---|
| Q1 | Multi-document display | **Numbered list** | §4.4's numbered list is confirmed; the export still joins with a space (a CSV cell cannot number anything) |
| Q2 | Should XLSX carry a real hyperlink? | **No** | XLSX stays plain text like CSV — the WYSIWYG invariant holds, and `export/table.ts` needs no format-specific branch |
| Q3 | Warn when a field is retyped but holds non-ID values? | **No** | No designer warning; the renderer degrades to text and that is the whole behaviour |
| Q4 | Is ID-searchable-but-URL-not the intent? | **No** — i.e. this is **not** the desired behaviour | ★ See below |

### 10.1 ★ Q4 changes the design — the URL must be searchable

The plan's §2.4 note said the stored value is the **id**, so a search for the id works but a search
for the **URL** does not. The user's answer (**No**) means that is not acceptable: a staff member who
has the document open in a browser will copy the **URL**, paste it into the submission search, and
expect to find the row.

**The fix is deliberately NOT "store the URL".** Storing a derived value would (a) duplicate the id,
(b) go stale if the URL shape ever changes, and (c) require a migration of existing rows. Instead,
**`buildSubmissionFilters`'s search clause gains a second, type-aware disjunct**:

```sql
-- existing: matches the raw stored value (the bare id)
CAST(svq.value AS NVARCHAR(MAX)) LIKE @q ESCAPE '\'
-- added: matches the id INSIDE a pasted URL, for google_doc fields only
OR (ffq.type = 'google_doc' AND @qUrlId LIKE '%' + <extracted id> + '%')
```

**★ The clean shape is to normalise the SEARCH TERM, not the stored value.** Extract a Drive id from
the query itself (`/\/document\/d\/([A-Za-z0-9_-]{10,})/`) and, when one is found, also match it
against `svq.value`. That is one extra parameter and one extra disjunct — no schema change, no
migration, and it works for a pasted URL of any shape (trailing `/view`, `?usp=sharing`, `#heading`).

**★ Why term-normalisation beats value-normalisation here:** the stored value is the *source of
truth*; rewriting it at query time means every search re-parses every row. Parsing the one term the
user typed is O(1) and cannot disagree with what is stored.

**★ This must be applied in `buildSubmissionFilters` (`server/src/db/queries.ts`), which is the ONE
clause builder** shared by `listSubmissions` and `submissionArchiveCounts` — so the grid and the
"N archived hidden" badge cannot disagree about which rows a pasted URL selects. Add a behavioural
check (§8.2 #8) and a control asserting a *non*-URL term still matches on the raw value.

---

## 11. ★ Deployment to production — what you will need

**Implemented and verified against the serverless database (`wcpss-sql-serverless-freetier` /
`school-form-data`) on 2026-10-02.**

### 11.1 The one thing that matters: the CHECK constraints migrate themselves

Production is `wcpsssqlelasticpool` / `wcpss-google-forms` (a **different** database this app did not
create — see the repo's notes on the foreign-DB DDL ladder). The good news is that **the schema
change needs no manual step**: the two widening batches in §5.1 are part of
`SQLSERVER_DDL_STATEMENTS`, which `initDb()` runs on **every boot**, before the app reports
`dbReady`.

So the sequence on deploy is:

1. The new code boots, `initDb()` runs the ladder.
2. The two batches find the old eight-value constraints (they do not mention `google_doc`), drop
   them, and re-add them with the new value under explicit names.
3. `dbReady` is set and the app serves.

**No migration script, no manual SQL, no downtime.** The batches are idempotent (`definition NOT
LIKE '%google_doc%'`), so a second boot does nothing.

### 11.2 ★ Verify the migration actually ran — do not assume it

The ladder is **create-if-missing** and its failures are quiet. After the first production boot,
confirm the constraints by name:

```sql
SELECT name, definition FROM sys.check_constraints
 WHERE parent_object_id IN (OBJECT_ID('dbo.form_fields'),
                            OBJECT_ID('dbo.submission_adhoc_fields'))
   AND definition LIKE '%google_doc%';
```

**Expect exactly 2 rows**, named `CK_form_fields_type` and `CK_submission_adhoc_fields_type`.

### 11.3 ★★ The production risk is NOT this feature — it is the ladder running at all

This is the standing hazard on this deployment, and it applies to every deploy, not just this one:
**a `DB_MODE=sqlserver` slot pointed at the shared production database applies the whole DDL ladder
to production on its first request**, before any slot swap. That is safe **only while every change is
backward compatible.**

This change is backward compatible: it **widens** two constraints and adds no column, renames
nothing and drops nothing. Every existing row still satisfies the new constraint (the new list is a
superset), and no stored value is rewritten. So a staging slot sharing the production DB is safe
here — but note the constraints will be widened on production **the moment staging boots**, not at
swap time.

### 11.4 Nothing else changes

- **No new environment variables.** No Drive credentials, no API keys — the app builds a URL and
  never calls Google. (The existing `GOOGLE_*` vars are for the *document generation* feature, which
  is unrelated.)
- **No new route**, so no `inventory.ts` / `swagger.ts` path entry and no CI change.
- **No data migration.** Existing answers keep their stored ids.
- **No package changes.** No new dependency on either side.

### 11.5 Optional: retype an existing field

To make an existing field render links (the field in the screenshot), change its type:

```sql
UPDATE dbo.form_fields SET type = 'google_doc' WHERE id = <id>;
```

**★ Run the constraint check in §11.2 FIRST.** If the ladder has not yet widened the CHECK, this
UPDATE fails with SQL Server error 547 — so on production, deploy the code, let it boot once, then
retype.

**★ Confirm which database `.env` names before running this.** This repo's `.env` has pointed at
production more than once, and this is a write to real data.

---

## 12. ★★ CORRECTION (2026-10-02): the host is `drive.google.com/file/d/`, not `docs.google.com/document/d/`

**The user caught this after testing a real link.** The original request quoted
`https://docs.google.com/document/d/[document-id]/view`, and the first implementation used it
verbatim. That is the wrong host for this feature.

### 12.1 The measured evidence

Queried the **Drive API v3** with the app's own credentials (`drive.files.get`, `supportsAllDrives`),
reading each file's own `webViewLink` — i.e. asking Google what link it gives, rather than guessing:

| file | MIME type | Drive's own `webViewLink` |
|---|---|---|
| a PDF in the org's Drive | `application/pdf` | `https://drive.google.com/**file**/d/<id>/view?usp=drivesdk` |
| the app's doc template | `application/vnd.google-apps.document` | `https://docs.google.com/**document**/d/<id>/edit?usp=drivesdk` |

**The link shape is decided by the file's MIME type, and the two paths are not interchangeable.**

A Google Forms **file upload** stores a **binary file** in Drive (`application/pdf`, an image, …) —
*not* a Google Doc. So `drive.google.com/file/d/` is the correct host, and the `docs` path 404s for
it. The user's correction was right.

### 12.2 What changed

| Site | Change |
|---|---|
| `client/src/lib/googleDoc.ts` | `GOOGLE_DOC_URL_PREFIX` → `https://drive.google.com/file/d/` |
| `server/src/export/table.ts` | same constant, kept byte-identical (gate G3) |
| `server/src/db/queries.ts` | `driveDocumentIdFromQuery` now accepts **both** `/file/d/` and `/document/d/` |
| `google-doc-field.test.ts` | G3's literal expectation updated |
| `docs/guides/user-guide.md` | wording: "file in Google Drive", not "document in Google Docs" |

**★ The search extractor accepts BOTH shapes deliberately.** The app links the `file` form, but a
reader may paste either — a Google Doc URL is what most people have in their clipboard. A search
that silently failed on one of them would look like the row is missing, which is the exact failure
the URL-search feature exists to prevent.

### 12.3 ★ This is the payoff of §3.2, and it cost one line

The plan argued the URL should be **derived at render time rather than stored**. That decision is
what made this correction a constant change in two files with **no data migration** — every stored
value is still the raw id. Had the URL been stored, this would have been an `UPDATE` against
production rows.

**★ Generalise: a derived display value is a one-line fix; a stored one is a migration.**

### 12.4 ★ The 33-character id was a SECOND, independent problem

While verifying, the id in the original screenshot measured **33 characters**; real Drive ids are
**44**. The Drive API returns `404 File not found` for it with valid credentials — so that link
could never have worked, regardless of host. Two separate faults, and fixing the host does not fix
the id.

**★ Diagnosing "the link is broken" needs both facts:** does the URL *shape* resolve, and does the
*specific id* exist? A 404 from Drive is an id problem; a 401 is a permissions problem. The generic
"Sorry, unable to open the file at this time" page is Google's 404 and reads like a permissions
error, which is what made it misleading.
