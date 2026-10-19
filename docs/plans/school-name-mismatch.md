# Plan — flag a submission whose school answer matches no school

**Status:** Draft for review
**Date:** 2026-10-03
**Area:** Submission detail UI (`/staff/:publicId`) + `getSubmissionDetail` / `getSubmissionByPublicId`
**Related plans:** [`google-form-undefined-fields.md`](./google-form-undefined-fields.md),
[`school-id-space-repair.md`](./school-id-space-repair.md), [`school-import.md`](./school-import.md),
[`webhook.md`](./webhook.md), [`google-form-url.md`](./google-form-url.md)

---

## 1. Goal

When a Google Form is submitted, the school the parent typed may not name a school this app knows.
Today that produces **no signal anywhere** — the submission is filed against the form's fallback
school and the page goes on displaying the typed text as if it were the school of record.

New behaviour, in one sentence:

> **If a submission's school answer resolves to no school — or to a different school than the row is
> filed under — mark the school value with a `!` and say, in words, which school the row is actually
> filed under and what to correct.**

The single most important word in this plan is **flag, do not guess**. This is a UI warning, not a
change to school routing (§8 Q1).

---

## 2. What "doesn't match" means here — and why you cannot see it today

`submissions.school_id` is a **derived** value, computed once at insert
(`server/src/db/queries.ts:2089`):

```
plan.schoolName  →  findSchoolIdByName(...)          ← exact, case-insensitive name match
                    ?? resolveSubmissionSchoolId(...) ← same lookup over DEFINED fields
                    ?? form.school_id                 ← the silent fallback
```

`findSchoolIdByName` (`queries.ts:2021`) is a single `LOWER(name) = LOWER(@name)` lookup. **No match
means no error, no log, no warning** — the row simply takes `form.school_id`, which for a
district-wide form is a placeholder such as *Sample School*.

Now the part that makes this invisible. The School column does not render `schools.name` from the
`school_id` join. It renders (`dialect/sqlserver.ts:148`, turso equivalent):

```sql
COALESCE(scs.name, sv.value)   -- LEFT JOIN schools ON the typed answer
```

…so when the answer matches **nothing**, `scs.name` is NULL and SQL Server hands back
**the parent's raw typed text**. The outer `COALESCE(…, sch.name)` (`queries.ts:1826`) then never
gets a chance to show the real school.

> ★ **The displayed school name is not evidence of a match.** A row filed on *Sample School* whose
> parent typed *Moore Square Magnet Middle School* renders as **Moore Square Magnet Middle School**.
> It looks correct. It is not correct. Nothing on the page can tell you the difference — which is
> exactly why this plan exists.

The consequence is not cosmetic. `canAccessSchool` and every school-scoped listing compare
`school_id`, so **the correct school's staff cannot open the submission, and the placeholder
school's contact can.** `docs/plans/school-id-space-repair.md` measured the size of this on real
data: the dry run reported **9 unresolved submissions** stranded on the *Sample School* placeholder
"where nobody could open them", plus 13 more unresolved rows in the wider repair.

### The four states

The flag needs to distinguish these, because the wording and the fix differ:

| | state | meaning | `!`? |
|---|---|---|---|
| **A** | `unmatched` | The form answered a school name; **no school in the app has that name**, so the row sits on `form.school_id`. | **yes** |
| **B** | `different` | The answer **does** resolve, but to a school other than the stored `school_id` (answer edited after insert, schools imported late, or an admin moved the row by hand — the staleness `backfill-school-id.ts:1-38` documents). | **yes** |
| **C** | `matched` | The answer resolves to the school the row is filed under. | no |
| **D** | `no_declared_school` | The form has no school-labelled field and no captured school answer — there is nothing to check. | **no** |

**D is not an afterthought.** A single-school form's submissions have no school answer at all. If D
is not explicit, every submission on every single-school form grows a `!` and the marker is trained
out of the admin within a day.

### A2 — aliases are a distinct sub-case of A

`server/src/db/backfill-school-id.ts:58` holds `SCHOOL_NAME_ALIASES` — four reviewed pairings
(*"moore square magnet middle school" → "moore square middle school"*, the `&`/`and` spelling,
grade-level disambiguations). **The one-off backfill consults it; the live intake path does not**
(`findSchoolIdByName` has no alias step). So a submission arriving today with an aliased spelling
still lands on the placeholder, even though a repair script run tomorrow would happily remap it.

The flag must not paper over this: see **§5 (one resolver)** and **Q2**.

---

## 3. Where the declared value lives — two sources, and one ordering trap

The school answer is in one of two places:

| source | table | matched by |
|---|---|---|
| **defined** field | `submission_values` ⋈ `form_fields` | `schoolFieldPredicate()` — `LOWER(LTRIM(RTRIM(ff.label))) IN ('school','school name')` (`dialect/shared.ts:58`) |
| **captured** question | `submission_adhoc_fields` | label only — there is no `form_fields` row to join |

> ★ **The captured source is the population most likely to mismatch.** The feature in
> `google-form-undefined-fields.md` exists for a form *nobody has designed in this app* — which is
> exactly a form whose school question was never curated. Any detection built purely as a dialect
> SQL subquery would silently skip it. This is the single strongest argument for doing the check in
> **TypeScript, not SQL** (§4.1).

The detail page already loads everything: `getSubmissionDetail` (`queries.ts:1934`) fetches
`values`, `adhocFields` **and** `formFields` before it returns. The check costs no extra query per
row.

### 3.1 The ordering trap

Three different orderings pick "the school answer", and they are not the same order:

| # | who | order used |
|---|---|---|
| 1 | **intake** — `planSubmissionFields` (`field-mapping.ts:156-163`) | the **incoming answers order**, i.e. the Google Form's question order. First school-labelled answer wins. |
| 2 | intake's fallback — `resolveSubmissionSchoolId` (`queries.ts:2001`) | the incoming order again, but **defined fields only** |
| 3 | the **display** subquery (`sqlserver.ts:156`) | `ORDER BY ff.sort_order, scs.id` |

★ For a form with more than one school-labelled question all three can name **different schools**.
The flag must follow **#1**, because the flag's entire job is to explain the decision intake made —
reporting a mismatch against a value intake never looked at would be worse than no flag at all.
§4.1 gets this for free by calling the same function.

---

## 4. Design

### 4.1 Reconstruct the declared answer by re-running intake's own rule

Do **not** re-implement label matching. Build the intake shape back out of what the row stores and
call the exported pure function that made the decision:

```ts
// server/src/db/school-match.ts
function declaredSchoolName(
  values: SubmissionValueRow[],
  adhocFields: AdhocFieldRow[],
  formFields: FormField[]
): string | null {
  const answers: IncomingAnswer[] = [
    ...values.map((v) => ({ field_id: Number(v.field_id), value: v.value })),
    ...adhocFields.map((a) => ({ label: a.label, value: a.value })),
  ];
  return planSubmissionFields(formFields, answers, SCHOOL_FIELD_LABELS).schoolName;
}
```

Why this shape:

- `planSubmissionFields` already returns `schoolName`, already takes `SCHOOL_FIELD_LABELS`, and is
  already the thing that decided this at insert. **The flag cannot disagree with intake because it
  is the same function** — the "one definition" pattern this repo uses for
  `SCHOOL_FIELD_LABELS`, `adhocRowsMatchingLabel` and `canAccessForm`.
- It reuses `normalizeLabel` for label matching, so `"School"`, `"school name"` and `"School "`
  behave identically in the flag and at intake.
- It handles the captured case, which SQL cannot reach (§3).

> ⚠ **Honest limitation.** The Google Form's *question order* is not stored, so the
> reconstruction approximates it with `form_fields.sort_order` for defined answers (then ad-hoc
> rows by their own `sort_order`). For the overwhelmingly common case — one school-labelled
> question — this is exact. For a form with **two** school-labelled questions it may pick the other
> one, and the flag could report a mismatch on a row intake routed correctly. Storing the declared
> answer at intake would remove the ambiguity, and this plan deliberately does not do that (§6).
> The case is worth a test that documents the behaviour rather than a claim that it cannot happen.

### 4.2 One pure matcher

```ts
export type SchoolMatch =
  | { kind: "no_declared_school" }
  | { kind: "matched" }
  | { kind: "unmatched"; declared: string; stored_school_name: string | null }
  | { kind: "different"; declared: string; resolved_school_id: number; resolved_school_name: string };

export function evaluateSchoolMatch(input: {
  declared: string | null;
  storedSchoolId: number | null;
  resolvedId: number | null;      // the school `declared` names, or null
}): SchoolMatch;
```

Pure, no DB, no imports beyond types — so every branch is a plain unit test (§12). It must compare
with **`Number()` on both sides**: `storedSchoolId` arrives from the database as TEXT on one driver
(§11.9), and this is the fourth time that class has bitten this codebase.

### 4.3 The lookup, and the name to describe

The caller resolves `declared` → a school via the existing `findSchoolIdByName` (export it, or add a
thin `resolveSchoolByName(name): Promise<{id, name} | null>` beside it — one indexed query).

★ **`submission.school_name` is NOT "the school in the app".** It is
`COALESCE(display-subquery, sch.name)` (`queries.ts:1826`) — on an unmatched row it is the parent's
typed text (§2). To say *which* school the row is filed under, `getSubmissionByPublicId` must also
select the plain join value, e.g. `sch.name AS stored_school_name`. Without this the UI cannot
explain itself, and a developer reading `school_name` will draw the wrong conclusion.

---

## 5. One resolver, or the flag lies

Three pieces of code will hold an opinion about "which school does this answer name": **intake**,
**the flag**, and the **backfill script**. If they disagree the feature is worse than nothing.

Concretely: if the flag resolved `SCHOOL_NAME_ALIASES` but intake did not, every aliased row would
render **"✓ matched"** while sitting on the placeholder school — the exact defect this plan exists to
expose, now carrying a false reassurance.

| | option | effect |
|---|---|---|
| **A** | The flag uses the **same** lookup intake uses — exact, case-insensitive, no aliases. | An aliased spelling flags as `unmatched`, truthfully. Routing unchanged. |
| **B** | Extract the resolution (label match + normalisation + aliases) into one shared module and have **intake, the flag and the backfill** all call it. | Aliased spellings start resolving at intake — fewer flags, but a **routing change that alters who can see a submission**. |

**Recommendation: land A now; schedule B as its own reviewed change.** B is a genuine improvement —
it would end the situation where a one-off repair script understands a spelling that live intake does
not — but it changes access, and `school-id-space-repair.md` is the record of what access changes
cost when they are folded into a UI feature. A can ship the observability without touching a single
`school_id`.

Either way, the **same function** must answer the question for the flag and for intake. That is
testable (§12) and should be a guard, not a comment.

---

## 6. Computed at read time — no migration, no backfill

The verdict is derived on every read from the stored answer:

- **No schema change.** Nothing added to `schema.ts`, `TURSO_DDL`, the `AddColumn` list or
  `migrate-turso.ts`'s `TABLES`. No DDL, no boot-time ladder, no script run.
- **It stays true.** `school_id` is written once and goes stale (the whole reason
  `backfill-school-id.ts` exists). A value recomputed from the answer cannot go stale: correct the
  answer and the flag clears on the next page load.
- **Cost:** one indexed name lookup per detail load, on a page that already runs five queries.

> ★ **The consequence to accept:** this is a *detail-page* check. List queries (the submissions grid,
> reports, export) cannot have it for free — the captured-answer half lives outside SQL (§3), so a
> grid-wide version needs a different mechanism. That is why §15 keeps it out of increment 1, and why
> the admin's bulk view of these rows stays the backfill script's dry run for now.

---

## 7. API contract

`GET /api/submissions/:publicId` (`getSubmissionDetail`) gains two fields:

```jsonc
{
  "school_id": 22,                       // unchanged
  "school_name": "Moore Square Magnet Middle School",  // unchanged — the DISPLAY value, may be the typed text
  "stored_school_name": "Sample School", // NEW — the school the row is actually filed under (§4.3)
  "school_match": {                      // NEW — absent only for the no-declared-school case
    "kind": "unmatched",                 // "matched" | "unmatched" | "different" | "no_declared_school"
    "declared": "Moore Square Magnet Middle School"
  }
}
```

Touch all four places the repo keeps in step when a response shape moves — they are checked together
by `swagger.test.ts`:

1. `client/src/types/index.ts` — the client type
2. `server/src/swagger.ts` — the `Submission` schema
3. the swagger inventory (and its coverage test)
4. `docs/features/swagger-ui.md`

---

## 8. UI

### 8.1 The marker, where it was asked for

`AlertTriangle` from `lucide-react` — already this app's warning icon
(`AdminFormDesigner.tsx:443`, `AdminForms.tsx:193`, `WebhookLog.tsx:335`) — rendered immediately
after the school value, with the message as a `title`/tooltip.

Two render sites, because the school answer can be in either list:

| form | where the school value renders |
|---|---|
| school-labelled **defined** field | the `parentFields.map` rows (`StaffSubmissionDetail.tsx:519`) |
| **captured** question | the "Additional fields" card (same file, below §7 of the capture plan) |

> ★ **Do not add this to `FieldValue.tsx`.** That component renders any field and knows nothing about
> schools; giving it a `warning` prop would push a school concept into a generic renderer. Render the
> marker in `StaffSubmissionDetail`, next to the label, where the school-labelled check already
> belongs.

### 8.2 A banner, because `!` cannot carry the consequence

The thing that matters is not "the name is odd" — it is **"the right school cannot see this
submission"**. That is not inferable from a `!`. A one-line banner at the top of the page states it
in words and offers the links (§9). The inline marker is the locator; the banner is the explanation.

### 8.3 Copy

| state | message |
|---|---|
| `unmatched`, filed under a fallback | *The form answered "Moore Square Magnet Middle School". No school in this app has that name, so this submission is filed under "Sample School" — the form's default. Staff at the right school cannot see it.* |
| `unmatched`, no fallback either | *The form answered "…". No school in this app has that name, and this form has no default school, so the submission is filed under **no school**.* |
| `different` | *The form answered "Wake STEM Early College High School". This row is filed under "Lufkin Road Middle School" instead.* |
| `matched` / `no_declared_school` | nothing rendered |

### 8.4 Who sees it — 🔴 **Q4**

The school answer is a **parent** field, so a parent viewing their own submission renders it too. A
parent cannot fix a Google Form, and the message describes internal routing. Recommendation: show
the marker and banner to **staff and admin only** (`canSeeField(f, viewer)` / the role already in
scope on this route), and never to a parent.

---

## 9. What "correct the school form" means in each case

The banner is only useful if it points somewhere. The remedy differs by state:

| state | the likely fix | where |
|---|---|---|
| `unmatched` — the app has the school under a different spelling | rename/add in the app, **or** fix the form's wording | `/admin/schools` |
| `unmatched` — the school is genuinely missing from the app | add it | `/admin/schools` |
| `unmatched` — the form's own option list is stale or mistyped (*the case the request describes*) | edit the question in the Google Form | the form's Google URL if the record stores one (`google-form-url.md`), else `/admin/forms/:id` |
| `different` | decide which side is right — usually the row | `/admin/schools` + the backfill script |

> ★ **The marker says where to look, not who is wrong.** In the request's own framing the fault is
> usually the **Google Form** (a stale or mistyped school list), not the app. The copy should not
> presume otherwise.

> ⚠ There is **no in-app way to fix the row's school** today. The only mechanism is
> `backfill-school-id.ts` — batch, dry-run gated, run from a shell. A per-row *"Assign school"* admin
> action is the obvious follow-on (§15) and this flag will create the demand for it.

---

## 10. Decisions to make

| # | question | recommendation |
|---|---|---|
| **Q1** | Flag, or change routing so an unknown answer falls back differently? | **Flag only.** `backfill-school-id.ts:42-57` argues this at length: no fuzzy matching, ever, because a wrong guess **silently grants a School Contact access to another school's submissions**. A flag asks a human; a guess decides for them. |
| **Q2** | Aliases: share `SCHOOL_NAME_ALIASES` with intake (B) or not (A)? (§5) | **A now.** B changes who can see a submission; make it its own reviewed change. |
| **Q3** | Detail page only, or the submissions grid too? | **Detail only** in increment 1 — the captured-answer half is not reachable from SQL (§6). |
| **Q4** | Who sees the marker? (§8.4) | **staff + admin; never parents.** |
| **Q5** | Keep the form fallback for an unmatched row, or set `school_id = NULL`? | **Keep it** (no access change) and add per-row *Assign school* later. NULL would change who sees the row *and* move the fix outside the app. |
| **Q6** | `findSchoolIdByName` has **no organization filter** (`ORDER BY id`, lowest wins). Should the flag bind to the form's org? | **Yes** — or the flag can report a match to another organization's school. Pre-existing for routing too; the flag merely makes it visible. |

---

## 11. Edge cases

1. **No school question at all** (single-school form) → `no_declared_school`, nothing rendered. If this
   is not handled explicitly, every submission on every single-school form grows a `!` (§2).
2. **Blank / whitespace answer** → `planSubmissionFields` requires `name !== ""`, so it is already
   treated as absent. Must not flag.
3. **Case-only difference** (`"broughton high school"`) → matches on both sides (`LOWER()`) → no flag.
4. **Leading/trailing space** → intake trims, the display subquery trims, and the flag goes through
   the same function, so all three agree. Must not flag — a *trailing space* is precisely the answer
   that "resolves at insert and then fails to resolve for display" if one site forgets to trim.
5. 🔴 **The answer is an ARRAY (a checkbox/multiselect school question).**
   `planSubmissionFields:159` requires `typeof a.value === "string"`, so an array answer **can never
   route** — the row takes the form fallback. But `declared` comes back `null` too, so this plan as
   written renders **`no_declared_school` and no marker: a false negative on a genuinely mis-routed
   row.** Recommendation: detect a school-labelled answer whose value is not a string and report a
   distinct `unsupported_answer_type`. Cheap to add, and "the form uses checkboxes for school" is a
   realistic authoring mistake.
6. **A numeric answer** on a school field → same as 5.
7. **Two school-labelled fields, one `staff_only`** → neither intake nor `schoolFieldPredicate()`
   filters on `staff_only`, so a *staff-only* field labelled "School" can hijack routing. The flag
   will faithfully report intake's choice (§3.1). Worth deciding separately whether the school-field
   set should exclude staff-only fields; that is a routing change.
8. **Duplicate identical school names in `dbo.schools`** → `ORDER BY id` picks the lowest in both the
   lookup and the display subquery, so they agree.
9. **String ids from the driver** → compare with `Number()` on both sides (§4.2).
10. **Archived submissions** → still flagged; the detail route is an identity lookup and deliberately
    serves archived rows.
11. **A deactivated school** — confirm whether `dbo.schools` carries an active flag. If it does, an
    answer naming a deactivated school still resolves and would render a clean ✓, which may be wrong.

---

## 12. Testing

| test | what it pins |
|---|---|
| `server/src/db/school-match.test.ts` (new) | `evaluateSchoolMatch` — every `kind`, table-driven |
| ↑ | `Number()` coercion on both sides — `stored_school_id` arrives as TEXT on one driver (§11.9) |
| ↑ | trim and case: `"School "`, `"school name"`, `" BROUGHTON HIGH SCHOOL "` |
| ↑ | `declared` null / `""` / whitespace → `no_declared_school` |
| `declaredSchoolName` | defines the answer from a **defined** field, from a **captured** ad-hoc row, from both, from neither |
| agreement test (new) | the reconstruction calls `planSubmissionFields` — assert `plan.schoolName` and the flag's `declared` are equal over one shared fixture, so a future refactor cannot make the flag describe a decision intake did not make |
| `field-mapping.test.ts` (existing, 21 tests) | untouched — the capture path keeps its own `schoolName` guarantees |
| `swagger.test.ts` (existing) | the two new response fields are in spec **and** inventory |

> ★ **The tests that matter most are the negative ones.** A matched row, a case-differing row, a
> trailing-space row and a form with no school question must all return a **non-flagging** kind. A
> flag that fires on healthy rows is worse than no flag: it is trained out of the admin within a day
> and then hides the real ones. If only one test can be written, write this one.

---

## 13. Verification — and the acceptance set already on record

There is **no live database in the test suite**, so the reconstruction is *reasoned*, not verified,
until it meets real rows. Two things make that cheap:

1. ★ **The acceptance data already exists.** `school-id-space-repair.md` records **9 submissions
   unresolved on the *Sample School* placeholder** — "where nobody could open them" — plus 13 more in
   the wider repair. Every one of those should light up. Open them on staging and confirm, before
   inventing test data.
2. **A negative control is mandatory.** Open a normal, correctly-matched submission and confirm there
   is **no** marker. "Nothing is flagged anywhere" and "the feature works" are indistinguishable
   without it.

Then the full loop:

| step | expect |
|---|---|
| a new form answer with a misspelled school name | `unmatched`, marker + banner, row on the form's fallback |
| the right school's contact opens it | still cannot see it (unchanged — Q1 changes nothing) |
| correct the Google Form's list, submit again | clean ✓, no marker |
| the **old** row, re-opened | **still flagged** — correct: the row's stored answer is still wrong. This is the difference between *fixing the form* (future rows) and *fixing the row* (§9) |

---

## 14. Risks and limits — stated plainly

- **It is a warning, not a fix.** Nothing clears itself. A flagged row stays mis-filed until a human
  acts, and today the only tool for the row is a shell script (§9). This is the honest trade for
  touching no `school_id`.
- **It is about the form's text vs the row** — which is exactly what was asked for. A row whose
  `school_id` an admin corrected by hand while the form still says something else **will still flag**,
  and that is correct: the form is still wrong.
- **The reconstruction approximates the Google Form's question order** with `sort_order` (§4.1). Exact
  for one school question; a documented approximation for two.
- **The `!` competes for attention** with the app's other warnings (the archived banner, the webhook
  prompts). Keep it inline and quiet; only the banner carries the consequence.
- **Not visible where the admin works in bulk** — the grid (§6). Increment 1 trades reach for
  correctness.

---

## 15. Scope

**Increment 1 — this plan**
`school-match.ts` (matcher + reconstruction) · `stored_school_name` + `school_match` on the detail
response · the inline `!` and the banner · tests. **No schema change, no `school_id` write, no routing
change.**

**Follow-ons, each independently reviewable**

| | item | note |
|---|---|---|
| 2 | `unsupported_answer_type` (§11.5) | take it in increment 1 if a checkbox school question is real |
| 3 | an admin *"submissions with an unmatched school"* worklist, and the grid column | needs a SQL-reachable or materialised verdict (§6) |
| 4 | per-row **Assign school** | the real remedy for a row the form cannot route (§9) |
| 5 | share `SCHOOL_NAME_ALIASES` with intake (**Q2 option B**) | the routing change, with its own review |
| 6 | record the verdict on the webhook-log row | makes the mismatch visible at arrival, not on open |

**Explicitly not in scope, ever:** fuzzy or distance-based school matching (**Q1**).

---

## 16. Files touched (increment 1)

| file | change |
|---|---|
| `server/src/db/school-match.ts` | **new** — `evaluateSchoolMatch`, `declaredSchoolName` |
| `server/src/db/school-match.test.ts` | **new** — the matcher and the agreement test |
| `server/src/db/queries.ts` | export the name lookup; `stored_school_name` in `getSubmissionByPublicId`; compute `school_match` in `getSubmissionDetail` |
| `server/src/db/schema.ts` | `SchoolMatch` type (types only — **no DDL**) |
| `server/src/routes/submissions.ts` | pass the verdict through the detail response |
| `server/src/swagger.ts` + inventory + `docs/features/swagger-ui.md` | the two new response fields |
| `client/src/types/index.ts` | `Submission.school_match`, `stored_school_name` |
| `client/src/pages/staff/StaffSubmissionDetail.tsx` | the inline `!` (both render sites) + the banner |
| `client/src/styles/global.css` | marker + banner styling, borrowing the existing warning tokens |




