# Plan — Google Form webhook for forms with **no defined fields**

**Status:** Draft for review
**Date:** 2026-10-02
**Area:** Inbound webhook (`POST /api/webhook/google`) + submission detail UI
**Related plans:** [`webhook.md`](./webhook.md), [`webhook-log.md`](./webhook-log.md),
[`google-script.md`](./google-script.md), [`google-form-url.md`](./google-form-url.md)

---

## 1. Goal

Let a Google Form whose questions were **never defined in the School Forms designer** still be
captured. Today the webhook can only store an answer that points at a pre-defined `form_field`
by numeric id, so a form with no defined fields fails and stores nothing.

New behaviour, in one sentence:

> **The webhook accepts questions identified by their Google Form title. A title that matches an
> existing form field is stored against that field exactly as it is today; a title that matches
> nothing becomes a per-submission `text` field so the answer is never lost.**

This is a **capture / safety-net** feature. It deliberately does **not** promote the captured
names into real form fields (see §11); the "proper" path — importing the Google Form's questions
as designer fields — is [`google-form-url.md`](./google-form-url.md), which still returns `501`
until the Forms OAuth scope is configured.

---

## 2. Where the error actually comes from (read this first)

The literal string **"No defined fields" is not in this repository.** Searched across all 175
tracked files, the nearest app-side messages are:

| String | Where | When it fires |
| --- | --- | --- |
| `"No fields found in that Google Form."` | `client/src/pages/admin/AdminFormDesigner.tsx:217` | Admin presses **Generate fields now** and the fetch returns none |
| `"No answers mapped to form fields. Check question titles against field labels."` | `docs/scripts/form-2.md:40`, `docs/plans/google-script.md:41` | **The Apps Script itself throws** when the title→id map produced zero answers |

So the failure the user is seeing is almost certainly the **Apps Script aborting before it ever
posts** — or a sibling script with similar wording. The chain is:

```
Google Form submitted
   └─ onFormSubmit(e)
        └─ getFieldMap(FORM_ID)  →  GET /api/forms/:id/public
              form has ZERO defined fields  →  { fields: [] }  →  fieldMap = {}
        └─ every question skipped
        └─ answers.length === 0
        └─ throw new Error('No answers mapped to form fields…')   ← "no defined fields"
   ✗ nothing is POSTed  →  ✗ nothing appears in the Webhook Log
```

**Two consequences this plan must fix:**

1. The script must stop depending on the field map (see §6).
2. Even if the script *did* post labels, the server would reject them: `submissionAnswerSchema`
   (`server/src/schemas.ts:368`) requires `field_id: z.coerce.number().int().positive()`, and
   `createSubmission` (`server/src/db/queries.ts:2091`) writes `submission_values.field_id`, whose
   FK points at `form_fields(id)`. A label — or a non-existent id — cannot be stored there.

> ⚠ **Observability gap worth stating out loud:** because the script throws client-side, the
> Webhook Log (`dbo.webhook_events`) records **nothing** for these failures. After this change the
> script always posts, so every Google submission — matched or captured — becomes a logged arrival.

---

## 3. The storage vehicle already exists — no migration

`dbo.submission_adhoc_fields` (`server/src/db/schema.ts:1271`) is a per-submission field:

```sql
CREATE TABLE dbo.submission_adhoc_fields (
  id INT IDENTITY(1,1) PRIMARY KEY,
  submission_id INT NOT NULL,
  label NVARCHAR(200) NOT NULL,
  type NVARCHAR(20) NOT NULL CHECK (type IN ('text','textarea','number','date','select','checkbox','radio','email','google_doc')),
  options NVARCHAR(MAX) NULL,
  value NVARCHAR(MAX) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_by INT NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  ...
);
```

It is already:

- **per-submission** — exactly the scope the request asks for ("…for the submission");
- **typed** — and `'text'` is already in the CHECK list, so a captured field is a legal row on every
  existing deployment (no DDL, no `google_doc`-style CHECK widening);
- **writable** — `createAdhocField()` (`server/src/db/queries.ts:2407`) already exists;
- **read back** — `getSubmissionDetail()` already returns it as `adhocFields`
  (`server/src/db/queries.ts:1940,1954`);
- **cascaded** — `ON DELETE CASCADE` on `submission_id`, so captured fields die with their submission;
- **already surfaced in Swagger** as `AdhocField` (`server/src/swagger.ts:330`).

**★ The zero-schema-change conclusion is the reason this plan is small.** Everything below is
application code.

> ⚠ One honest naming caveat: the table/comment call these "staff-only ad-hoc fields". Capturing
> Google answers into it makes them *submission-scoped* fields, not strictly staff-authored ones.
> `created_by` stays `NULL` for captured rows, which is the natural discriminator. See §12 Q1.

---

## 4. Payload contract — what changes

### 4.1 Today (must keep working)

```jsonc
POST /api/webhook/google
X-Webhook-Secret: …
{
  "form_id": 2,
  "answers": [ { "field_id": 11, "value": "Ada" } ]
}
```

### 4.2 After (additive)

Each answer item gains an **optional `label`**, and `field_id` becomes **optional**:

```jsonc
{
  "form_id": 2,
  "answers": [
    { "label": "Student name", "value": "Ada" },                 // matched by title, or captured as text
    { "field_id": 11, "value": "Ada" },                          // still valid — id wins
    { "field_id": 11, "label": "Student name", "value": "Ada" }  // both — id wins, label is a fallback
  ]
}
```

**Rules**

1. An item must carry **at least one** of `field_id` / `label` (zod `.refine`), and a `value`.
2. `answers` still requires **≥ 1** item (unchanged). A payload with no answers remains a caller bug.
3. `field_id` **wins** when present; `label` is consulted only when `field_id` is absent or does not
   resolve to a field on this form.
4. Matching a `label` to a form field is **trimmed + case-insensitive** — the same normalisation
   `resolveSubmissionSchoolId` already uses (`server/src/db/queries.ts:1994`).

### 4.3 Where the schema lives — **do not loosen the shared schema**

`createSubmissionSchema` is shared by **three** paths:

| Caller | File | Needs `field_id`? |
| --- | --- | --- |
| Public in-app parent submit | `server/src/routes/submissions.ts:39` | Yes — the app always sends ids |
| Webhook intake | `server/src/webhook/intake.ts:94` | **No** — this is the change |
| Webhook replay | `server/src/routes/webhookEvents.ts:370` → intake | No |

`submissionAnswerSchema` is **also** reused by `updateSubmissionValuesSchema`
(`server/src/schemas.ts:386`), whose DB write is a `submission_values` upsert keyed on `field_id`
— loosening the shared item type would let a label-only answer reach a path that cannot store it.

**Therefore:** add a **new, webhook-only** schema and leave both existing schemas byte-for-byte as
they are.

```ts
// server/src/schemas.ts — NEW, webhook only
const webhookAnswerSchema = z
  .object({
    field_id: z.coerce.number().int().positive().optional(),
    label: z.string().trim().min(1).max(200).optional(),
    value: answerValue,
  })
  .refine((a) => a.field_id !== undefined || a.label !== undefined, {
    message: "Each answer needs a field_id or a label",
  });

export const createWebhookSubmissionSchema = z.object({
  form_id: z.coerce.number().int().positive(),
  answers: z.array(webhookAnswerSchema).min(1),
});
```

`server/src/webhook/intake.ts` swaps `createSubmissionSchema` → `createWebhookSubmissionSchema`.
The other two callers are untouched.

---

## 5. Server behaviour — the resolution algorithm

### 5.1 New pure module (so it is unit-testable without a DB)

`queries.ts` imports `pool.js`/`driver`, so the codebase's DB-free tests read its source as
**strings** (`server/src/db/google-doc-field.test.ts`) rather than importing it. The matching logic
is pure, so put it where a normal unit test can import it:

**`server/src/webhook/field-mapping.ts` (new)** — imports types only, no DB:

```ts
export interface IncomingAnswer {          // the parsed webhook item
  field_id?: number;
  label?: string;
  value: string | number | boolean | string[] | null;
}
export interface MatchedField {            // a form's own field
  id: number;                              // caller normalises to Number()
  label: string;
  type: string;
}
export interface FieldPlan {
  values:   { field_id: number; value: IncomingAnswer["value"] }[];                  // → submission_values
  captured: { label: string; value: IncomingAnswer["value"]; sort_order: number }[]; // → ad-hoc, type 'text'
  schoolName: string | null;               // best-effort, from a School-labelled answer
}

export function normalizeLabel(s: string): string;                 // trim + case-fold
export function isEmptyAnswer(v: IncomingAnswer["value"]): boolean; // blank Google answers

export function planSubmissionFields(
  formFields: MatchedField[],
  answers: IncomingAnswer[],
  schoolLabels: readonly string[]
): FieldPlan;
```

`planSubmissionFields` is pure: given the form's fields and the answers, it returns what to write
where. Every interesting edge case lives here and is directly testable (§9).

### 5.2 Algorithm

```
byId    = Map(formFields.id → field)                   // id normalised to Number
byLabel = Map(normalizeLabel(field.label) → field)     // first field wins on collision

values = []; captured = []; seen = Set(); schoolName = null

for each answer a in payload order:
    if isEmptyAnswer(a.value):        continue         // blank optional question → nothing

    field = a.field_id != null ? byId.get(Number(a.field_id))
                               : byLabel.get(normalizeLabel(a.label))

    if field:                          values.push({ field_id: field.id, value: a.value })
    else:                                                  // ← the capture path
        label = (a.label ?? `Field ${index + 1}`).trim().slice(0, 200)
        if not seen.has(normalizeLabel(label)):            // dedupe identical titles
            seen.add(normalizeLabel(label))
            captured.push({ label, value: a.value, sort_order: captured.length })

    // School routing (best-effort, first match wins)
    if schoolName == null and a's field is school-labelled, or
       normalizeLabel(a.label) ∈ schoolLabels, and value is a non-empty string:
        schoolName = value.trim()
```

`createSubmission` (`server/src/db/queries.ts:2024`) then:

1. `const formFields = await listFormFields(form.id);`
2. `const plan = planSubmissionFields(formFields, answers, SCHOOL_FIELD_LABELS);`
3. Insert `submission_values` for `plan.values` (existing SQL, unchanged).
4. **New:** for each `plan.captured`, insert a `submission_adhoc_fields` row via the existing
   `createAdhocField` shape — `type: "text"`, `options: null`, `created_by: null`,
   `sort_order` from the plan.
5. Resolve the school per §5.3.

> ★ Two dials already documented in this file, applied to the new writes:
> - **ids arrive as strings** from the SQL Server driver (`queries.ts:1973`) — normalise with
>   `Number()` before the `Map` lookup, exactly as `resolveSubmissionSchoolId` warns.
> - **serialize like every other value** — reuse `serializeValue()` (`queries.ts:2381`) for the
>   ad-hoc `value` so arrays/booleans match `submission_values`.

### 5.3 School routing for zero-field forms (recommended, separable)

`resolveSubmissionSchoolId` (`server/src/db/queries.ts:1962`) only inspects **defined** fields, so a
district-wide form with no designer fields would file every response under the form's fallback
school. `planSubmissionFields` already surfaces `schoolName` from the raw labels, so pipe it in:

```
schoolId = plan.schoolName
             ? <lookup school by LOWER(name) = LOWER(@name)>   // reuse the query already inside
             : await resolveSubmissionSchoolId(form, values)   // defined fields (existing behaviour)
               ?? form.school_id ?? null
```

★ Reuse the exact case-insensitive lookup that already exists (`queries.ts:2008`) so SQL Server and
libSQL cannot disagree about which school matched.

> A clear win for the real use case, but **independent** of capture — marked **P2** in §10.

### 5.4 What must **not** change

- `POST /api/submissions` (in-app parent) — same schema, same SQL, always ids.
- The FK on `submission_values.field_id` — captured values never go there.
- `resolveSubmissionSchoolId`'s signature/behaviour for the in-app path.

---

## 6. The Apps Script (example + docs change)

`getFieldMap` is what makes a zero-field form impossible today. The minimal robust fix: **always
send the question title as `label`**, and send `field_id` too *only* when it resolves. Nothing is
dropped, and an empty field map now degrades to capture instead of an abort.

```js
function onFormSubmit(e) {
  const itemResponses = (e.response || e.source.getActiveResponse()).getItemResponses();
  const fieldMap = getFieldMap(FORM_ID);           // may be {} — that is now FINE

  const answers = [];
  itemResponses.forEach(function (itemResponse) {
    const title = itemResponse.getItem().getTitle();
    const raw = itemResponse.getResponse();
    const value = Array.isArray(raw) ? raw.map(String) : String(raw);

    const fieldId = fieldMap[title];
    // ★ Always carry the title; add field_id only when it resolves.
    answers.push(fieldId ? { field_id: fieldId, label: title, value }
                         : { label: title, value });
  });

  // ★ No more "no answers mapped" abort — an unmapped title is captured as text.
  if (answers.length === 0) {
    console.warn('No item responses to forward for form ' + FORM_ID);
    return;
  }

  const payload = { form_id: FORM_ID, answers: answers };
  const res = UrlFetchApp.fetch(API_BASE + '/api/webhook/google', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Webhook-Secret': WEBHOOK_SECRET },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const status = res.getResponseCode();
  if (status !== 201) throw new Error('Webhook failed (' + status + '): ' + res.getContentText());
  Logger.log('Submitted — HTTP ' + status + ' — ' + res.getContentText());
}
```

Update `docs/scripts/form-2.md` and `docs/plans/google-script.md` to this shape, and replace the
"titles must EXACTLY match labels" note with: *titles are matched to labels when they can be, and
otherwise captured as text fields on the submission.*

> **Backward compatibility:** an un-updated script that still sends `{field_id}` keeps working —
> matching by id is unchanged. Only the **zero-field** case needs the new script.

---

## 7. UI — the missing half (must ship with the backend)

**★ Captured fields are invisible today.** The whole ad-hoc stack exists — table, CRUD queries
(`queries.ts:2389-2470`), REST routes (`routes/submissions.ts:477-590`), client methods
(`client/src/lib/api.ts:876-920`), the `AdhocField` type, and even CSS (`.adhoc-composer`,
`.adhoc-field`, `.af-label` in `client/src/styles/global.css:1218-1223`) — **but a recursive search
of every `.tsx` finds no reference to `adhocFields`/`AdhocField`.** The feature was built
backend-first and never wired into a page.

So this plan must add the surface. Recommended minimum:

**`client/src/pages/staff/StaffSubmissionDetail.tsx`** — a new card between the parent answers and
the **Staff-only fields** card:

```
┌─ Additional fields ─────────────────────────────── ✎ Staff only ┐
│ Student ID     │ 48219                                            │
│ Course         │ Academic English                                  │
│ Teacher note   │ …                                                 │
└──────────────────────────────────────────────────────────────────┘
```

- Rendered only when `detail.adhocFields.length > 0`.
- Each row: `label` + value through the shared `FieldValue` component (so types render with the one
  existing type→control mapping, per that file's own header comment).
- Editing reuses the existing endpoints: `PUT /api/submissions/:publicId/adhoc/:fieldId`
  (`api.updateAdhocField`). The composer/add-remove controls are **optional** for v1 — the CSS is
  already present if we want them, via `api.createAdhocField` / `api.deleteAdhocField`.
- Distinguish captured from staff-authored rows with a small hint (`created_by === null` ⇒
  "captured from Google Form"), so a staff member knows where the row came from. Optional in v1;
  see §12 Q1.
- This page is also the admin view (`/admin/submissions/:publicId` renders the same component), so
  one change covers both roles.

> Not in scope for the card: **grid columns**. `SubmissionsGrid`/reports build columns from
> `form_fields` (via `/api/export/preview`), so per-submission captured fields are intentionally
> not columns. They are visible on the detail page. See §11 for the escalation path.

---

## 8. Edge cases & invariants

| # | Case | Required behaviour |
| - | --- | --- |
| 1 | Form has **zero** defined fields | Every answer is captured as `text`; submission succeeds (201) |
| 2 | Form has some fields; some titles match | Matched → `submission_values`; unmatched → captured |
| 3 | Answer carries **both** `field_id` and `label` | `field_id` wins |
| 4 | `field_id` present but **not on this form** | Falls back to `label` match, else captured (never a 500/FK error) |
| 5 | Duplicate titles in one payload | One captured field (first non-empty wins) |
| 6 | Blank answer (`""`, `null`, `[]`) | Skipped — no empty field created |
| 7 | `false` / `0` answers | **Kept** (they are real answers, matching `FieldValue.isEmpty`'s rule) |
| 8 | Title longer than 200 chars | Truncated to fit `label NVARCHAR(200)` |
| 9 | Answer has neither `field_id` nor `label` | `400 invalid_body` (schema refine) |
| 10 | Payload has zero answers | `400 invalid_body` (unchanged `.min(1)`) |
| 11 | Replay of a captured payload | Re-runs intake → new submission with the same captured fields (payload stored verbatim) |
| 12 | In-app `POST /api/submissions` | Completely unchanged |
| 13 | Value is an array (checkbox) | Stored via `serializeValue` → JSON text, decodable because type is a collection type… |

**★ On case 13:** `parseSubmissionValue` decodes a stored string as JSON **only** for types in
`COLLECTION_FIELD_TYPES` (`checkbox`, `multiselect`, `google_doc` — `schema.ts:99`). Captured
fields are stored as `text`, so an array value would be stored as JSON text but read back as the
literal string `["a","b"]`. **Two acceptable options:**

- **(A, recommended) Flatten on capture** — join arrays with `, ` before storing, so a captured
  checkbox question reads as `"a, b"`. Zero decode concern, matches how a `text` column should read.
- **(B)** Keep the JSON and extend the read path — but that means touching the collection-type rule
  for `text`, which would corrupt genuine text that happens to look like JSON. **Do not do this.**

The plan adopts **(A)**.

---

## 9. Tests

Runner: `vitest` (`npm --workspace server run test`). Two files.

### 9.1 `server/src/webhook/field-mapping.test.ts` (new — pure unit tests)

Imports `planSubmissionFields` directly (no DB). One test per §8 row, in the style of
`schemas.test.ts` (named so a failure explains the real-world defect):

| Test | Asserts |
| --- | --- |
| zero defined fields | every answer lands in `captured`, `values` is empty, `type` target is `text` |
| partial match | matched ids → `values`; unmatched → `captured` |
| `field_id` beats `label` | a wrong label with a right id still lands on the id |
| unknown `field_id` falls back | resolves by label; else captured — never dropped |
| id arrives as a **string** | `"11"` resolves (the driver's real behaviour, `queries.ts:1973`) |
| blank values skipped | `""`, `null`, `[]` produce nothing; `false`/`0` are kept |
| duplicate titles | one captured field |
| long title | truncated to 200 |
| school label | `schoolName` is set from a `School` / `School Name` label |
| array value | flattened to `"a, b"` (case 13 option A) |

### 9.2 `server/src/schemas.test.ts` (extend)

The file already guards the transmitted-id contract; add:

- accepts `{ label, value }` via `createWebhookSubmissionSchema`;
- accepts `{ field_id, label, value }` (both);
- **CONTROL:** rejects `{ value }` with neither;
- **CONTROL:** still rejects empty `answers`;
- **CONTROL:** `createSubmissionSchema` (in-app) still **rejects** a label-only answer — proving the
  change is scoped to the webhook and the parent path is untouched.

### 9.3 Not covered by unit tests (call out explicitly)

`createSubmission`'s DB writes are not unit-tested anywhere in this repo (it needs a live DB). The
matching/planning half is fully covered by 9.1; the two INSERTs are exercised by the manual probes
in §13. This split is deliberate — it is the same reason `google-doc-field.test.ts` inspects source
instead of importing `queries.ts`.

---

## 10. File map & sequencing

| # | Pri | File | Change |
| - | --- | --- | --- |
| 1 | **P1** | `server/src/webhook/field-mapping.ts` | **NEW** — pure `planSubmissionFields`, `normalizeLabel`, `isEmptyAnswer` |
| 2 | **P1** | `server/src/schemas.ts` | add `webhookAnswerSchema` + `createWebhookSubmissionSchema` (leave existing schemas alone) |
| 3 | **P1** | `server/src/webhook/intake.ts` | use the new schema; pass answers through |
| 4 | **P1** | `server/src/db/queries.ts` `createSubmission` | call `planSubmissionFields`; write `submission_values` **and** captured ad-hoc rows |
| 5 | **P1** | `client/src/pages/staff/StaffSubmissionDetail.tsx` | render the **Additional fields** card (§7) |
| 6 | **P1** | `server/src/swagger.ts` | document `label` (optional) on the `/api/webhook/google` answer item; mention capture in the description |
| 7 | **P1** | `docs/scripts/form-2.md`, `docs/plans/google-script.md` | new script shape + revised matching note (§6) |
| 8 | **P1** | `server/src/webhook/field-mapping.test.ts`, `server/src/schemas.test.ts` | tests (§9) |
| 9 | **P2** | `server/src/db/queries.ts` `resolveSubmissionSchoolId` / `createSubmission` | school from a captured `School` label (§5.3) |
| 10 | P3 | `client/src/types/index.ts` | optional `captured`/origin hint on `AdhocField` if §12 Q1 says yes |

**Suggested order:** 1 → 2 → 3 → 4 → 8 (backend green + tested) → 5 → 6 → 7 (surface + docs) → 9.

★ **Nothing here is a database migration.** `submission_adhoc_fields` already exists with `text`
in its CHECK on every deployment, and the plan adds no columns.

---

## 11. Out of scope & the escalation path

**Explicitly not in this plan:**

- **Promoting captured names into real form fields.** A captured field lives on **one** submission;
  it is not a column in the grid, reports, exports, or the designer. This is the correct scope for
  "capture what arrived", but an admin who wants `"Student ID"` as a real column must still define it.
- **Importing Google questions automatically.** That is [`google-form-url.md`](./google-form-url.md)
  / **Generate fields now** (`server/src/routes/forms.ts:265`), which returns `501` until the Forms
  OAuth scope exists. This plan is the safety net that makes the webhook useful *before* that lands.
- **Outbound webhooks** (`docs/features/webhook.md`) — unrelated.
- **Google file uploads → Drive/`google_doc` typing** for captured fields (they are always `text`).

**Escalation path (future, if wanted):** an admin action on the detail page — *"Promote captured
field to a form field"* — that creates a `form_fields` row and migrates that submission's value into
`submission_values`. This is only worth building once capture is in production and we can see which
labels recur. It is deliberately **not** in this plan.

---

## 12. Open questions (decide before build)

**Q1 — Should captured fields be labelled as such, and edited by staff?**
*Recommend:* yes to editing (reuse `FieldValue` + the existing `PUT …/adhoc/:fieldId`), and show a
subtle *"captured from Google Form"* hint when `created_by IS NULL`. If you would rather they were
read-only, we hide the edit control for captured rows — a small conditional.
→ **Options:** (a) editable + hint *(recommended)*; (b) read-only + hint; (c) editable, no hint.

**Q2 — Blank Google answers.** Google's `namedValues` returns `[""]` for unanswered questions.
*Recommend:* **skip** blanks (no empty captured field). Alternative: create the field with an empty
value so staff see the question exists. Skipping keeps the detail page clean and matches how
`submission_values` already behaves for unanswered optional fields.
→ **Options:** (a) skip blanks *(recommended)*; (b) create empty text fields.

**Q3 — Should the in-app parent endpoint (`POST /api/submissions`) also accept labels?**
*Recommend:* **no** for now — the in-app form always has defined fields, so capture there would only
mask designer mistakes. The new schema is webhook-only.
→ **Options:** (a) webhook only *(recommended)*; (b) both endpoints.

**Q4 — Where should captured fields appear?**
*Recommend:* the **submission detail page** only (§7), which is where "for the submission" data
already lives. Grids/reports remain form-definition-driven.
→ **Options:** (a) detail page only *(recommended)*; (b) also a read-only grid column for captured
fields (much larger: touches export column building, reports, CSV/XLSX/PDF writers).

---

## 13. Rollout & verification

1. **Backend first, behind no flag.** The change is purely additive: id-based payloads behave
   exactly as before. Deploy the server before touching any Apps Script.
2. **`npm --workspace server run test`** — 9.1/9.2 green; **`npm run typecheck`** clean.
3. **Manual probes** (mirror `docs/plans/webhook-log.md` §"Probes"):

```bash
# A — zero-field form: every answer captured, 201
curl -X POST "$API/api/webhook/google" -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $SECRET" \
  -d '{"form_id":2,"answers":[{"label":"Student name","value":"Ada"},{"label":"Grade","value":"9"}]}'
# → 201 { public_id: … }; open the submission: Student name / Grade appear as added fields

# B — mixed: one matched by id, one captured
curl -X POST "$API/api/webhook/google" -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $SECRET" \
  -d '{"form_id":2,"answers":[{"field_id":11,"value":"Ada"},{"label":"Unmapped","value":"x"}]}'

# C — backward compat: the OLD payload shape still succeeds
curl -X POST "$API/api/webhook/google" -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $SECRET" \
  -d '{"form_id":2,"answers":[{"field_id":11,"value":"Ada"}]}'

# D — CONTROL: an answer with neither id nor label → 400 invalid_body (and a Webhook Log row)
curl -X POST "$API/api/webhook/google" -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $SECRET" -d '{"form_id":2,"answers":[{"value":"Ada"}]}'
```

4. **Update the Apps Script** (§6) and submit the real Google Form once. Confirm:
   - the submission appears in the staff queue;
   - its detail page shows the captured fields;
   - a **succeeded** row appears in **Settings → Webhook Log** (this is the first time these
     submissions are visible there at all).
5. **Replay probe:** unpublish the form, submit, confirm a failed row, republish, replay it —
   the captured fields should be created on the delivered submission.

---

## 14. Summary of the change in one paragraph

A Google Form whose questions were never defined in the designer currently can't be captured: the
Apps Script aborts on an empty field map (the "no defined fields" error) and would be rejected by
the server even if it posted, because every answer must carry a `form_fields.id`. This plan makes the
webhook **self-defining**: answers may be identified by their Google Form title; a title that matches
a defined field is stored as today, and a title that matches nothing is stored as a per-submission
**`text`** field in `submission_adhoc_fields` — a table that already exists, already allows `text`,
and already cascades with its submission, so **there is no migration**. The change is confined to
the webhook schema, the submission-intake mapping, one new pure+tested module, and a detail-page card
(the ad-hoc API/CSS exist but were never wired into any page). The in-app parent path is untouched.
