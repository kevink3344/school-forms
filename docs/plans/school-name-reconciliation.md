# Plan — Settings → School Name Matching (admin-confirmed school aliases)

**Status:** Implemented (2026-10-04) — see §17 for what shipped and the two deviations from this draft.
**Date:** 2026-10-04
**Area:** School routing (intake) + Admin Settings. New `dbo.school_name_aliases` table; a
`CollapsibleSection` on `/admin/settings`; a "Match school" drawer.
**Related plans:** [`school-name-mismatch.md`](./school-name-mismatch.md) (the *flag*; this is the
*remedy* it pointed to — and implements its follow-ons #3/#4/#5), [`school-id-space-repair.md`](./school-id-space-repair.md),
[`school-import.md`](./school-import.md), [`organizations.md`](./organizations.md) §1.5 (schools are shared),
[`roles-settings.md`](./roles-settings.md) (the "a role added later must not be silently excluded" precedent),
[`dual-db.md`](./dual-db.md) (the two-dialect DDL checklist).
**Depends on:** nothing that is not in the tree today. If [`school-name-mismatch.md`](./school-name-mismatch.md)'s
`school-match.ts` lands first, this plan reuses its `declaredSchoolName` reconstruction instead of
duplicating it (see §11 Q5).

---

## 1. What was asked

> "Sometimes, staff will not update the Google Form, so *Dillard Drive Magnet Middle School* will be
> submitted, but the app will have *Dillard Drive Middle School*. I don't want it auto-corrected, I
> want Admins to go in and say *'Match school submitted with this school from app'* and need to
> select a school. … Maybe something under settings."

Clarified in follow-up:

> "When a record is matched, that submission becomes the new school name with correct id for the
> logged in user to see it."

Four requirements, in the requester's own order of importance:

1. **Do not auto-correct.** No guessing, no fuzzy matching, no silent rewrites.
2. **An admin makes the match** — they see the submitted spelling, then choose the app school it means.
3. **When matched, the submission *becomes* that school** — its stored `school_id` **and** the school
   name the row displays — so that school's logged-in users actually see it in their queue.
4. **It lives in Settings.**

The sentence "I don't want it auto-corrected" is the constraint the whole design has to obey, and
§4.2 is where it is enforced. The rest of the plan is what makes requirement 2 *useful*: an admin's
decision should not have to be repeated for every future submission, and requirement 3 is what makes
it *visible* to the people who need the row.

> ⚠ Requirement 3 is not free. Correcting `school_id` fixes **access** (`canAccessSchool` reads it),
> but the School column does **not** render `school_id` — it renders the parent's typed answer
> (`dialect/sqlserver.ts:148`, turso equivalent). §4.4 therefore has **three** effects — two writes
> *and* a display fix; without the third the row is openable by the right school but still *labelled*
> with the typo.

---

## 2. ★ The one move the design turns on

> **A submitted spelling stops being a dead end the moment an admin pairs it with a school — and
> stays paired, so the same Google Form never asks the same question twice.**

One "Match" action has **two** effects, and the plan is built so they are the same write:

| effect | what it does | who it helps |
|---|---|---|
| **Learn** | records `submitted spelling → app school` in `dbo.school_name_aliases`, which intake now consults | every **future** submission from that form |
| **Repair** | re-files existing submissions carrying that spelling onto the chosen school — the stored `school_id` **and** the name the row displays — so that school's users can now open it and see it as theirs | the rows already stranded on the fallback |

This is the difference between **fixing the form** and **fixing the app**. The requester has already
told us the form will not be fixed ("staff will not update the Google Form"). So the durable fix is
on the app's side, and it must be a decision a human made — never a guess the app made for them.

### 2.1 Why the existing plumbing cannot do this yet

Today a submission's school is derived once, at insert (`server/src/db/queries.ts:2104`):

```
plan.schoolName  →  findSchoolIdByName(name)   ← exact, case-insensitive LOWER(name) lookup
                    ?? resolveSubmissionSchoolId(...)   ← same lookup over DEFINED fields
                    ?? form.school_id                    ← the silent fallback
```

`findSchoolIdByName` (`queries.ts:2036`) has **no alias step**. The one place in the repo that
*does* hold reviewed aliases — `SCHOOL_NAME_ALIASES` in `server/src/db/backfill-school-id.ts:58` — is
consulted **only** by that one-off shell script, never by live intake (the detection plan calls this
out at §A2). So:

- a submission that arrives with a near-miss spelling lands on the form's fallback *every time*;
- the fallback for a district-wide form is the placeholder (*Sample School*), which `school-id-space-repair.md`
  measured as stranding **9 real submissions "where nobody could open them"**.

The remedy in this plan is to make that alias step **part of live routing**, driven by rows an admin
created — not by a constant in a script.

## 3. What "an alias" means here — and what it must never mean

An **alias** is a pair written down by a human:

```
"dillard drive magnet middle school"  →  schools.id = <Dillard Drive Middle School>
```

It is stored, reviewable, and reversible. It is the opposite of a heuristic. The distinction matters
because this app routes *access* by school: `canAccessSchool` and every school-scoped listing compare
`submissions.school_id`, so a wrong match **silently grants a School Contact access to another
school's submissions**. `backfill-school-id.ts:42-57` argues the no-guessing rule at length, and the
detection plan's Q1 adopts it ("A flag asks a human; a guess decides for them"). This plan *is* that
human's decision, captured once and reused.

### 3.1 The principle the whole feature rests on

> ★ **The school list in the app is the single source of truth.** A parent's submitted spelling is
> only an *input* that maps **to** an app school — it is never itself treated as a school. Once a
> spelling is matched, the **app school's value takes precedence everywhere**: the stored
> `school_id`, the access checks, and the name the record displays.

Concretely, after an admin matches *"Dillard Drive Magnet Middle School"* to the app's
**Dillard Drive Middle School**:

| surface | shows | not |
|---|---|---|
| the record's School column | **Dillard Drive Middle School** | "Dillard Drive Magnet Middle School" |
| `submissions.school_id` | the app school's id | — |
| the queue of that school's users | the record **appears there** | — |
| the Settings panel | keeps the parent's spelling as the *key* ("submitted name"), beside the app school it maps to | — |

The parent's spelling survives only as the **alias key** (and as `declared_school_name`, the recorded
input). It is never the name of record once a match exists. This is what makes "match it" a *complete*
fix rather than a label on top of an unchanged row, and §4.4.1 is the display half of it.

---

## 4. Design

### 4.1 The mapping is data, not code

The four entries in `SCHOOL_NAME_ALIASES` are hand-reviewed pairings in a source file. That is fine
for a one-off script, but it is the wrong home for a mapping an admin makes at 3 p.m. on a Tuesday:
editing a constant requires a deploy and a code review for what is a data decision. So the mapping
goes in a **new table**, `dbo.school_name_aliases` (§5), and live intake reads it.

The existing constant is not thrown away. §11 Q1 covers whether its four reviewed rows are **seeded
into the table once** (recommended) so the live path benefits from them too; that is a data-seeding
decision, stated, not an implicit code path.

### 4.2 The "no auto-correction" guarantee — stated as three rules

This is the requirement, so it is written as rules a reviewer can check:

1. **No fuzzy, distance, phonetic or prefix matching exists anywhere in this feature.** The lookup is
   an exact `LOWER(TRIM(submitted_name)) = LOWER(TRIM(@name))` against a row an admin created. If no
   alias row matches, the answer resolves to **no school** — same as today — and falls to the fallback.
2. **An alias row cannot be created except by an admin's explicit "Match" action.** The table starts
   empty (modulo Q1's reviewed seed). Nothing infers a mapping from a near-miss.
3. **A spelling with no alias is still shown to the admin, unresolved** — it is never silently
   dropped or auto-satisfied. That is what the Settings worklist (§7) is for.

> ★ The word that makes this safe: an alias is a **decision**, not a **guess**. That is also why it
> may override school routing — the thing `backfill-school-id.ts` forbids for a *heuristic* — because
> the routing now follows a human's recorded intent.

### 4.3 One resolver, so intake and display cannot disagree

The detection plan's §5 names the hazard: three pieces of code hold an opinion about "which school
does this answer name", and if they disagree the feature lies. The same hazard applies the moment
aliases exist. So the alias step is added **inside the single lookup** every caller already shares:

```
findSchoolIdByName(name):
    exact LOWER(name) match
    ?? alias match   (LOWER(submitted_name) → school_id)     ← NEW
```

Because `findSchoolIdByName` is the function intake (`createSubmission`), `resolveSubmissionSchoolId`,
and the detail-page verdict all funnel through, adding the alias step here fixes **all three at once**
and keeps them from drifting. A thin exported `resolveSchoolByName(name): Promise<{id, name} | null>`
wraps it for callers that want the name (the worklist and the drawer preview do).

> ★ The one site that **cannot** funnel through a TypeScript function is the SQL display subquery
> (§4.4.1) — it builds the School column inside the list/detail query. It is a *sibling* of this
> resolver, not its child, and it must be kept in step by hand (a startup-parity test asserts both
> dialects carry the alias join, so a future edit to one cannot silently drop it). Naming that here is
> the honest version of "one resolver": one rule, two implementations, one test tying them together.

> ⚠ This is a **routing change**: consulting aliases at intake changes which school a submission is
> filed under, and therefore who can open it. That is the point — but it is the one genuinely
> consequential line in the plan, so §10 states its consequences plainly and §13 makes it its own
> rollout phase.

### 4.4 One "Match" action, three effects — the submission becomes the school

Matching a record is not only "learn it for later". The requester's follow-up is explicit: **the
submission becomes that school**. That is three effects, one gesture:

| # | effect | mechanism | who it serves |
|---|---|---|---|
| 1 | **Learn** | upsert an alias row (`school_name_aliases`) | future submissions |
| 2 | **Re-file (id)** | `UPDATE submissions SET school_id = @schoolId WHERE <declared name matches> AND (school_id IS NULL OR school_id <> @schoolId)` | **access** — `canAccessSchool` and every school-scoped listing read `school_id`, so the matched school's logged-in users now see the row |
| 3 | **Re-label (name)** | make the School column resolve the alias (§4.4.1) | **display** — the row shows the school's name, not the parent's typo |

Effect 2 is the one the follow-up is really about. Once `school_id` is the matched school, the
queue/list query — which already filters on `school_id` (`scopedSchoolId`, `routes/submissions.ts:152`)
— returns the row for that school's users, and `canAccessSchool` lets them open it
(`routes/submissions.ts:129`). **No new access code is needed; re-filing `school_id` is the whole fix.**

Effect 2 reuses the **guarded UPDATE** pattern from `backfill-school-id.ts:205-214`
(`dialect().updateReturning(...)` with a `<>` guard, counting returned rows as the affected figure,
because libSQL reports 0 affected rows for an `UPDATE … RETURNING`). It is therefore idempotent and
safe to re-run, and it cannot clobber a row changed between the read and the write. A row already on
the target school is left untouched.

> **Re-file is not a checkbox.** The earlier draft offered it as a "default-on" toggle; the follow-up
> removes that ambiguity — *matching a record makes it that school*. The panel still *shows* the count
> ("This will re-file **7** submissions") because an admin should know the blast radius, but the write
> is unconditional. If a future request is "learn only, do not touch history", that is a deliberate
> new option, not the default.

#### 4.4.1 The name, not just the id — the display must resolve the alias

★ This is the part that is easy to miss and would otherwise leave requirement 3 half-done.
`submissions.school_id` is **not** what the School column renders. It renders the parent's typed
answer, through `dialect().submissionSchoolNameSubquery()` (`dialect/sqlserver.ts:148`,
`dialect/turso.ts:627`):

```sql
-- today
(SELECT TOP 1 COALESCE(scs.name, sv.value)
   FROM dbo.submission_values sv
   JOIN dbo.form_fields ff ON ff.id = sv.field_id
   LEFT JOIN dbo.schools scs ON LOWER(scs.name) = LOWER(LTRIM(RTRIM(sv.value)))   -- exact name only
  WHERE sv.submission_id = s.id AND <schoolFieldPredicate> AND sv.value not blank
  ORDER BY ff.sort_order, scs.id)
```

wrapped by `COALESCE(<that>, sch.name)` in `getSubmissionByPublicId` (`queries.ts:1841`) and the list
query. On a matched-but-aliased row **the inner `sv.value` is non-NULL**, so the outer COALESCE never
reaches `sch.name` and the column keeps printing *"Dillard Drive Magnet Middle School"* — an id that is
right and a name that is wrong. So the subquery must learn the alias too — the SQL sibling of §4.3:

```sql
-- after (SQL Server; libSQL is identical apart from TOP 1 → LIMIT 1)
(SELECT TOP 1 COALESCE(scs.name, acs.name, sv.value)
   FROM dbo.submission_values sv
   JOIN dbo.form_fields ff ON ff.id = sv.field_id
   LEFT JOIN dbo.schools scs ON LOWER(scs.name) = LOWER(LTRIM(RTRIM(sv.value)))          -- exact match
   LEFT JOIN dbo.school_name_aliases a ON LOWER(a.submitted_name) = LOWER(LTRIM(RTRIM(sv.value)))
   LEFT JOIN dbo.schools acs ON acs.id = a.school_id                                     -- the admin's match
  WHERE sv.submission_id = s.id AND <schoolFieldPredicate> AND sv.value not blank
  ORDER BY ff.sort_order, scs.id)
```

Result: **exact name → alias name → raw typed text**, in that order. This is §3.1 expressed in SQL —
**for any resolved record the app school's name wins**, and the parent's spelling appears only while
the record is still *unresolved* (which is exactly when the mismatch is real and the detection `!` from
`school-name-mismatch.md` should explain it). The displayed name and the stored `school_id` now agree,
so *"the label says X but the row is filed under Y"* becomes impossible for a matched record.

> - **Both dialects.** The two builders must change together; the join text can live in
>   `dialect/shared.ts` (like `schoolFieldPredicate`) so one edit cannot leave the other stale.
> - **Cost.** The two extra LEFT JOINs are equality lookups against the tiny, indexed alias table
>   (`UX_school_name_aliases_name`), inside a correlated subquery that already runs per row. Measure
>   on the submissions list; if it shows up, the alternative is §4.5-A's stored value.


### 4.5 Where the declared name comes from — reconstruct, or record it once

The worklist (§7) and the repair (§4.4) both need **the school name the submission declared**. There
are two honest ways to get it, and the recommendation is the first:

> ★ **`declared_school_name` is the parent's spelling — the *input* — not the app school.** The app
> school is `school_id`. Keeping the two separate is what lets the worklist show *what was submitted*
> ("Dillard Drive Magnet Middle School") while the record itself shows the *source of truth* ("Dillard
> Drive Middle School"), per §3.1. Do **not** write the resolved name into `declared_school_name` — that
> would destroy the very value the alias keys on and make re-matching impossible to diff.

| | approach | cost | notes |
|---|---|---|---|
| **A (recommended)** | record `submissions.declared_school_name` **at intake**, from the same `plan.schoolName` that already decides routing (`queries.ts:2104`) | one nullable column + one intake line + a one-off backfill script for existing rows | makes the worklist a `GROUP BY`, the repair a single guarded `UPDATE`, and **removes** the detection plan's §4.1 "two school questions" ambiguity — the value intake actually used is stored, not reconstructed |
| **B** | reconstruct on read, per row, from `submission_values ⋈ form_fields` (school-labelled) plus `submission_adhoc_fields`, then filter in TypeScript | no schema change | heavier (a scan of every submission), and it re-derives a decision that was already made and thrown away |

**Recommend A.** The repair is not an afterthought here — it is half the feature — and a stored value
is what makes it exact, idempotent and cheap. A nullable column is also the *safe* kind of DDL for a
ladder that runs against shared staging/production on boot (`multiple-forms.md` §4.10.6: a new
nullable column needs no separate database, unlike a rename or a type change).

If the detection plan's `school-match.ts` is already built, its `declaredSchoolName` is exactly the
value to store, and the backfill script in §9 reuses it — no second notion of "the declared answer".

### 4.6 Some strings are not schools — the "Ignore" action

A submitted value is sometimes genuinely not a school ("N/A", "Option 23", "Test School"). Without a
way to discharge it, it sits at the top of the worklist forever and the panel is trained out of the
admin (the same "a flag that fires on healthy rows is worse than no flag" argument the detection plan
makes at §12). So an **Ignore** action records the spelling as *known not to be a school* — a
`school_name_aliases` row with `school_id IS NULL` — which removes it from the worklist and, crucially,
**does not touch any submission's `school_id`** (those rows stay on the fallback, exactly as today).

> The copy must not let Ignore look like a fix. It means "stop asking me", not "resolved".

### 4.7 Reversibility — say what is and is not undone

- **Removing an alias** reverts **future** routing (new submissions stop matching it). It does **not**
  move back the rows the repair already re-filed, because the previous `school_id` is not recorded.
  The drawer says so, in words, before the admin removes one.
- If true undo is later wanted, an append-only `school_name_alias_events` table (mirroring
  `dbo.form_access_events`) is the follow-on — deliberately out of scope here (§11 Q3).

---

## 5. Data model

### 5.1 `dbo.school_name_aliases` (new)

```sql
-- SQL Server (server/src/db/schema.ts, in SQLSERVER_DDL_STATEMENTS)
IF OBJECT_ID('dbo.school_name_aliases', 'U') IS NULL
CREATE TABLE dbo.school_name_aliases (
  id             INT IDENTITY(1,1) PRIMARY KEY,
  submitted_name NVARCHAR(200) NOT NULL,   -- the NORMALISED key: LOWER(TRIM(...)), what matching uses
  display_name   NVARCHAR(200) NOT NULL,   -- the spelling as first seen, for the panel to show
  school_id      INT           NULL,       -- NULL = "Ignore" (known not to be a school)
  created_by     INT           NULL,       -- users.id of the admin who decided; NULL for a seed row
  created_at     DATETIME2 NOT NULL CONSTRAINT DF_school_name_aliases_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_school_name_aliases_school FOREIGN KEY (school_id) REFERENCES dbo.schools(id)
);

-- its own batch, and via indexGuard so expectedIndexNames() sees it (see §5.4)
CREATE UNIQUE INDEX UX_school_name_aliases_name ON dbo.school_name_aliases(submitted_name);
```

Design notes, each earned somewhere in this repo:

- **`submitted_name` is the key, `display_name` is for humans.** Matching is normalised; the panel
  still shows the real spelling the form produced. Storing only one of the two either breaks
  matching casing or shows a lower-cased string to the admin.
- **`school_id` is nullable on purpose** — `NULL` *is* the Ignore state (§4.6). One table, one
  concept ("this spelling is accounted for"), no second flag column.
- **FK to `schools` is `NO ACTION`** (the default), not `CASCADE`. `dual-db.md` and the `submissions`/
  `submission_values` history both record SQL Server error 1785 (multiple cascade paths) biting this
  schema. Schools are not deleted today anyway, and `NO ACTION` means an alias can never silently
  vanish and re-open the mismatch.
- **`created_at` is a `DATETIME2` timestamp**, so it must be in `TIMESTAMP_COLUMNS` (`db/client.ts`) —
  it is already present as a shared column name; §5.4 verifies it, because the driver normalises on
  that set or the value reaches the API as a raw string on Turso (`dual-db.md` §10.7).
- **The unique index is its own batch and goes through `indexGuard`.** `schema.ts:626-660` documents
  why: `IF OBJECT_ID('dbo.schools','U') IS NULL` skips the whole batch, so an index riding the
  `CREATE TABLE` never reaches a database that already has the table. `expectedIndexNames()` parses the
  statements, so declaring the index here also keeps the boot-time "N indexes MISSING" warning honest.

### 5.2 Turso / libSQL (`dialect/turso.ts`)

One edit, mirroring the schools and `form_access` tables: a `CREATE TABLE IF NOT EXISTS school_name_aliases (...)`
in `TURSO_DDL` and the matching `CREATE UNIQUE INDEX IF NOT EXISTS UX_school_name_aliases_name`.
A brand-new table needs **no** `addColumns` entry (that list is only for columns added to a table an
earlier revision already created — `multiple-forms.md` §4.10.6). `libsql.test.ts` asserts the two
dialects' **exact index-name sets** agree, so the index must be declared in both or the suite fails.

### 5.3 `submissions.declared_school_name` (new nullable column — recommendation A, §4.5)

```sql
-- SQL Server: its OWN batch (SQL Server compiles a batch before running it, so a statement that
-- references a just-added column cannot share the batch — multiple-forms.md §4.10.6)
IF COL_LENGTH('dbo.submissions','declared_school_name') IS NULL
ALTER TABLE dbo.submissions ADD declared_school_name NVARCHAR(200) NULL;
```

- **Turso:** the column in the `submissions` `CREATE TABLE` **and** an `addColumns` entry
  `{ table: 'submissions', column: 'declared_school_name', definition: 'TEXT' }`.
- **No `TIMESTAMP_COLUMNS` and no `BOOLEAN_COLUMNS` entry** — it is a plain string.
- **No index** — it is grouped/summed by the worklist at a scale of a few thousand rows, and an index
  on a column that is NULL for every single-school form's submissions would be a claim, not a fix.

If B is chosen instead (§4.5), everything in §5.3 disappears and the worklist/repair use the
reconstruction path — the rest of the plan is unchanged.

### 5.4 Dialect checklist (the `dual-db.md` gate, applied)

| # | check | where |
|---|---|---|
| 1 | SQL Server `CREATE TABLE` (its own `IF OBJECT_ID` batch) | `schema.ts` |
| 2 | SQL Server unique index in its own batch, via `indexGuard` | `schema.ts` |
| 3 | Turso `CREATE TABLE IF NOT EXISTS` | `dialect/turso.ts` |
| 4 | Turso `CREATE UNIQUE INDEX IF NOT EXISTS` | `dialect/turso.ts` |
| 5 | `created_at` present in `TIMESTAMP_COLUMNS` | `db/client.ts` |
| 6 | `libsql.test.ts` exact-index-set parity still passes | test |
| 7 | `submissions.declared_school_name` — SQL batch + Turso `CREATE` + `addColumns` (if A) | `schema.ts` / `turso.ts` |

---

## 6. API

All under the existing **`/api/schools`** router (`server/src/routes/schools.ts`), all `requireRoles("admin")` —
the school dictionary is an admin surface, and every existing school route already is.
★ Per `feature-backlog.md` §2.3, **every route goes in three places** — the Express router,
`server/src/routes/inventory.ts` (`ROUTES`), and `server/src/swagger.ts` (`paths`) — or `swagger.test.ts`
fails the build.

| method | path | body / notes |
|---|---|---|
| `GET` | `/api/schools/aliases` | every alias row (joined to the school's current name for display) |
| `GET` | `/api/schools/aliases/unmatched` | the worklist: `[{ submitted_name, display_name, count, first_seen, last_seen }]` — declared names that resolve to **no** school and are **not** already aliased/ignored |
| `POST` | `/api/schools/aliases` | `{ submitted_name, school_id \| null, relocate?: boolean }` → `{ alias, relocated }`. `school_id: null` is Ignore. `relocate` defaults **true**. |
| `DELETE` | `/api/schools/aliases/:id` | removes a mapping (future routing only; §4.7) |

Registration-order note: these are `GET`/`POST`/`DELETE` on `/aliases…`; the router's existing
`PATCH /:id` is a different method and the router has no bare `GET /:id`, so nothing is shadowed —
but register the `/aliases` block **above** `PATCH /:id` anyway, so a future `GET /:id` cannot swallow
`/aliases`.

Validation (`server/src/schemas.ts`): `submitted_name` non-empty, trimmed, `max(200)`;
`school_id` a positive integer **or** null; `relocate` boolean. The route re-checks that a supplied
`school_id` exists (`getSchool`) and answers 400 for an unknown id rather than 500 from the FK.

### 6.1 Server logic (`server/src/db/queries.ts`)

```ts
// The single resolver every caller shares (§4.3). One indexed query for the exact name,
// one for the alias — or a single UNION query so it stays one round trip.
export async function resolveSchoolByName(name: string): Promise<{ id: number; name: string } | null>;

// The worklist. With recommendation A this is a GROUP BY over the stored declared name;
// the TS pass drops the ones that resolve (exact or alias).
export async function listUnmatchedSchoolNames(): Promise<UnmatchedSchoolName[]>;

// Create/update an alias and (optionally) re-file existing rows. Returns the affected count.
export async function setSchoolAlias(input: {
  submitted_name: string; school_id: number | null; createdBy: number | null;
}): Promise<SchoolAlias>;
export async function relocateSubmissionsByDeclaredName(
  declaredName: string; schoolId: number
): Promise<number>;   // guarded UPDATE (backfill-school-id.ts:205-214), returns rows changed

export async function listSchoolAliases(): Promise<SchoolAlias[]>;
export async function deleteSchoolAlias(id: number): Promise<boolean>;
```

`findSchoolIdByName` (`queries.ts:2036`) gains the alias step **inside it**, so `createSubmission`,
`resolveSubmissionSchoolId`, and the detail verdict all inherit it in one edit (and cannot drift).

### 6.2 Caching

An alias lookup sits on the intake path, which is hot. Mirror `db/roles-cache.ts` exactly:
an in-process `Map<submitted_name, school_id>` with a **30 s TTL** and an `invalidateSchoolAliasCache()`
called by `setSchoolAlias`/`deleteSchoolAlias`. Same reasoning as that file's header: an in-process map
with no TTL is silently wrong on the second App Service instance; the TTL bounds the cross-instance
window and the explicit invalidation makes the admin's own change instant.

`deliverable check`: a newly created alias is visible to intake on the **same** request that created it
(invalidation), and to a second instance within 30 s.

---

## 7. Settings → School Name Matching (the panel)

### 7.1 Placement

A new `<CollapsibleSection title="School Name Matching">` in `client/src/pages/admin/AdminSettings.tsx`,
placed **directly beside the existing Schools section** (`AdminSettings.tsx:2337`, `title="Schools"`)
— the two are the same subject and are read together: Schools says what the app *knows*, this says
what the forms are *saying*. Either order is defensible; put it **after Schools** so the reference list
comes first.

The panel is a **local component** (`client/src/pages/admin/SchoolNameMatchingPanel.tsx`), mirroring
`SchoolsPanel.tsx` (which is already extracted and rendered inside a `CollapsibleSection` with
`bodyStyle={{ padding: 0 }}`). This keeps `AdminSettings.tsx` from growing a fourth hundred-line block.

### 7.2 The worklist table

Columns, in the order an admin needs them:

| Submitted name (as the form sends it) | Submissions | First seen | Action |
|---|---|---|---|
| `Dillard Drive Magnet Middle School` | 7 | Sep 12, 2026 | **Match…** \| **Ignore** |
| `Moore Square Magnet MS` | 3 | Sep 28, 2026 | **Match…** \| **Ignore** |

- Sorted by **count desc**, then name — the biggest pile first, because that is where the fix pays off.
- Subtitle carries the size: `"3 submitted spellings don't match a school · 10 submissions affected"`.
- **Empty state** is not blank: it says *"Every school a form has submitted matches a school in the
  list."* (An empty grid and "nothing is wrong" are the same pixels and different facts — the same
  point `LockedFormPanel.tsx` makes.)
- Below the worklist, a collapsible **"Existing matches"** sub-list of alias rows
  (`submitted → school`, who made it, when) each with a **Remove** action (§4.7 copy applies).

### 7.3 The "Match school" drawer

The house pattern is a right slide-out drawer (Organizations, System Messages, Users, SchoolDrawer).
Reuse it. Fields:

1. **The submitted spelling** — read-only, prominent, copyable. It is the whole reason the row exists.
2. **Which school does it mean?** — a searchable single-select over `GET /api/schools` (the full shared
   list; admins already hold it). Show grade level / calendar as secondary text, because that is what
   disambiguates the "Akins"/"Southeast Raleigh" style near-duplicates the alias table was built for.
3. **"This will re-file N existing submissions"** — an informational line with the live count (§4.4),
   not a toggle. Matching *is* re-filing, so the admin is told the blast radius rather than asked to
   choose it. If N is 0 (a first occurrence), say so: "No existing submissions carry this spelling yet."
4. **Save** → `POST /api/schools/aliases` → toast (`"Matched \"…\" to <school>. 7 submissions re-filed."`),
   refresh the worklist (the row disappears) and the counts.

> ★ **No "suggestion" is offered.** Not a dropdown defaulted to a best guess, not a "did you mean".
> The admin picks the school; the app only remembers it. That is requirement 1, upheld in the UI.

---

## 8. Client files

- `client/src/lib/api.ts` — four methods in the schools block (next to `listSchoolsPage`/`createSchool`):
  `listSchoolAliases()`, `listUnmatchedSchoolNames()`, `createSchoolAlias(...)`, `deleteSchoolAlias(id)`.
  Follow the existing `request<T>(..., { auth: true })` shape.
- `client/src/types/index.ts` — `SchoolAlias`, `UnmatchedSchoolName` (mirroring the server shapes).
- `client/src/pages/admin/SchoolNameMatchingPanel.tsx` — **new**; the worklist + "Existing matches"
  sub-list + the drawer, modelled on `SchoolsPanel.tsx`.
- `client/src/pages/admin/AdminSettings.tsx` — import and render the new `CollapsibleSection` beside
  Schools. Nothing else in the file changes.
- `client/src/styles/global.css` — only if the existing `.card` / `.grid` / drawer classes do not cover
  it; the Schools panel needs none, so this should be empty. (Listed so the checklist is honest.)

No new dependency: the select is a plain `<select>`/`<input>` filtered in state, as `SchoolsPanel`'s
filter select already is. `feature-backlog.md` §2.1 (minimal dependencies) is respected.

---

## 9. Intake integration and a one-off backfill

### 9.1 Intake

`createSubmission` (`queries.ts:2096-2107`) already computes `plan` and `plan.schoolName`. Two changes:

1. **Store** the declared name: add `declared_school_name` to the `submissions` INSERT, from
   `plan.schoolName` (null when the form has no school question — the detection plan's state D).
2. **Route through the resolver**: the existing `findSchoolIdByName(plan.schoolName)` call needs no
   change — it *is* the resolver once the alias step is inside it (§4.3) — so intake begins honouring
   admin aliases without a second code path.

### 9.2 Backfill for existing rows — `server/src/db/backfill-declared-school.ts` (new)

Everything already in the database has `declared_school_name = NULL`. A one-off script fills it,
following the exact shape of `backfill-school-id.ts` (dry run by default, `-- --apply` to write,
`process.exit`, the `<>`/guard discipline):

1. select submissions that have a school answer (defined or ad-hoc);
2. reconstruct the declared name with the **same** `declaredSchoolName` helper the flag uses
   (from `school-match.ts` if it exists — §4.5);
3. write `declared_school_name` where it is NULL.

It is **idempotent** (only fills NULLs) and **writes nothing derived from a guess** — it records what
intake already decided. It is deliberately **not** part of the boot DDL ladder: booting the app must
not rewrite production rows (`backfill-school-id.ts:21-22`).

### 9.3 Seeding the reviewed built-ins (Q1, recommended)

If Q1 is accepted, the boot **seed** (`db/seed.ts`, idempotent `INSERT ... WHERE NOT EXISTS`) inserts
the four rows from `SCHOOL_NAME_ALIASES` with `created_by = NULL` (so a seed row is distinguishable
from an admin's row in the "Existing matches" list). The constant in `backfill-school-id.ts` is then
retired to a comment pointing at the table, so there is one home for aliases — the "one resolver /
one definition" pattern this repo uses for `SCHOOL_FIELD_LABELS` and `canAccessForm`.

---

## 10. Consequences of the routing change — stated plainly

Consulting aliases at intake is the one line that changes behaviour beyond the panel, so its effects
are enumerated rather than left to a reader to infer:

| # | effect | intended? |
|---|---|---|
| 1 | A submission whose school answer matches an **admin alias** is now filed under the aliased school — that school's staff can open it, the placeholder school's contact loses it. | **Yes.** The alias *is* that decision; the alternative is the row stranded where nobody can open it (`school-id-space-repair.md`). |
| 2 | A match affects **future** submissions immediately (cache invalidated) **and** re-files past ones in the same act (unconditionally). | **Yes** — that is requirement 3: the submission *becomes* the school. |
| 3 | An admin can move another school's submissions onto a school by creating a bad alias. | **Accepted.** It is admin-only, logged by `created_by`/`created_at`, and reversible for future routing. The alternative — no tool — leaves the mismatch permanently unfixable. `SCHOOL_NAME_ALIASES` already carried this power in a shell script. |
| 4 | Removing an alias does **not** move re-filed rows back. | Yes (§4.7) — and said in the drawer. |
| 5 | Ignore leaves the row on the fallback, unchanged. | Yes — Ignore is "stop asking", not a fix. |
| 6 | A re-filed row now **displays** the matched school's name (exact → alias → typed text), so the label and the `school_id` agree. | Yes (§4.4.1) — without it the row would be openable but mislabelled. |

Nothing here weakens `canAccessSchool`; it continues to compare `submissions.school_id`, which is now
*more* often correct.

---

## 11. Open questions and decisions to take

Each has a recommendation, and each is a data/behaviour decision a reviewer should consciously accept.

| # | question | recommendation |
|---|---|---|
| **Q1** | **Seed** the four reviewed `SCHOOL_NAME_ALIASES` rows into the table, or start empty? | **Seed.** They are already reviewed and real; leaving them script-only means the live path keeps mis-filing known spellings. Seed rows carry `created_by = NULL` so they are distinguishable. |
| **Q2** | An **Ignore** action, or only Match? | **Yes, Ignore.** Without it, non-school values ("N/A", "Option 23") sit at the top of the worklist forever, and a panel that always shows the same unresolved rows is ignored (the detection plan's §12 argument). Ignore must **not** read as a fix. |
| **Q3** | Do we need undo/audit of a match? | **Not in v1.** `created_by`/`created_at` answer *who/when*. Undo of a **re-file** needs an events table (`form_access_events` pattern) — a follow-on, named here so it is not silently assumed. |
| **Q4** | Re-file **archived** submissions too? | **No by default.** Archived rows are out of the active queue; moving them has no operational benefit and surprises whoever archived them. Offer it, if at all, as a separate explicit action, never silently. |
| **Q5** | Reconstruct the declared name (B), or store it (A)? (§4.5) | **Store it (A).** The repair needs it exact and idempotent; B re-derives a decision already made. If `school-match.ts` from the detection plan exists, reuse its `declaredSchoolName`. |
| **Q6** | Who may see and act on the panel? | **admin only.** It is on `/admin/settings` behind `requireRoles("admin")`, consistent with every other school route. Staff see the *detection* flag on the submission (the detection plan's Q4), not this panel. |
| **Q7** | Are aliases global or per-workspace/org? | **Global.** `organizations.md` §1.5: schools are a **shared** dictionary "available to all organizations". A submitted spelling therefore maps the same way for every workspace, and a per-org alias would let one workspace re-route a school the other also has. (The detection plan's Q6 already flags that `findSchoolIdByName` has no org filter; aliases inherit that and add nothing new — but it is worth *deciding* rather than inheriting by accident.) |

---

## 12. Testing

| test | what it pins |
|---|---|
| `server/src/db/school-alias.test.ts` (**new**) | `resolveSchoolByName` — exact match wins over alias; alias resolves when exact fails; **no** fuzzy/prefix/`collate` match; case/trim normalisation (`"Dillard Drive Middle School "`, `"dillard drive middle school"`); an `Ignored` (school_id NULL) row does **not** resolve to a school |
| ↑ | `relocateSubmissionsByDeclaredName` — the `<>` guard (a row already on the target is untouched), idempotency (second run reports 0), and that it never touches a row whose declared name differs |
| ↑ | `listUnmatchedSchoolNames` — **negative controls**: a matched name, a case-differing name, an already-aliased name and an ignored name are all **absent**; counts add up to the affected rows |
| ↑ | `submissionSchoolNameSubquery` (§4.4.1) — a **SQL-text assertion** (the `form-access.test.ts` scan pattern) that **both** dialects' builders carry the alias LEFT JOIN and the `scs.name, acs.name, sv.value` order, so a later edit to one builder cannot silently drop the display fix |
| ↑ | `canAccessSchool` on a **re-filed** row — a viewer scoped to the matched school is allowed; a viewer scoped to the fallback school is not. This is the follow-up's "the logged-in user can see it", pinned by a unit test |
| `server/src/db/libsql.test.ts` (existing) | the two dialects' **exact index-name sets** still agree after the new unique index |
| `server/src/db/submissions-archive.test.ts`-style parity test (new or extended) | `TIMESTAMP_COLUMNS.has("created_at")` and every `*_at TEXT` column in the Turso DDL is listed (`dual-db.md` §10.7) |
| `server/src/swagger.test.ts` (existing) | the four new routes are in `paths` **and** the inventory (`ROUTES`) |
| `server/src/schemas.test.ts` (existing pattern) | the alias body schema rejects blank names, unknown/negative `school_id`, non-boolean `relocate` |
| `server/src/webhook/field-mapping.test.ts` (existing) | **untouched** — intake still resolves as before when no alias matches (the fallback path is unchanged) |

> ★ **The tests that matter most are the negative ones** — the same lesson the detection plan records
> at §12. A resolver that fuzzy-matches must fail; an "unmatched" list that contains a healthy name
> must fail; a re-file that moves a row it should not must fail. If only one test is written, write
> the "exact match beats alias, alias beats fallback, nothing else matches" one.

There is **no live database in the suite**, so the worklist and the re-file are *reasoned* here and
verified on staging against the rows `school-id-space-repair.md` already counted (the 9 stranded
submissions). That is the acceptance data, and it exists before a single test row is invented.

---

## 13. Rollout — five independently verifiable phases

| phase | deliverable | verify |
|---|---|---|
| **1** | DDL: `school_name_aliases` in both dialects (+ index parity); `submissions.declared_school_name` both dialects | `initDb` re-runs cleanly; `libsql.test.ts` green; no "indexes MISSING" for the new index |
| **2** | Resolver: alias step in `findSchoolIdByName` **and** in `submissionSchoolNameSubquery` (both dialects); store `declared_school_name`; alias cache | a crafted `INSERT` with an aliased spelling files under the aliased school **and displays that school's name**; a non-aliased one still falls back |
| **3** | Backfill scripts: fill `declared_school_name` (dry run then apply); seed the reviewed built-ins (Q1) | dry run lists a plan, apply matches it, second run is a no-op |
| **4** | Routes + queries: the four endpoints, `listUnmatchedSchoolNames`, `setSchoolAlias`, re-file | Swagger + inventory green; `POST` then `GET unmatched` drops the row |
| **5** | Panel: `SchoolNameMatchingPanel` + drawer in `AdminSettings` | the loop below |

### 13.1 The end-to-end loop (do this on staging)

| step | expect |
|---|---|
| a Google-Form submission with a misspelled school | lands on the form's fallback; `declared_school_name` set (state A) |
| open Settings → School Name Matching | the spelling is listed, with the right count |
| press **Match…**, pick the school | toast says N re-filed; the row leaves the worklist |
| sign in as the **matched school's** user, open the queue | the re-filed submissions now appear **in their queue** (the `school_id` fix) |
| that user opens one of them | **can** open it (`canAccessSchool`), and the School column reads that school's name — not the typo (the display fix) |
| the **fallback** school's user (if any) looks for it | no longer in their queue — intended |
| submit the **same** spelling again | routes to the school **without** an admin (the learning) |
| Match a spelling to the same school again | no-op, no duplicate alias |
| Remove the alias, submit again | routes to the fallback again — learning reverted, past rows unchanged |
| **Ignore** "N/A" | leaves the worklist; a submission carrying it is unchanged |

---

## 14. Scope

**v1 — this plan**
`dbo.school_name_aliases` (+ Turso, + index parity) · `submissions.declared_school_name` ·
the alias step in `findSchoolIdByName` · the alias joins in the display subquery (§4.4.1) · alias cache ·
the four routes · the unmatched worklist · Match/Ignore · the guarded re-file · the Settings panel +
drawer · the two backfill scripts · tests.

**Explicitly not in v1 (each its own reviewable change)**

| # | follow-on | why deferred |
|---|---|---|
| 1 | an events/undo table for a re-file (§4.7, §11 Q3) | needs a new table + a design for "the previous school"; v1 keeps `created_by`/`created_at` |
| 2 | a detection `!` on the submission detail | that is [`school-name-mismatch.md`](./school-name-mismatch.md); this plan is its remedy, not a replacement |
| 3 | a "submissions with an unmatched school" filter on the grid | the detection plan's §6 explains why the ad-hoc half is not SQL-reachable without this plan's stored column; revisit once A ships |
| 4 | re-file on **archive**, not on match | Q4 |
| 5 | analytics ("how often does each form misspell?") | a report, not a routing fix |

**Explicitly never in scope:** fuzzy, distance-based, phonetic or prefix matching (§4.2, and
`backfill-school-id.ts:42-57`). A wrong guess here is a silent cross-school access grant.

---

## 15. Files touched

| file | change |
|---|---|
| `server/src/db/schema.ts` | `school_name_aliases` table + its unique index (via `indexGuard`); the `schools` FK in its own `fkGuard` + type-guarded batch (**§18**); `submissions.declared_school_name` column batch; `SchoolAlias` type |
| `server/src/db/dialect/turso.ts` | the table + index in `TURSO_DDL`; `declared_school_name` in the `submissions` CREATE and in `addColumns`; **§4.4.1** — the alias joins in `submissionSchoolNameSubquery` |
| `server/src/db/dialect/sqlserver.ts` | **§4.4.1** — the alias joins in `submissionSchoolNameSubquery` (`addColumns` stays `[]` — the ladder is cumulative) |
| `server/src/db/dialect/shared.ts` | optional: hoist the alias-join text so both dialects build it from one place (§4.4.1) |
| `server/src/db/client.ts` | confirm `created_at` ∈ `TIMESTAMP_COLUMNS` (no-op if already present) |
| `server/src/db/queries.ts` | alias step in `findSchoolIdByName`; `resolveSchoolByName`; `listUnmatchedSchoolNames`; `setSchoolAlias`; `relocateSubmissionsByDeclaredName`; `listSchoolAliases`; `deleteSchoolAlias`; `declared_school_name` in the `createSubmission` INSERT |
| `server/src/db/school-alias-cache.ts` | **new** — the TTL cache (mirrors `roles-cache.ts`) |
| `server/src/db/seed.ts` | seed the reviewed built-ins (Q1) |
| `server/src/db/backfill-declared-school.ts` | **new** — fill `declared_school_name` (dry run / `--apply`) |
| `server/src/db/backfill-school-id.ts` | retire the inline `SCHOOL_NAME_ALIASES` to the table (Q1); behaviour otherwise unchanged |
| `server/src/routes/schools.ts` | the four `/api/schools/aliases…` routes |
| `server/src/routes/inventory.ts` | the four routes in `ROUTES` |
| `server/src/swagger.ts` | the four routes in `paths` |
| `server/src/schemas.ts` | `createSchoolAliasSchema` |
| `client/src/lib/api.ts` | four methods |
| `client/src/types/index.ts` | `SchoolAlias`, `UnmatchedSchoolName` |
| `client/src/pages/admin/SchoolNameMatchingPanel.tsx` | **new** — worklist + drawer |
| `client/src/pages/admin/AdminSettings.tsx` | the new `CollapsibleSection` beside Schools |
| `server/src/db/school-alias.test.ts` | **new** — §12 |
| `docs/plans/school-name-mismatch.md` | cross-reference: its follow-ons #3/#4/#5 land here |
| `docs/plans/feature-backlog.md` | add this item as written |

---

## 16. What this does NOT do — the honest limits

- **It does not stop the wrong spelling from being submitted.** It stops the wrong spelling from
  *stranding a submission*. The Google Form can keep its stale list; the app now copes.
- **It is not automatic.** Nothing is matched, re-filed or hidden until an admin presses Match. That
  is faith to the request ("I don't want it auto-corrected"), and it is also the reason the panel
  must be easy to find and honest about its counts.
- **A re-file is not undone by removing the alias** (§4.7) — say so where the admin does it.
- **The `findSchoolIdByName` org-filter gap (detection plan Q6) is unchanged.** Aliases are global
  because schools are shared (`organizations.md` §1.5); nothing here makes that worse or better, and
  it is called out so a reviewer does not read this plan as having closed it.
- **A school rename does not break an alias** — the row stores `school_id`, so the mapping survives a
  rename and the panel shows the school's current name.

---

## 17. Implementation status (2026-10-04)

**Shipped.** Table + column in both dialects; the alias step in `findSchoolIdByName`; the alias joins
in `submissionSchoolNameSubquery` (both dialects); `declared_school_name` written at intake; the four
admin `/api/schools/aliases` routes (+ inventory + swagger); `SchoolNameMatchingPanel` on
`/admin/settings`; `school-alias-cache.ts`; `backfill-declared-school.ts`; tests
(`school-alias.test.ts` + updated `libsql.test.ts` / `submissions-archive.test.ts`). Server and client
typecheck and build; the full suite is green (275 tests); and the DDL, the display subquery, and the
upsert→relocate→delete round trip were run against the **live SQL Server** database.

**Two deliberate deviations from this draft**

1. **The four built-ins are NOT auto-seeded** (§11 Q1 recommended seeding them). The requester's
   requirement is emphatic that *nothing* be auto-corrected and every mapping be an admin decision —
   so `dbo.school_name_aliases` starts **empty**, and the same spellings that `SCHOOL_NAME_ALIASES`
   covers will simply appear in the worklist for an admin to match once. This also keeps boot-time
   writes off the ladder and avoids a seed pointing at a school a given database may not import. The
   reviewed pairs remain documented in `backfill-school-id.ts` if they are ever wanted as data.
2. **Two helper exports from §6.1 were dropped** (`resolveSchoolByName`, and a `count…` preview
   helper) — they had no caller once the panel took its count from the worklist, and this repo does
   not keep unused exports. `findSchoolIdByName`'s alias fallback is the real deliverable.

**Still manual (by design):** `npm run backfill:declared-school` (dry run, then `-- --apply`) fills
`declared_school_name` for rows that predate the column. New submissions populate it automatically.

---

## 18. Production schema catch-up (2026-10-04)

**Symptom.** Settings → **School Name Matching** answered `Invalid column name 'declared_school_name'`
on the production database, permanently, while staging was fine.

**Root cause — the ladder aborted eleven batches before reaching that column.** Production
(`wcpsssqlelasticpool` / `wcpss-google-forms`) is the database this app did **not** create: its
`schools.id` is **`bigint`** and its string columns are `nvarchar(max)`. `v1` declared the new table's
FK **inline**:

```sql
school_id INT NULL,
CONSTRAINT FK_school_name_aliases_school FOREIGN KEY (school_id) REFERENCES dbo.schools(id)
```

A foreign key between an `int` and a `bigint` column is refused (error **1750**, "Could not create
constraint or index"). Inline, that refusal fails the whole `CREATE TABLE`, and because `run()`
executes the ladder batch by batch and stops at the first failure, **every later batch was never
applied** — including the `ALTER TABLE dbo.submissions ADD declared_school_name` the panel's query
needs. Hence a permanent `Invalid column name` for a column the schema had declared for a week.

The failure was invisible: `initDb()` logs only `err.message`, which named the constraint refusal
inside one statement and said nothing about the eleven batches that silently did not run.

**Fix (in the code, so it self-heals on every later deploy).** Two changes in `schema.ts`:

1. The FK moved **out of the `CREATE TABLE` batch into its own** batch, reached through `fkGuard`
   (never on the constraint's name) **and** a new `isSameTypeAs` guard that compares
   `school_name_aliases.school_id` against `schools.id` through `sys.columns`/`sys.types`. Where the
   two agree (every database this ladder created — `schools.id INT`) the FK is created exactly as
   before; where the database declares `schools.id BIGINT` the FK is **skipped and the table is still
   created**, so a type difference in a foreign database can no longer cost the app its schema.
   `school_id` itself stays `INT`: the app reads and writes app school ids, and
   [`school-id-space-repair.md`](./school-id-space-repair.md) keeps both databases on the same 235
   school names.
2. `driver/mssql.ts` now prefixes a ladder failure with **the failing batch's number, its total and
   the statement's first 160 characters**, so "the ladder stopped here and everything after it is
   unapplied" is in the log rather than inferred.

**Applied by hand to production** (add-only: one empty table, its unique index, one nullable column —
no row data written). Each batch on its own, in this order:

```sql
-- 1. the table (no FK; see the type guard above)
IF OBJECT_ID('dbo.school_name_aliases', 'U') IS NULL
CREATE TABLE dbo.school_name_aliases (
  id             INT IDENTITY(1,1) PRIMARY KEY,
  submitted_name NVARCHAR(200) NOT NULL,
  display_name   NVARCHAR(200) NOT NULL,
  school_id      INT NULL,
  created_by     INT NULL,
  created_at     DATETIME2 NOT NULL CONSTRAINT DF_school_name_aliases_created_at DEFAULT SYSUTCDATETIME()
);

-- 2. its unique index (its own batch — error 207)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_school_name_aliases_name')
CREATE UNIQUE INDEX UX_school_name_aliases_name ON dbo.school_name_aliases(submitted_name);

-- 3. the declared name the worklist groups by
IF COL_LENGTH('dbo.submissions', 'declared_school_name') IS NULL
ALTER TABLE dbo.submissions ADD declared_school_name NVARCHAR(200) NULL;
```

Batch 2 is the one the Turso `ON CONFLICT(submitted_name)` upsert depends on; do not skip it.

**Verification run** (2026-10-04, against live production):

| check | result |
|---|---|
| the four batches inside a rolled-back transaction, before applying | all four OK — the FK guard skipped, **no error 1750** |
| after applying | `school_name_aliases` present, `UX_school_name_aliases_name` present, `declared_school_name` present, 92 submissions unchanged |
| `listUnmatchedSchoolNames()` — the query that raised the error | returns rows, no error |
| `school-alias-cache.ts`'s `SELECT submitted_name, school_id …` | returns rows, no error |
| type guard on production — `int`(4) vs `bigint`(8) | **skipped**; `sys.foreign_keys` for the table stays 0 |
| type guard on TEST — `int`(4) vs `int`(4) | **created**; the FK that database has had since `v1` is re-derived identically |
| all **70** ladder batches in one rolled-back transaction on production | every batch OK; `sys.tables`, `sys.columns` and `submissions` counts identical before, inside and after |

The `isSameTypeAs` guard compares **type name _and_ `max_length`**, so `varchar(64)` against
`varchar(200)` is also caught rather than trusted. The whole-ladder run is the proof that the ladder
is now **inert** on production: a `staging` → `production` slot swap can boot without changing a
single object or row.

**Still outstanding — which deployment renders the panel.** The panel the screenshot showed is
served by a **slot** (`staging` / `sandbox`), not by the root app: the bundle the root app serves at
`https://webform-hcf0e2gzgudjcsaq.eastus2-01.azurewebsites.net/assets/index-DvpwBmV5.js` contains
**no** occurrence of `School Name Matching`, `declared_school_name`, `Unmatched` or `aliases/unmatched`
(the only `School Name` hits are the submissions table's column header; `aliases` and `matching` come
from lucide icons). So the root app's deployment predates the feature and is not the one that was
failing. That is consistent with `deploy-azure.md` §5 — **a staging deploy points at production's
database** — and it is why an app that looked "production" was querying a production table the ladder
had never finished creating. With the schema now in place, whichever slot renders the panel will work.
No CI workflow targets the root app; see `deploy-azure.md` §5.

**Left as-is, deliberately:**

- **The backfill has not been run on production.** `declared_school_name` is `NULL` on all 92
  pre-existing rows, so the worklist is legitimately empty until
  `npm run backfill:declared-school` (dry run first, then `-- --apply`) is run **against production**.
  New submissions populate it themselves — `createSubmission` inserts `plan.schoolName`. Nothing is
  broken by waiting, and the panel shows an honest zero rather than a wrong count. §18.1 lists exactly
  what appears once it is run.
- **Production has no FK on this table**, by the guard above. That matches every other FK in that
  database (`FK_forms_school_id`, `FK_users_school_id`, …) — all of them pre-date this app and none is
  declared by the ladder.
- **Eleven other ladder indexes cannot exist there** and the boot warning says so on every start:
  their key columns are `nvarchar(max)`. `UX_users_email` is the one to know about — production has
  **no unique constraint on `users.email` at all**. Unchanged by this work; see `schema.ts:677-712`.

### 18.1 What the worklist will show once the backfill is run

Read only, so nobody re-debugs an empty panel. A projection was replayed against live production on
2026-10-04 — each row through `planSubmissionFields(fields, answers, SCHOOL_FIELD_LABELS)` exactly as
`backfill-declared-school.ts` does, then filtered and grouped exactly as `listUnmatchedSchoolNames()`
does (`normalizeSchoolKey` is the same `LOWER(LTRIM(RTRIM(…)))` the worklist SQL uses, and the alias
table is still empty, so the two agree row for row):

| | count |
|---|---|
| active rows with a NULL `declared_school_name` | **86** |
| …that declare a school (would gain a name) | **78** |
| …whose form asks no school question (stay NULL, never listed) | **8** |
| distinct spellings that already match a school name (no worklist entry) | **11** |
| distinct spellings that do **not** match — the panel's first worklist | **6** |

The six, in the order the panel will show them:

| declared spelling | rows |
|---|---|
| Herbert Akins Middle School | 5 |
| Moore Square Magnet Middle School | 3 |
| Option 23 | 1 |
| Southeast Raleigh Magnet High School | 1 |
| Vernon Malone College & Career Academy | 1 |
| Dillard Drive Magnet Middle School | 1 |

Each is a real near-miss, **not** a parsing failure and **not** something normalisation could ever fix
(the differences are words, not case or whitespace) — which is exactly why these need an admin decision
and why `normalizeSchoolKey` is deliberately only `LOWER(LTRIM(RTRIM(…)))`:

| declared spelling | closest canonical `dbo.schools` name | what differs |
|---|---|---|
| Herbert Akins Middle School | Herbert Akins Road Middle School | parent dropped "Road" |
| Moore Square Magnet Middle School | Moore Square Middle School | parent added "Magnet" |
| Southeast Raleigh Magnet High School | Southeast Raleigh High School | parent added "Magnet" |
| Vernon Malone College & Career Academy | Vernon Malone College and Career Academy | "&" vs "and" |
| Dillard Drive Magnet Middle School | Dillard Drive Middle School | parent added "Magnet" |
| Option 23 | — none — | a program, not a school: the ignore case |

Five of the six are the same shape — the parent wrote the school's marketing name — so five aliases and
one ignore clear the whole list. It is also why the confirmation step matters: "Southeast Raleigh"
matches both an Elementary and a High School in `dbo.schools`, so the admin's click is what decides which
one the alias points at, and the alias is then taught to intake for every future submission from that form.

The unfiltered dry run reports **92** rows / **83** declaring a school: `backfill-declared-school.ts`
does not filter `archived_at`, so it also fills archived rows. A full run therefore produces a worklist
very slightly larger than the six above.










