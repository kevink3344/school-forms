# Plan — Incremental Submission IDs (e.g. `CDM-1001`)

## Goal

Replace the opaque 32-char hex `public_id` (GUID-style) that currently identifies
a submission with a short, human-friendly, **incremental per-form** identifier —
e.g. `CDM-1001`, `CDM-1002`, `CDM-1003`. Admin/staff and parents see this as
"The Submission ID".

The example `CDM-1001` means: prefix `CDM` (the form's code) + zero-padded,
per-form sequence number `1001`.

## Requirements / non-goals

- The identifier must be **human-readable** in UI, emails, and URLs.
- It must be **incrementing per form** (contiguous `1001, 1002, 1003` for a given form).
- It must remain **globally unique** — `public_id` is backed by `UX_submissions_public_id`
  and used as the lookup key in `/api/submissions/:publicId` and in public/parent
  URLs (`/submission/:publicId`, `/org/:slug/submission/:publicId`).
- **Generation must be concurrency-safe** — two simultaneous submissions must never
  get the same number.
- The numeric counter should keep incrementing across the app's lifetime (not reset on
  restart, and survive re-deploys) — so it must live in the DB, not in memory.
- Preserve existing behavior everywhere `public_id` is consumed (routes, types, UI).

## Current state (what `public_id` touches)

| Layer | Location | Note |
|---|---|---|
| DB | `submissions.public_id NVARCHAR(64) NOT NULL` + `UX_submissions_public_id` | unique index, 32-hex |
| Gen | `server/src/db/schema.ts` `newPublicId()` | `randomBytes(16).toString("hex")` |
| Create | `server/src/db/queries.ts` `createSubmission(form, publicId, answers)` | inserts given `public_id` |
| Create callers | `routes/submissions.ts` POST `/` and `routes/webhook.ts` POST `/google` | both `newPublicId()` |
| Lookup | `queries.ts` `getSubmissionByPublicId(publicId, orgId?)` | param lookup |
| Seed | `db/seed.ts` hardcoded `PUBLIC_ID = "7bea2443-a5bb-4e40-a5c2-95034718fdd3"` | reference row |
| Client types | `types/index.ts` `Submission.public_id: string` | |
| Client API | `api.ts` `getSubmission(publicId)` etc. | URL path param |
| UI | `StaffQueue` (table col "Submission ID"), `StaffSubmissionDetail` (header + "Submission ID" label), `AdminDashboard` grid row key, `ParentConfirmation` ("keep this Submission ID safe") | display + row keys |
| Routes | `App.tsx` `/admin/submissions/:publicId`, `/staff/:publicId`, `/submission/:publicId`, `/org/:slug/submission/:publicId` | URL param |
| Swagger | `swagger.ts` `/api/submissions/{publicId}/...` | param is a string |

`public_id` is **always a string** everywhere (fast path — no typing change needed),
so swapping the value format from hex to `CODE-NNNN` is low-risk as long as
uniqueness is preserved.

## Key design decision — uniqueness

`public_id` is globally unique. The natural scheme `CODE-SEQ` (per-form counter) is
unique *within* a form, but two different forms with the **same code** would both
produce `CDM-1001` and collide on the unique index.

This is the single decision to confirm. Recommended options, in order of preference:

### Option A (recommended) — make `forms.code` unique
Add a short `forms.code` column and enforce global uniqueness (filtered unique index
where `code IS NOT NULL`). The per-form `submission_seq` then guarantees the full id
is globally unique. The number is contiguous per form (matches the example exactly).
- **Tradeoff**: two orgs can't both have a form coded `CDM`. For a district system
  where codes are category labels (CDM, IEP, 504, Referral), this is usually desirable
  and rarely a limitation.

### Option B — scope uniqueness to `(organization_id, public_id)`
Replace the global unique index with a unique index on `(organization_id, public_id)`.
Allows the same code in different orgs.
- **Tradeoff**: `public_id` is no longer globally unique, so **every** lookup that
  reaches `submissions` must be org-scoped. Today the anonymous parent readback route
  is only org-scoped when `?org=` is provided, so this would force an org-scoped
  readback everywhere (and a code change in the parent URL flow). More invasive.

### Option C — single global sequence, per-form prefix
Keep one global sequence and set `public_id = CODE-GLOBALSEQ`.
- **Tradeoff**: a form's numbers are NOT contiguous (it skips whenever other forms
  submit), which contradicts the "1001, 1002" example. Not recommended.

**Recommendation: Option A.**

### Where does the prefix come from? (sub-decision)

The `CDM` prefix must be a stable, short, editable **form code**, not derived from the
form `title` (titles contain spaces, can be edited, and may collide). So:

- Add `forms.code NVARCHAR(20) NULL`. When creating a form, auto-generate a default
  code from the title (uppercase, strip non-alphanumeric, truncate ~8 chars, ensure
  uniqueness by appending a short suffix on collision). Expose it as an editable field
  in the Form Designer so admins can set `CDM` explicitly.
- Keep it **nullable** so forms that never get a code fall back to a safe prefix
  (e.g. `SUB`).

## Schema changes (SQL Server, idempotent per COL_LENGTH guard)

All added in `server/src/db/schema.ts` DDL list, each as its **own batch** (the
`request.batch()` quirk: a column add and an index on that new column must be separate
entries).

1. **forms**
   ```sql
   IF COL_LENGTH('dbo.forms', 'code') IS NULL
     ALTER TABLE dbo.forms ADD code NVARCHAR(20) NULL;
   ```
   ```sql
   IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_forms_code')
     CREATE UNIQUE INDEX UX_forms_code ON dbo.forms(code) WHERE code IS NOT NULL;
   ```
   ```sql
   IF COL_LENGTH('dbo.forms', 'submission_seq') IS NULL
     ALTER TABLE dbo.forms ADD submission_seq INT NOT NULL
       CONSTRAINT DF_forms_submission_seq DEFAULT 0;
   ```
   > Note: adding a non-null column with a DEFAULT is fine on SQL Server. The unique
   > index on `code` must be its own batch (after the column add).

2. **submissions**
   ```sql
   IF COL_LENGTH('dbo.submissions', 'submission_seq') IS NULL
     ALTER TABLE dbo.submissions ADD submission_seq INT NULL;
   ```
   (Optional, for stable display/sorting/filtering by number. Could be omitted and the
   number only baked into `public_id` — but storing it makes the "latest number"
   queryable without string parsing. Recommend keeping it.)

## Backend changes

### 1. New generator helper — `server/src/db/queries.ts`

Replace the free-form `newPublicId()` call with an allocation that:
- Runs inside a transaction.
- Atomically increments the per-form counter and returns the new number, using the
  classic `UPDATE ... OUTPUT` (row-locked, race-safe on SQL Server):
  ```sql
  UPDATE dbo.forms
  SET submission_seq = submission_seq + 1
  OUTPUT INSERTED.submission_seq
  WHERE id = @formId;
  ```
- Builds the id: `` `${code || "SUB"}-${String(seq).padStart(4, "0")}` ``.

Expose something like:
```ts
export function formatSubmissionPublicId(code: string | null, seq: number): string {
  return `${(code || "SUB").toUpperCase()}-${String(seq).padStart(4, "0")}`;
}
```
and have `createSubmission` (or a new `allocateSubmissionPublicId(form)` in queries)
do the transactional increment + formatting, returning both the `public_id` and the
`submission_seq`.

### 2. `createSubmission(form, publicId, answers)` → change signature

Currently: `createSubmission(form, publicId, answers)` where the caller builds
`publicId`. Move the allocation **into** `createSubmission` so it's always correct:

```ts
export async function createSubmission(form: Form, answers): Promise<SubmissionDetail> {
  const { publicId, submissionSeq } = await allocateSubmissionPublicId(form.id, form.code);
  // INSERT with public_id + submission_seq
}
```
This keeps the webhook and the in-app POST both correct without duplicating logic.

### 3. Callers

- `routes/submissions.ts` POST `/` — stop calling `newPublicId()`; pass `answers` only.
- `routes/webhook.ts` POST `/google` — same.
- Remove `newPublicId()` from `schema.ts` (and its imports) or repurpose it.

### 4. `getSubmissionDetail` / `getSubmissionByPublicId` — no change

These already query by `public_id`. Since we keep `public_id` as the key, lookups
continue to work with the new format unchanged.

## Backfill of existing rows

Existing submissions (including the seeded reference
`7bea2443-a5bb-4e40-a5c2-95034718fdd3`) have hex `public_id`s. On deploy:

1. For each form, determine the current `MAX(submission_seq)`/initial counter from the
   count of existing submissions, and set `forms.submission_seq` accordingly (e.g. set
   it to the number already created so the next number continues correctly).
2. For each existing submission (ordered by `submitted_at`, then `id`), assign
   `submission_seq` = a running per-form counter, and set
   `public_id = code-SEQ`. Because each form's counter is distinct and code is unique
   (Option A), no collisions occur.
   - Forms with no `code` yet get `SUB-SEQ`.
3. Run this backfill **once** (guarded by "only update rows where `public_id` still
   looks like hex", e.g. `WHERE public_id NOT LIKE '%-%'` or `submission_seq IS NULL`),
   so re-running is a no-op. Store the backfill as a small migration script
   (e.g. `scripts/backfill-submission-ids.sql` or a one-time node script in `db/`).

## Frontend / UX changes

No route or type shape changes (public_id stays a string). Only note:

- `ParentConfirmation` — the copy "keep this Submission ID safe" still works; it now
  shows `CDM-1001` instead of a long hex string. Consider adding the form code context.
- `StaffQueue` / `StaffSubmissionDetail` / `AdminDashboard` — display already shows
  `public_id`; it will simply render the new format. Row keys still use `public_id`.
- Optionally surface the numeric `submission_seq` if it needs sorting/filtering
  independent of the string.

## Swagger / types / seed

- `swagger.ts` — `public_id` params remain `string`. Add `forms.code` + `submission_seq`
  and `submissions.submission_seq` to schemas if they're exposed.
- `types/index.ts` — add `code?: string | null` to `Form` (client) and
  `submission_seq: number | null` to `Submission` as needed. Keep `public_id: string`.
- `seed.ts` — replace the hardcoded hex `PUBLIC_ID`; either generate `CDM-1001` for
  the reference submission or leave it to the backfill. Ensure the CDM form gets
  `code = 'CDM'` and `submission_seq` initialized.

## Edge cases to handle

- **Concurrency**: handled by `UPDATE ... OUTPUT` (atomic row lock). Never compute
  `MAX(seq)+1` in application code.
- **Code edits after submissions exist**: if an admin renames a form's `code`, existing
  `public_id`s retain the old prefix (they're immutable strings). This is acceptable;
  new submissions use the new code. Optionally warn in the designer if code changes
  after submissions exist.
- **Missing code**: fallback prefix `SUB`.
- **Very large numbers**: `padStart(4)` already accommodates ≥1000; the format naturally
  grows to `CODE-10000` for larger counts.
- **Non-alphanumeric code**: sanitize to `[A-Z0-9]` on save so it's URL/path-safe.

## Verification plan

1. `tsc --noEmit` in both `server` and `client`.
2. Create two submissions on the CDM form → expect `CDM-1001`, `CDM-1002`.
3. Confirm incrementing across a server restart (counter in DB, not memory).
4. Fire a few concurrent submissions (e.g. `Promise.all` of 3 POSTs) → assert 3 distinct
   ids (no dupes, no gaps).
5. Confirm parent URL `/submission/CDM-1001` and `/org/:slug/submission/CDM-1001` load.
6. Confirm admin `/admin/submissions/CDM-1001` and staff `/staff/CDM-1001` detail load.
7. Backfill run: existing hex rows converted; re-run is a no-op.
8. Swagger shows the same `{publicId}` param paths; `public_id` type unchanged.

## Open decisions (confirm before implementation)

1. **Uniqueness strategy** — recommend **Option A** (global-unique `forms.code`).
   Confirm you're OK that two orgs can't both have a form with the same code.
2. **Prefix source** — recommend dedicated editable `forms.code` field (default from
   title). Confirming this is a new field in the Form Designer.
3. **Number format** — `CDM-1001` (4-digit zero-pad) as in your example. Confirm the
   pad width / starting number (start at `1001` vs `1`).
4. **Store `submission_seq` column** on submissions (recommend yes: enables
   sort/filter without parsing) vs. only baking it into `public_id`.
