# Plan — Automatic "School Year" on Submission Details

> **Status:** Draft for review
> **Date:** 2026-09-01
> **Audience:** Product & Engineering review

---

## 1. Goal

On the **submission detail** page (the one rendered by
`client/src/pages/staff/StaffSubmissionDetail.tsx`, reached from both
`/admin/submissions/:publicId` and `/staff/:publicId`), the card currently shows a
**Submission ID** and a **Submission Time**. Add a **School Year** value immediately
**below the Submission Time** so a staff member can tell at a glance which academic year
a submission belongs to.

The value is **derived from the submission's timestamp** using a simple rule based on the
school year running **August 1 → July 31** (so `8/1/2026 – 7/31/2027` is one full year):
- If a date falls in **August–December**, it belongs to the school year that **starts
  that year** (`YYYY-YYYY+1`).
- If a date falls in **January–July**, it belongs to the school year that **started the
  prior year** (`YYYY-1-YYYY`).

Examples (school year = Aug 1 → Jul 31):
- `9/1/2026` → **2026-2027**
- `8/1/2026` → **2026-2027** (first day of the school year)
- `1/15/2027` → **2026-2027**
- `7/31/2027` → **2026-2027** (last day of the school year)
- `6/15/2026` → **2025-2026**
- `8/1/2027` → **2027-2028**

## 2. Requirements / non-goals

### Requirements
- Automatically **capture** (and display) the school year for every submission.
- Display it **below the Submission Time** on the submission detail card.
- The school year is a pure function of the submission's own `submitted_at` — it is
  a **snapshot**, not something that re-flips when the calendar rolls over. A submission
  made in June 2026 stays "2025-2026" forever.
- The rule must be **idempotent / re-runnable** (deploy-safe).

### Non-goals / constraints (this pass)
- **Only the detail card changes.** The staff queue (`StaffQueue`) and admin grid
  (`AdminDashboard`) list columns, and the **Export** CSV, are NOT changed here. They can
  surface the year later (see §11).
- **No new form field.** The school year is a system-derived attribute, not something a
  parent fills in.
- **No per-school boundaries yet.** One global rule (August 1 default) — see §4.3 and
  Open Decisions.

### Existing rows — **yes, they get the year too**
This is **not** a new-submissions-only feature. The plan includes a **one-time backfill** so
**every existing submission** (including the `CDM2-00015` example) also gets a `school_year`
stamped from its own `submitted_at`. It runs **automatically on deploy** (idempotent SQL in the
DDL list), and a **standalone script** is also provided for running it on demand / auditing.
The year for an existing row is derived from *that row's* `submitted_at`, so a submission made
in June 2026 correctly gets `2025-2026`, NOT the current date's year.

## 3. Current state (what `submitted_at` touches)

| Layer | Location | Note |
|---|---|---|
| DB | `submissions.submitted_at DATETIME2 NOT NULL` default `SYSUTCDATETIME()` | UTC; set once on insert, never updated |
| Row shape | `server/src/db/schema.ts` `Submission` interface | `submitted_at: Date` |
| Read queries | `server/src/db/queries.ts` `listSubmissions` + `getSubmissionByPublicId` | both `SELECT s.submitted_at, ...` |
| Detail | `server/src/db/queries.ts` `getSubmissionDetail` | composes the row, no year today |
| Client type | `client/src/types/index.ts` `Submission` | `submitted_at: string` |
| Display | `client/src/pages/staff/StaffSubmissionDetail.tsx` (~lines 304–308) | `new Date(detail.submitted_at).toLocaleString()` |

`submitted_at` is the single source of truth for the year. It is stable (never edited), so
deriving the school year from it is deterministic.

## 4. Key design decisions

### 4.1 The rule — `schoolYearForDate`

**Boundary = August 1** (the school year runs Aug 1 → Jul 31).

```ts
// server/src/db/schema.ts (or a small shared util)
export function schoolYearForDate(date: Date, boundaryMonthIdx = 7): string {
  // Use UTC accessors so it matches SYSUTCDATETIME() (the value stored in submitted_at).
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth(); // 0-indexed (Jan=0 … Dec=11)
  const start = m >= boundaryMonthIdx ? y : y - 1; // Aug–Dec => this year; Jan–Jul => prior year
  return `${start}-${start + 1}`;
}
```

Default boundary = **August** (`boundaryMonthIdx = 7`, i.e. `getUTCMonth() >= 7`). This is the
single knob. Because the school year is a **complete year (Aug 1 → Jul 31)** and the boundary
is a month (not a day), `8/1` and `7/31` both map correctly: Aug–Dec start this year; Jan–Jul
start the prior year. If the district ever needs a specific day of a month (e.g. Aug 15), see
§13.

### 4.2 Store vs. compute — **recommend storing a `school_year` column**

Two viable approaches. **Recommendation: denormalize a `school_year` column on
`submissions`**, populated at insert time and backfilled once.

**Option A (recommended) — store `school_year` on `submissions`**
- Matches the request's "automatically **capturing**" intent.
- Gives a **stable snapshot** even if the boundary rule changes later (old submissions keep
  the year they were captured under).
- Makes the year **queryable / filterable** (e.g. future "show 2026-2027 submissions")
  without a CASE expression in every SELECT, and enables a future index.
- Consistent with existing denormalizations (`submission_seq`, `organization_id`).
- **Downside**: needs a one-time backfill for existing rows (see §9), and the insert must set
  the column.

**Option B (lighter) — compute on the fly in the SELECT**
- Add a `CASE` expression (or compute in TS after fetch). No schema change, no backfill.
- **Downside**: if the boundary rule is ever changed, every historical submission *recomputes*
  (no snapshot). Can't index/filter without repeating the expression. Not really "captured".

**Outcome:** Go with **Option A**.

### 4.3 Boundary scope — global vs. per-school

The `schools` table already has a `calendar` column. This plan uses a **single global
August 1 boundary** (per the example: the school year runs Aug 1 → Jul 31). A future
enhancement could key the boundary off `schools.calendar` (e.g. a "traditional" vs
"year-round" school year), but that is out of scope here and is captured in Open Decisions.

## 5. Schema change (SQL Server, idempotent per `COL_LENGTH` guard)

Add to the DDL list in `server/src/db/schema.ts` as its **own batch**:

```sql
IF COL_LENGTH('dbo.submissions', 'school_year') IS NULL
  ALTER TABLE dbo.submissions ADD school_year NVARCHAR(9) NULL;
```

`NVARCHAR(9)` fits `"2026-2027"` exactly. Nullable so the migration is additive and
backward-compatible; existing rows are stamped by the backfill (§9), and new rows are stamped
on insert (§6).

## 6. Backend changes

### 6.1 Helper — `server/src/db/schema.ts`

Add `schoolYearForDate` (from §4.1) next to `formatSubmissionPublicId`. Export it.

### 6.2 `createSubmission` — `server/src/db/queries.ts`

In the `INSERT INTO dbo.submissions (...)` inside `createSubmission`, add the `school_year`
column and compute it from UTC now:

```ts
const schoolYear = schoolYearForDate(new Date());

const subs = await execute<Submission>(
  `INSERT INTO dbo.submissions (public_id, form_id, school_id, organization_id, status, submission_seq, school_year)
   OUTPUT INSERTED.id, INSERTED.public_id, ..., INSERTED.submitted_at, INSERTED.updated_at
   VALUES (@publicId, @formId, @schoolId, @organizationId, 'submitted', @submissionSeq, @schoolYear)`,
  { publicId, formId: form.id, schoolId, organizationId: form.organization_id, submissionSeq, schoolYear }
);
```

> **UTC note:** `submitted_at` is `SYSUTCDATETIME()` (UTC) and `schoolYearForDate` uses UTC
> accessors, so they agree. If the app and DB clocks are ever not UTC-aligned, the year could
> differ at the exact boundary — acceptable and noted in §10. For exactness we could instead
> UPDATE the year from `OUTPUT INSERTED.submitted_at`, but that adds a round-trip for a
> sub-second-safe value.

### 6.3 Read queries — `listSubmissions` and `getSubmissionByPublicId`

Add `s.school_year` to the `SELECT` column list in **both** functions (they currently select
`s.submission_seq, s.submitted_at, ...`). This makes the year available on the row and the
composed `SubmissionDetail` automatically.

### 6.4 Row shape — `server/src/db/schema.ts`

Add `school_year: string | null;` to the `Submission` interface (mirrors the new column).
`SubmissionDetail` and `SubmissionRow` both build on `Submission`, so they inherit it.

## 7. Frontend changes

### 7.1 Client type — `client/src/types/index.ts`

Add to the `Submission` interface:

```ts
school_year: string | null;
```

### 7.2 Detail card — `client/src/pages/staff/StaffSubmissionDetail.tsx`

Immediately **below** the existing "Submission Time" field (currently ~lines 304–308):

```tsx
<div className="field">
  <span className="f-label">Submission Time</span>
  <span className="f-value">
    {new Date(detail.submitted_at).toLocaleString()}
  </span>
</div>
<div className="field">
  <span className="f-label">School Year</span>
  <span className="f-value">
    {detail.school_year || "—"}
  </span>
</div>
```

The em dash fallback covers legacy rows if a backfill hasn't run; after §9.2 all rows have a
value.

## 8. Swagger

If `school_year` should be documented in the API response, add it to `server/src/swagger.ts`
schemas for the submission detail/list payloads (`string`, nullable). The request bodies are
unchanged — this is an output-only field.

## 9. Backfill of existing rows + a dedicated script

Two paths cover **both new and existing** rows:

### 9.1 New rows — stamped on insert (§6.2)
`createSubmission` sets `school_year` at insert time. No further action needed for any
submission created after the feature ships.

### 9.2 Existing rows — one-time backfill

Existing submissions predate the column. Stamp them with a **single idempotent** SQL migration
(safe to re-run). Two ways to run it:

**Option 1 (recommended) — automatic on deploy.** Add it to the DDL list in `schema.ts` (its
own batch, after the column add) so it runs automatically whenever `runDdl()` executes:

```sql
UPDATE dbo.submissions
SET school_year =
  CASE
    WHEN MONTH(submitted_at) >= 8
      THEN CAST(YEAR(submitted_at) AS nvarchar(4)) + '-' + CAST(YEAR(submitted_at) + 1 AS nvarchar(4))
    ELSE CAST(YEAR(submitted_at) - 1 AS nvarchar(4)) + '-' + CAST(YEAR(submitted_at) AS nvarchar(4))
  END
WHERE school_year IS NULL OR school_year = '';
```

Guard `WHERE school_year IS NULL OR school_year = ''` makes re-runs a no-op. `MONTH()` returns
1–12, so August = 8 (consistent with the TS helper where `getUTCMonth()` returns 7 for August).

**Option 2 — standalone script `server/src/db/backfill-school-year.ts`.**

Follows the existing `backfillSubmissionIds()` pattern in `pool.ts` (and the `seed.ts` style) so
it can be run on demand (e.g. after a manual import, to audit, or if a row was missed). Add a
`"backfill:school-year": "tsx src/db/backfill-school-year.ts"` script to `server/package.json`.

```ts
// server/src/db/backfill-school-year.ts
import { initDb, getPool } from "./pool.js";
import { schoolYearForDate } from "./schema.js";

async function backfillSchoolYear() {
  await initDb();
  const pool = await getPool();
  // Fetch rows that still need a year (legacy / NULL). Do it in batches so we
  // don't pull the whole table into memory.
  const rows = await pool.request().query(
    `SELECT id, submitted_at FROM dbo.submissions
     WHERE school_year IS NULL OR school_year = ''
     ORDER BY submitted_at ASC`
  );
  let updated = 0;
  for (const r of rows.recordset) {
    const year = schoolYearForDate(new Date(r.submitted_at));
    await pool.request()
      .input("id", r.id)
      .input("year", year)
      .query(`UPDATE dbo.submissions SET school_year = @year WHERE id = @id`);
    updated += 1;
  }
  // eslint-disable-next-line no-console
  console.log(`[backfill] Updated ${updated} submission(s) with a school year.`);
}

backfillSchoolYear()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[backfill] Failed:", err);
    process.exit(1);
  });
```

> **Why both?** The automatic DDL migration guarantees existing rows are stamped on deploy and
> is idempotent; the standalone script is a safety net / audit tool and mirrors the existing
> `backfillSubmissionIds()` pattern. Using the **same TS helper (`schoolYearForDate`) in both**
> keeps the backend and the script consistent — no risk of the SQL `CASE` and the TS function
> drifting apart. (If you prefer a single source of truth, you can drop the inline SQL `CASE`
> and just run the script once.)

> **Ordering:** the `UPDATE` must run **after** the column-add batch (it references the new
> column) — SQL Server compiles each batch separately, so keep them as separate DDL entries.

## 10. Edge cases

- **Historical rows:** stamped once by the backfill; deterministic from `submitted_at`.
- **Boundary midnight / timezone:** `submitted_at` is UTC and the rule uses UTC accessors, so a
  submission at local 8 PM on Jul 31 in a UTC-5 zone lands at 1 AM Aug 1 UTC and is assigned the
  *new* year. If that's undesirable, define a per-org timezone (future). Documented, not handled now.
- **Rule change later:** because the year is a stored snapshot, old submissions keep their
  captured year even if the boundary constant changes. New submissions use the new rule. This is
  the intended behavior of Option A.
- **NULL year fallback:** client renders `"—"` if a legacy row somehow missed the backfill.

## 11. Optional future extensions (NOT in this pass)

- Add a **"School Year" column** to the staff queue (`StaffQueue`) and admin grid
  (`AdminDashboard`).
- Add a **"School Year" column** to the Export preview/CSV (and a filter by year on the list
  endpoints).
- Index on `(organization_id, school_year)` if filtering by year becomes a hot path.
- Per-school boundary via `schools.calendar`.

## 12. Verification plan

1. `tsc --noEmit` in both `server` and `client`.
2. Deploy / run migration → confirm `dbo.submissions.school_year` exists and existing rows are
   stamped (query a row, check `school_year` matches `submitted_at`).
3. **Existing rows specifically** — query `CDM2-00015` (and any June-2026 row) and confirm its
   `school_year` reflects *its own* `submitted_at`, not today's date (e.g. a June 2026
   submission → `2025-2026`).
4. Submit a new submission → confirm `school_year` set on insert.
5. Open `/admin/submissions/<id>` (and `/staff/<id>`) → confirm **School Year** renders below
   **Submission Time** with the correct `YYYY-YYYY` value (not `"—"`).
6. Re-run the backfill (either the DDL migration via a fresh deploy **or** the standalone
   `npm run backfill:school-year` script) → confirm it's a no-op (no errors, values unchanged,
   `Updated 0 submission(s)`).
7. Optional: filter/render a `school_year` value in a quick API call for both an admin and a
   school-scoped staff viewer.

## 13. Open decisions (confirm before implementation)

1. **Boundary month/day** — the school year is **Aug 1 → Jul 31** as you described. The default
   rule uses a **month-only boundary at August** (`getUTCMonth() >= 7`), which correctly maps
   both `8/1` and `7/31`. Confirm you're happy with a month-only cutover, or whether a specific
   day is required (e.g. the year actually starts Aug 15). If a day is needed, the rule becomes
   `(month > AUG) || (month === AUG && day >= D)`.
2. **Store vs compute** — recommend **store** (`school_year`). Confirm you're OK adding the
   column + one-time backfill rather than computing on read.
3. **Existing rows** — both new and existing rows get a year. Confirm the **target approach** for
   existing rows: (a) auto-migration in the DDL list (recommended, runs on deploy), (b) a
   standalone `backfill:school-year` script, or **(c) both** (recommended). The plan currently
   proposes **both**.
4. **Scope** — only the detail card this pass. Confirm the queue/grid/export columns are
   deliberately deferred (or bump them into scope).
5. **Global vs per-school boundary** — global **August 1** for now; `schools.calendar` is the
   future knob. Confirm global is sufficient.
6. **UTC boundary** — the year rule uses UTC to match `submitted_at`. Confirm this is acceptable
   (vs. defining a school-local timezone).
