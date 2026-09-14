# Plan — Google Form URL field + field import

**Status:** Draft for review
**Date:** 2026-09-13
**Area:** Admin → Form Designer (`/admin/forms/:id`)

---

## 1. Goal

Add a **"Google Form URL"** field beneath **Drive Folder ID** in the Form Designer. When an
admin pastes a Google Form URL:

1. The app **fetches the Google Form** and reads its questions.
2. Those questions become **fields in the designer** (so the admin doesn't retype them).
3. The URL is **stored on the form** and shown to staff.

This pairs with the existing Google Forms intake path: the Apps Script webhook
(`docs/plans/google-script.md`) requires Google Form question titles to **exactly match** the
School Forms field labels. Importing the fields guarantees that match.

---

## 2. ⚠️ Critical constraint — read this first

**Reading a Google Form's questions requires the Google Forms API, which needs a NEW OAuth
scope that the current credentials do not have.**

Today the app authenticates with a **refresh token** (`env.google.refreshToken`) minted for the
Docs + Drive scopes only (`server/src/google/docs.ts:35-46`). The Forms API needs:

```
https://www.googleapis.com/auth/forms.body.readonly
```

Adding a scope means **re-running the OAuth consent flow** and generating a **new refresh
token**. That is a manual, one-time setup step you (the account owner) must perform — I cannot
do it from here. Until that token exists, the import cannot work.

### Options

| Option | What it needs | Trade-off |
| --- | --- | --- |
| **A. Forms API (recommended)** | New refresh token with `forms.body.readonly` | Clean, official, reads question titles + types reliably |
| **B. Scrape the public HTML** | Nothing new | Fragile — breaks on Google markup changes; fails on private forms; no reliable type info |
| **C. Manual paste** | Nothing | Admin pastes the question list as text; no API needed |

**Recommendation: Option A**, with the field still usable (stored + shown) even if the import
fails, so nothing breaks while the token is being set up.

---

## 3. What "hide the Google Form" means here

Per your answer, the URL is **shown to staff** (not used to hide the in-app parent form).
Concretely:

- The URL is stored on the form (`forms.google_form_url`).
- The Form Designer shows it as a **clickable link** once saved.
- The staff submission detail / form pages can surface it so staff can open the Google Form.

---

## 4. Data model

Add one nullable column to `dbo.forms`, following the existing idempotent pattern
(`IF COL_LENGTH(...) IS NULL`):

```sql
ALTER TABLE dbo.forms ADD google_form_url NVARCHAR(1000) NULL;
```

- `NVARCHAR(1000)` — comfortably fits a Google Forms URL with query params.
- Nullable → additive, backward-compatible, no backfill needed.

Add `google_form_url: string | null` to the `Form` interface in `server/src/db/schema.ts` and
the client `Form` type.

---

## 5. Backend changes

### 5.1 `server/src/db/schema.ts`
- Add the `google_form_url` column DDL (own batch, `IF COL_LENGTH` guard).
- Add `google_form_url: string | null` to the `Form` interface.

### 5.2 `server/src/db/queries.ts`
- Include `google_form_url` in the `listForms` and `getForm` / `getFormWithFields` SELECTs.
- Include it in `createForm` / `updateForm` writes.

### 5.3 `server/src/google/forms.ts` *(new)*
A small module mirroring `google/docs.ts`:

```ts
// Extract the form id from any Google Forms URL shape:
//   https://docs.google.com/forms/d/<ID>/edit
//   https://docs.google.com/forms/d/e/<ID>/viewform
//   https://forms.gle/<short>
export function extractFormId(url: string): string | null;

// Fetch the form and return its questions as designer fields.
export async function fetchGoogleFormFields(url: string): Promise<{
  title: string;
  fields: { label: string; type: FieldType; options: string[] | null; required: boolean }[];
}>;
```

**Type mapping** (Google Forms item → our `FIELD_TYPES`):

| Google Forms | Ours |
| --- | --- |
| `textQuestion` (paragraph=false) | `text` |
| `textQuestion` (paragraph=true) | `textarea` |
| `choiceQuestion` (RADIO) | `radio` |
| `choiceQuestion` (CHECKBOX) | `checkbox` |
| `choiceQuestion` (DROP_DOWN) | `select` |
| `scaleQuestion` | `select` (options = the scale labels) |
| `dateQuestion` | `date` |
| `timeQuestion` | `text` |
| `fileUploadQuestion` | `text` (no upload support — see §9) |
| `rowQuestion` (grid) | `text` (flattened) |

### 5.4 `server/src/routes/forms.ts`
New admin-only route, mirroring `POST /:id/drive-validate`:

```ts
// Admin: fetch a Google Form and return its questions as designer fields.
// Does NOT persist — the client merges them into the editor and the admin saves.
formsRouter.post("/:id/google-form-import", requireAuth, requireRoles("admin"), ...)
// body: { url: string }
// 200: { title, fields: [...] }
// 400: invalid URL / not a Google Form
// 502: Google API error (token missing scope, form private, etc.)
```

**Important:** this route **does not write** — it returns the parsed fields so the admin can
review them in the designer before saving. That keeps the admin in control and avoids
surprising mutations.

### 5.5 `server/src/swagger.ts`
Document the new route and the new `google_form_url` field on the Form schema.

---

## 6. Frontend changes

### 6.1 `client/src/types/index.ts`
- Add `google_form_url: string | null` to `Form`.
- Add `"google_form_url"` where form payloads are typed.

### 6.2 `client/src/lib/api.ts`
- Add `importGoogleForm(formId, url)` → `POST /api/forms/:id/google-form-import`.
- Include `google_form_url` in `updateForm`'s payload type.

### 6.3 `client/src/pages/admin/AdminFormDesigner.tsx`
- New state: `googleFormUrl`, `googleFormImporting`, `googleFormError`.
- Load it with the rest of the form metadata (alongside `docFolderId`).
- Render the field **directly beneath Drive Folder ID**:
  - Label: **Google Form URL**
  - Text input (placeholder: `https://docs.google.com/forms/d/.../edit`)
  - An **"Import fields"** button next to it
  - Inline status: importing spinner / error / "Imported N fields"
  - Once saved, show a small **"Open Google Form"** link
- On import success: append the returned fields to the designer's `fields` state, mark dirty,
  and show a summary (e.g. "Imported 12 fields — review and Save").
- Persist `google_form_url` in `handleSave`.

### 6.4 Staff visibility
- Add a **"Google Form"** link on the staff submission detail page (and/or the form's public
  info) when `google_form_url` is set, so staff can open it.

---

## 7. Import behavior details

- **Merge vs. replace:** default to **append** (never silently destroy existing fields). If the
  designer already has fields, show a small confirm: "Add 12 imported fields to the 5 existing
  ones?" — with the option to replace instead.
- **Duplicates:** skip an imported question whose label already exists (case-insensitive), so
  re-importing is idempotent.
- **Required:** map Google's `required` flag through.
- **Options:** import choice options verbatim (they're stored as a comma-joined string in our
  `options` field — see `AdminFormDesigner`'s options editor).
- **Staff-only:** imported fields default to **parent-facing** (`staff_only: false`); the admin
  can flip any to staff-only afterward.
- **Nothing is saved until the admin clicks Save** — the import only populates the editor.

---

## 8. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| **Missing OAuth scope** → import fails. | Store the URL regardless; surface a clear, actionable error ("Google Forms access isn't configured — see docs"). The field still works as a reference link. |
| Form is private / not shared with the service account. | Return a clear 502 with a human message; the admin can still paste fields manually. |
| `forms.gle` short links need a redirect resolve. | Follow the redirect server-side before extracting the id. |
| Google changes its API shape. | Isolate all parsing in `google/forms.ts`; unit-test the type mapping. |
| Accidentally clobbering existing fields. | Append-by-default + explicit confirm; never auto-replace. |
| URL stored unvalidated. | Validate on save (must be a Google Forms host); reject otherwise with a 400. |

---

## 9. Out of scope (call out if wanted)

- **File-upload questions** can't be represented — `FIELD_TYPES` has no `file` type. Imported as
  `text` with a warning.
- **Grid / scale questions** are flattened to a single field.
- **Two-way sync** — editing the Google Form later does not re-sync. Re-import is manual.
- **Creating** a Google Form from a School Forms form (the reverse direction).

---

## 10. Verification plan

1. Migration adds `google_form_url` idempotently (re-run = no-op).
2. Save a URL → persists → survives reload.
3. Import a real Google Form → fields appear with correct labels/types/options/required.
4. Re-import → duplicates are skipped (idempotent).
5. Import with a bad URL → 400 with a clear message; nothing changes.
6. Import without the Forms scope → 502 with an actionable message; the URL still saves.
7. Staff view shows the Google Form link when set.
8. `npm run typecheck` (server + client).

---

## 11. Open decisions for review

1. **OAuth scope** — are you able to re-run the consent flow to add `forms.body.readonly`? If
   not, we fall back to Option B/C (§2).
2. **Import merge behavior** — append (recommended) or replace?
3. **Where staff see the link** — submission detail only, or also the forms list / public page?
4. **Validation strictness** — accept only `docs.google.com/forms` + `forms.gle`, or any URL?
