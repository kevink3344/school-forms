# Organization-level Google Drive Folder — Implementation Plan

> **Status:** Draft for review
> **Date:** 2026-08-30
> **Goal:** Move the Google Drive **parent folder id** out of the shared `.env`
> (`GOOGLE_DOC_FOLDER_ID`) and into the `organizations` table, so each organization
> can point its generated documents at its **own** shared Drive location. Keep
> `GOOGLE_DOC_TEMPLATE_ID` and `GOOGLE_IS_SHARED_DRIVE` global (all orgs share the
> same template and shared-drive setting in this pass).

---

## 1. Why

Today `server/src/config/env.ts` reads `GOOGLE_DOC_FOLDER_ID` once, globally. Every
organization's staff-saved documents ("Generate document" feature) are written into
the **same** Drive parent, with a per-school subfolder created under it. Now that
orgs are real multi-tenant boundaries (`organizations`), each org may have its own
shared Drive — so the parent folder must be **per-org**.

The submission already knows its org (`submission.organization_id`), and
`organizations` is a plain, extensible table (we just added `description`), so this
is a contained change that mirrors the `description` pattern exactly.

---

## 2. Precedence & behavior

| Configuration                          | Result                                    |
| -------------------------------------- | ----------------------------------------- |
| Org has `doc_folder_id` set            | Use the org's folder (primary source).    |
| Org has no `doc_folder_id` (NULL)      | Fall back to `env.google.docFolderId`.    |
| Neither is set                         | `null` → save to Drive root (today's behavior). |

- An org-level folder **overrides** the global env value.
- Per-school subfolders still apply — they're created **under the org's folder**.
- Setting `doc_folder_id` to `null` / empty string clears the override (falls back to env).

> **Consideration (out of scope):** `GOOGLE_IS_SHARED_DRIVE` is still global. If
> some orgs use a shared drive and others don't, that flag would also need to become
> per-org. Keeping it global means all orgs share the same drive type.

---

## 3. Backend changes

### 3.1 Schema — `server/src/db/schema.ts`
Add to the `Organization` interface:
```ts
doc_folder_id: string | null;
```
Add an idempotent migration (append to the existing organizations DDL block):
```sql
IF COL_LENGTH('dbo.organizations', 'doc_folder_id') IS NULL
  ALTER TABLE dbo.organizations ADD doc_folder_id NVARCHAR(255) NULL;
```

### 3.2 Queries — `server/src/db/queries.ts`
- Add `doc_folder_id` to the SELECT lists in `listOrganizations`, `getOrganizationById`, `getOrganizationBySlug`.
- `createOrganization` → make `doc_folder_id` a parameter; include `INSERTED.doc_folder_id` in the OUTPUT.
- `updateOrganization` → extend the data type with `doc_folder_id?: string | null`; use the same
  `hasOwnProperty` guard as `description` so an explicit `null` **clears** the override while an
  absent key leaves it unchanged.

### 3.3 Validation — `server/src/schemas.ts`
Add to both `createOrganizationSchema` and `updateOrganizationSchema`:
```ts
doc_folder_id: z.string().max(255).nullable().optional(),
```

### 3.4 Route — `server/src/routes/organizations.ts`
- POST: `const docFolderId = parsed.data.doc_folder_id?.trim() || null;` → pass to `createOrganization`.
- PUT: pass `doc_folder_id: parsed.data.doc_folder_id?.trim() || null` to `updateOrganization`.
- GET `/`: include `doc_folder_id: org.doc_folder_id` in the response object.

### 3.5 Swagger — `server/src/swagger.ts`
- Add `doc_folder_id: { type: "string", nullable: true }` to the `Organization` schema.
- Add `doc_folder_id` to the create/update request-body schemas.

### 3.6 Document generation — `server/src/google/docs.ts`
This is the functional core. Today `ensureSchoolFolder(drive, schoolName)` reads
`env.google.docFolderId` directly. Change it to resolve the parent from the org:

1. Import `getOrganizationById` (add to the existing `queries` import).
2. Add a resolver helper:
   ```ts
   async function resolveParentFolderId(organizationId: number): Promise<string | null> {
     const org = await getOrganizationById(organizationId);
     const orgFolder = org?.doc_folder_id?.trim();
     return orgFolder || env.google.docFolderId || null;
   }
   ```
3. Change `ensureSchoolFolder(drive, schoolName, parentFolderId)` to accept the resolved parent id
   instead of reading `env.google.docFolderId` internally:
   - `if (!parentFolderId) return null;`
   - `if (!schoolName) return parentFolderId;`
   - use `parentFolderId` for `findFolderByName` and `parents`.
4. In `runGeneration`, resolve once and pass it:
   ```ts
   const orgParentId = await resolveParentFolderId(submission.organization_id);
   const parentId = await ensureSchoolFolder(drive, schoolName, orgParentId);
   ```
   (`copyTemplate` already takes `parentId` unchanged.)

`runGeneration` already has `submission.organization_id` via `getSubmissionById`, so the org is
always available at the point of resolution.

> **Route note (partial-update isolation):** the PUT route must NOT always send
> `description` / `doc_folder_id`. Because `updateOrganization` uses
> `hasOwnProperty` to distinguish "omitted" from "explicit null", passing a key
> with an `undefined` value is treated as present and **clears** the column. Include
> these keys only when the client actually supplied them:
> ```ts
> ...(Object.prototype.hasOwnProperty.call(parsed.data, "description") ? { description: parsed.data.description } : {}),
> ...(Object.prototype.hasOwnProperty.call(parsed.data, "doc_folder_id") ? { doc_folder_id: parsed.data.doc_folder_id?.trim() || null } : {}),
> ```

---

## 4. Frontend changes

### 4.1 Types — `client/src/types/index.ts`
Add to the `Organization` interface:
```ts
doc_folder_id: string | null;
```

### 4.2 API — `client/src/lib/api.ts`
- `createOrganization` input → add `doc_folder_id?: string | null`.
- `updateOrganization` input → add `doc_folder_id?: string | null`.

### 4.3 Settings UI — `client/src/pages/admin/AdminSettings.tsx`
Mirror the `description` wiring:
- Add `doc_folder_id: string` to `OrgFormState` and `EMPTY_ORG`.
- In `openOrgEdit`, set `doc_folder_id: o.doc_folder_id ?? ""`.
- In `handleOrgSave`, send `doc_folder_id: orgForm.doc_folder_id.trim() || null` on both create and update.
- Add a text input (or a small "Google Drive" field group) directly below the Description field, e.g.:
  ```tsx
  <Field label="Drive Folder ID" full>
    <input
      className="edit-input"
      value={orgForm.doc_folder_id}
      onChange={(e) => setOrgForm((f) => ({ ...f, doc_folder_id: e.target.value }))}
      placeholder="Google Drive folder ID (optional)"
    />
  </Field>
  ```
  A `monospace` style would help since folder IDs are opaque strings.

---

## 5. Data / migration

- Add the nullable `doc_folder_id` column (idempotent `IF COL_LENGTH`), applied automatically on
  server restart via the existing DDL routine (in `server/src/db/pool.ts`).
- **Seed backfill:** `backfillOrganizationFolderIds(db)` (called from `runDdl()`) sets
  `doc_folder_id = GOOGLE_DOC_FOLDER_ID` for the `academics` org when it's currently `NULL` and the
  env folder id is non-empty. This seeds the default org (id 1) with the env value
  `0AMopBbRk6De5Uk9PVA`. Other orgs keep `NULL` and fall back to `GOOGLE_DOC_FOLDER_ID` until an
  admin sets a per-org folder.

---

## 6. Verification

1. Server `tsc`, client `tsc`, `vitest` — all green.
2. `GET /api/organizations` returns `doc_folder_id` (null initially).
3. `PUT /api/organizations/:id {"doc_folder_id":"abc123"}` persists; `{"doc_folder_id":null}` clears it.
4. `PUT` with a blank string also clears (normalized to null).
5. End-to-end: staff ticks "Generate document" → new doc lands in the org's configured Drive folder
   (with the per-school subfolder underneath), not the global one.
6. Org with `doc_folder_id = null` → doc lands in the global env folder (fallback confirmed).

---

## 7. Files touched

**Backend:** `server/src/db/schema.ts`, `server/src/db/queries.ts`, `server/src/db/pool.ts`,
`server/src/schemas.ts`, `server/src/routes/organizations.ts`, `server/src/swagger.ts`,
`server/src/google/docs.ts`.

**Frontend:** `client/src/types/index.ts`, `client/src/lib/api.ts`, `client/src/pages/admin/AdminSettings.tsx`.

**Docs:** this plan.

---

## 8. Open questions

1. Should the **same** field drive the template id too, i.e. move `docFolderId` + `docTemplateId` +
   `isSharedDrive` together into a per-org Google config? (Currently only the folder moves.)
2. Should the admin settings panel hide the Drive Folder ID field unless the "Documents" feature is
   enabled for that role? (No current dependency, but worth confirming the desired UX.)
3. Is it acceptable that `GOOGLE_IS_SHARED_DRIVE` remains global — all orgs share the same drive type?
