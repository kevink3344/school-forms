# School id-space repair — review packet

**Status:** ✅ **APPLIED to production on 2026-10-01. 17 users + 33 submissions rewritten. Both tools re-run and converged to zero remaining changes; a scoping probe confirms the symptom is gone.** The evidence and the review below are kept as written (they are the record of *why*), with the applied outcome appended in §10.
**Date:** 2026-10-01
**Related:** `role-migration-2026-09-24.md`, `restore-archived-submissions-2026-09-24.md`, `document-list.md:45`, `deploy-azure.md:43/45`

---

## 1. The symptom that started this

A School Contact (`#18`, `cdm_contact`, `school_id` **185**) opens Reports after an admin set
her school to *Vernon Malone College and Career Academy*, and sees **one row belonging to another school**:

| | value |
|---|---|
| row | `#35 CDM2-00023` — Nicolas Otero, 2010-10-14, id 9833418325 |
| School **answer** (what the cell renders) | `Wake STEM Early College High School` |
| stored `submissions.school_id` | **185** |

Her account is correctly scoped. The row is correctly in scope. Both are correct **in a numbering where 185 means Wake STEM**.

---

## 2. Root cause

**The app was pointed at `wcpss-sql-serverless-freetier` / `school-form-data` until ~2026-09-29, then switched to
`wcpsssqlelasticpool` / `wcpss-google-forms` (confirmed with the user).** The two databases hold the **same 235
school names** but number **128 of them differently**. Ids written before the switch were never translated.

### The two numberings

`tmp-db-diff.out.txt` — delta histogram over the 235 names (production id − `school-form-data` id):

```
{"0":107, "1":125, "50":1, "-149":1, "-26":1}
```

| delta | schools | meaning |
|---|---|---|
| `0` | 107 | numbered identically — everything up to and including **Centennial Middle (49)** |
| `+1` | 125 | production is exactly one higher — from **Combs (50)** through the end |
| `-149` | 1 | `M-18 @ Woods Creek Elementary Site` — **53** in production, **202** in `school-form-data` |
| `+50` | 1 | `Parkside Middle School Site` — **103** in production, **53** in `school-form-data` |
| `-26` | 1 | one further single-name offset |

The two rosters are ordered differently around M-18 @ Woods Creek and Parkside, which shifts everything after them.
**This is a roster-order difference, not a bug in any lookup.**

### The pivot date

| submitted / updated | stored id | answer | answer's id today | verdict |
|---|---|---|---|---|
| 2026-09-21 … 09-28 | legacy id | — | — | **24 rows in the old space** |
| **2026-09-30** | 165 | Salem Middle | 165 | correct ✓ |
| 2026-09-30 | 106 | Holly Grove Middle | 106 | correct ✓ |
| 2026-10-01 | 121 | Lufkin Road | 121 | correct ✓ |
| 2026-10-01 | 121 | Lufkin Road | 121 | correct ✓ |

Per-row classification of all 83 production submissions:

```
{"OLD":24, "PROD":4, "both":33, "neither":22}
```

`OLD` = stores the id the answer has in `school-form-data`. All 24 fall in **2026-09-21 → 09-28**. The 4 `PROD`
rows are the only ones dated ≥ 09-30. **The divergence is a closed historical period, not an ongoing bug.**

### Why the users still *appear* to work

The **users are in the old space too** — which is why contacts have been seeing their own rows. Production id
`185` is Vernon Malone; `#18` held `184`. In the legacy numbering, 184/185 are **Lufkin Road** and **Wake STEM**;
Vernon Malone is 185. Until the admin edited her, Tracy's `184` was an id that points at *nothing she owned*.

### Confirmed NOT the cause (all measured)

- **No trigger** — `sys.triggers` on `dbo.submissions` is empty.
- **No schools renumbering** — every `schools` row has `created_at` on one day (2026-08-27), `COUNT(DISTINCT created_at) = 235`, 0 `id`↔`source_id` inversions. The upsert never writes `created_at`, so a re-import would show a new date. It doesn't.
- **No duplicate school field** — form 2 has 19 fields, exactly one school-labelled (`#11` "School").
- **No source_id/id confusion** — Alston Ridge (`id` 16, `source_id` 15) correctly stores **16**.
- **Not an edit-after-derivation** — many divergent rows have `updated_at === submitted_at` and never touched staff fields.
- **`COALESCE(answer, schools.name)` is by design** (`document-list.md:45`) — the column is the *answer*; `school_id` is the *scope*. They legitimately can differ.

---

## 3. Blast radius

### Submissions — 24 rows in the wrong space

By school: Lufkin Road **8**, Salem Middle **7**, Wake Young Women's **4**, North Garner **3**, West Lake Middle **1**, Wake STEM **1**.

### Users — 17 accounts in the wrong space

Scoped to a school that renamed underneath them (`production now says` column):

| current | production says | legacy (intent) says | → | user |
|---|---|---|---|---|
| 105 | Holly Grove Elementary | Holly Grove Middle | 106 | jcuccurullo |
| 120 | Lockhart Elementary | Lufkin Road Middle | 121 | hoxendine |
| 122 | Lynn Road Elementary | Martin Middle | 123 | rwest2 |
| 124 | Middle Creek Elementary | Middle Creek High | 125 | tgillespie2 |
| 128 | Mills Park Elementary | Mills Park Middle | 129 | hmilligan |
| 130 | Morrisville Elementary | Moore Square Middle | 131 | wwheeler3, key.kevin |
| 135 | North Ridge Elementary | North Wake C&CA | 136 | mwalter |
| 145 | Mary E Phillips High | Pine Hollow Middle | 146 | jstern |
| 158 | Rolesville Elementary | Rolesville Middle | 159 | kbowling |
| 164 | Salem Elementary | Salem Middle | 165 | jhowland |
| 175 | South Garner High | Southeast Raleigh High | 176 | plprice |
| 185 | Vernon Malone C&CA | Wake STEM Early College | 186 | rhaymore |
| 188 | Wake Forest Elementary | Wake Young Men's Leadership | 189 | lhetzell |
| 189 | Wake Young Men's Leadership | Wake Young Women's Leadership | 190 | scmckay |
| 206 | West Lake Elementary | West Lake Middle | 207 | ekleimeyer |
| 207 | West Lake Middle | West Millbrook Middle | 208 | klarsen |

**17 REMAP · 1 SKIP · 22 no change (same school in both spaces).** The 22 are at schools numbered identically in
both databases, so their scoping was never wrong.

**Tracy is protected by the guard, not hard-coded:** the 2026-09-24 doc recorded `184`, she now holds `185`
(the admin's edit) → `SKIP — school edited since 2026-09-24, human value wins`.

---

## 4. Active data loss (why this is not cosmetic)

Because contacts and rows were both in the old space, contacts saw their own rows — **but every submission since
09-30 is invisible to them**, because new rows get the *new* ids:

- **hoxendine** holds `120` → sees her 8 legacy Lufkin rows. The 2 new Lufkin rows (`CDM2-00313/00314`, 10-01) are stored at `121` → **she cannot see them.**
- Same already true for Holly Grove Middle (106, 1 row) and Salem Middle (165, 1 row).
- **Any admin editing a user's school drops them into the new space and hands them the neighbouring school's rows** — exactly what happened to Tracy.

---

## 5. Proposed writes

Repairs run in this order — users first (so nobody is left with no scope), then submissions.

### Step 1 — users: `users.school_id`

Mapping is **name-based, never arithmetic**: `legacy name (old db) → find that name in production → new id`.
That single rule handles the +1 shift *and* both outlier pairs (Parkside, M-18 @ Woods Creek) with no offsets
hard-coded.

Exemption guards (in priority order), both printed per row:
1. `created_at >= 2026-09-29` → resolved against production already → **skip**.
2. `school_id <> the 2026-09-24 doc reading` → edited by a human since → **skip** (protects Tracy).
3. School named identically in both → **no change**.
4. Legacy name not found in production → **unresolved**, left alone and reported.

Dry run: **17 to remap (16 distinct ids), 1 skip, 22 no change, 0 unresolved.**

### Step 2 — submissions: `submissions.school_id`

Via the existing `npm run backfill:school-id` (dry run) / `-- --apply`. It re-derives `school_id` from the School
answer, is idempotent, and never invents a school.

Dry run: **24 to change, 37 already correct, 13 unresolved** — and the 24 targets line up exactly with the user
table above (Lufkin 120→121 ×8, Salem Middle 164→165 ×7, Wake Young Women's 189→190 ×4, North Garner 132→133 ×3,
West Lake 206→207 ×1, **Wake STEM 185→186 ×1 = row #35**).

### Step 3 — the 9 unresolved rows that are real

The tool refuses to guess, so these need explicit confirmation. Each has exactly one plausible target:

| answer written in the form | rows | current | proposed | note |
|---|---|---|---|---|
| `Moore Square Magnet Middle School` | #62, #67, #75 | 130 | **131** Moore Square Middle | ⚠️ **required** — their contacts move 130→131, so without this they **lose 3 rows they can see today** |
| `Vernon Malone College & Career Academy` | #91 | 1 | **185** Vernon Malone C&CA | ⚠️ **required** — this is Tracy's genuine Vernon Malone row; it is invisible to her today |
| `Herbert Akins Middle School` | #53, #56, #60, #93 | 1 | **82** Herbert Akins Road Middle | 4 submissions nobody can open today |
| `Southeast Raleigh Magnet High School` | #64 | 1 | **176** Southeast Raleigh High | plprice's school after the remap |

The other 4 unresolved rows are test data and should stay on the form's fallback:
`Test School` (#10), `Test Middle School` (#16), `Slack Verify School` (#22), `Option 23` (#31).

### Net effect on Tracy

| | before | after |
|---|---|---|
| rows in scope | `#35` (Wake STEM — wrong school) | `#91` (Vernon Malone — correct school) |

She keeps a count of 1 and it becomes truthful.

---

## 6. What is NOT being written

- No `schools` rows — the `schools` table is correct and untouched. Names are unique (0 duplicates), which is what makes name mapping safe.
- No `users.role`, `organization_id`, `school_id` for the 22 correct accounts, or Tracy.
- No writes at all until the alias table is confirmed and the dry runs are re-read.
- `.env` untouched further; the doc defect at `deploy-azure.md:43/45` remains (flagged, not edited).

---

## 7. Open question for the reviewer

The alias table has to live somewhere. Two options:

- **(a) Backfill tool only** — explicit, re-runnable, but a *new* submission that types
  "Moore Square Magnet Middle School" still lands on Sample School until someone re-backfills.
- **(b) Also `resolveSubmissionSchoolId`** — fixes future inserts too, but changes live insert behaviour and needs its own review.

Recommendation: **(a) now, (b) as a separate change.**

---

## 8. Verification after applying

1. Re-run `tmp-user-migrate.ts` → expect **0 REMAP**.
2. Re-run `npm run backfill:school-id` → expect **0 to change**.
3. Assert no submission ends up with a `school_id` naming a school its answer does not name.
4. Assert every user's scope is non-empty and names their intended school.
5. Delete the probe files (`tmp-*.ts`, `tmp-*.out.txt`).

---

## 9. Instrument list (all read-only, deleted after use)

`tmp-db-diff.ts` (two-database roster diff + per-row classification) · `tmp-user-space.ts` (per-user id space +
per-school impact) · `tmp-user-migrate.ts` (users dry run) · `tmp-unresolved.ts` (unresolved-row forensics) ·
`tmp-verify-scope.ts` (post-apply scoping check) — plus the earlier `tmp-prod-*` and `tmp-schooldb*` probes,
and their `.out.txt` outputs. **All deleted on 2026-10-01.**

---

## 10. Applied — outcome (2026-10-01)

### What was run

```
npm run backfill:user-school-id -- --apply   # updated 17 user(s).
npm run backfill:school-id    -- --apply     # updated 33 submission(s).
```

**Users first, deliberately** — so no contact was ever left scoped to a school id outside the live space while
their rows were still being moved.

The submissions run wrote **33**, not the 24 the dry run originally listed, because the alias table (§5 step 3)
resolved **9** rows that had previously been unreachable — including Tracy's genuine row `#91`
(*"Vernon Malone College & Career Academy"*, the `&` spelling). Four remain untouched and **are test data**:
`#10` "Test School", `#16` "Test Middle School", `#22` "Slack Verify School", `#31` "Option 23".

### Verification

| Check | Result |
|---|---|
| `backfill:user-school-id` re-run | **0 REMAP** — 22 "same in both spaces", 18 "already in the live id space" |
| `backfill:school-id` re-run | **0 to change**, 70 already correct, 4 (test rows) unresolved |
| Submissions filed under a school their answer does not name | **0** |
| that School Contact (185 = Vernon Malone) | sees **exactly 1** row, **`#91`** — and **no longer `#35`** |
| rhaymore (186 = Wake STEM) | sees **`#35`**, which is genuinely a Wake STEM submission |
| hoxendine (121 = Lufkin Road) | sees **all 10** Lufkin rows, **including the two new ones `#103`/`#104`** that were previously invisible to her |

### ★ A real defect the verification caught

The *first* re-run did **not** converge: it reported **1 REMAP** and mislabelled the 16 repaired accounts as
*"skip: school edited since 2026-09-24"*.

Cause: the translation maps an **id space, not an id**. Applied to an already-repaired account it reproduces the
same `+1` shift and produces the *next* school along the list. The 16 accounts happened to be protected by their
2026-09-24 reading, but the one account with **no reading** (`key.kevin`) was reported as wanting to move
`131 → 132`, and would have walked `133`, `134`, … on every future run.

Fix: an explicit **`intendedName` test** — the school the account's reading points at — evaluated *before* the
editing guard, so a repaired account and a hand-edited one can be told apart. `key.kevin`'s pre-repair id was
recorded in `READING_PRE_REPAIR`. **This is now the third independent confirmation of the decisive role of the
2026-09-24 readings**: they are what makes "repaired by the tool" distinguishable from "changed by a human".

### Still open

- §7 (a)/(b): the alias table lives only in the backfill, so a *new* submission typed
  "Moore Square Magnet Middle School" still lands on Sample School until someone re-backfills. Left as the
  recommended separate change.
- `deploy-azure.md:43/45` still names the legacy server/database as production. Flagged; not edited.
- **Local dev now writes to production** — `.env` points at `wcpsssqlelasticpool`. Note `tsx watch` does not
  reload `.env`; restart it after any change.
