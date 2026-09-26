# System Messages (Admin-authored notices)

**Status:** ✅ **Approved — implementing.** §13 is answered (all six); the two answers that changed
the design are recorded in §3 decision 11 (**no close-out counts**) and decision 15 (**at most three
stacked messages**, capped server-side).
**Date:** 2026-09-26
**Area:** Admin → Settings → **System Messages** (authoring) · every signed-in page (display)
**Related:** [`docs/plans/webhook-log.md`](./webhook-log.md) (the closest precedent — an admin-only
section in Settings with its own router and table), [`docs/plans/password-recovery.md`](./password-recovery.md)
(in-drawer confirm step), [`docs/plans/dual-db.md`](./dual-db.md) §5.3 (the two-dialect rule),
[`docs/plans/delete-form.md`](./delete-form.md) (destructive-action precedent)

---

## 1. What was asked

> "I need a plan for adding 'System Messages' to the application. This is an Administrative
> function in Settings. When the person logs in, they can read the message and then close it
> out. See image for design. Admins can add a message Title, Description, toggle
> Active/Inactive, and Delete."

The attached image settles the one thing that a text description could not: **where the message
appears**. It is not a modal and not a toast. It is a full-width, light-background notice strip
rendered **directly beneath the app banner** and above the page content:

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ☰   [SF] School Forms                          [KK] Kevin Key  ▾   ⎋       │  header.banner
├───────────────────────────────────────────────────────────────────────────┤  .banner border-bottom
│ Note: you can now Archive older submissions. Click edit and look for      │  ← the new strip
│ the Archive button on the upper-right hand corner of the screen.          │
├───────────────────────────────────────────────────────────────────────────┤  its own border-bottom
│ CDM Non-Traditional Submission — Ashlynn Pineda Alvarez                    │  main.main
│ CDM2-00277                                                                │
│ Select Status [Submitted ▾]  [ARCHIVE]  [EDIT]  [BACK TO QUEUE]           │
```

Two visual facts are load-bearing and both already exist in the stylesheet, which is a good sign
the strip is a natural fit rather than a foreign element:

- `.banner` carries `border-bottom: 1px solid var(--border)` (global.css:100) — that is the rule
  **above** the strip.
- `.app-shell` is `display:flex; flex-direction:column` (global.css:82) — so a new child placed
  between `</header>` and `<div className="body-flex">` automatically spans the full shell width
  and pushes the content down, exactly as the image shows.

The strip in the image carries **no close control**. That is the one affordance the picture does
not supply, and "then close it out" in the request makes it mandatory — §4 designs it.

---

## 2. Current state

Nothing of this feature exists. Verified, not assumed:

| Claim | How it was checked | Result |
| --- | --- | --- |
| No `system_messages` table | `grep` for `system_message` across `server/src/db/` | 0 hits |
| No plan for it | `grep` `release_note\|system_message\|notice\|dismiss` in `docs/plans/*.md` | 1 hit, and it is `view-designer.md` D1 ("dismiss" meaning a design choice) |
| The text in the image is illustrative, not real content | `grep` the whole workspace for `you can now Archive older submissions` | 0 hits |
| No client-side notice mechanism to extend | `grep` `localStorage.` under `client/src` | 3 hits, all in `lib/api.ts` (the token) |

So this is a new feature from the ground up. The nearest thing to it in the codebase is the
**Webhook Log** section of Admin Settings, and this plan follows it deliberately — including the
comment it carries about *not* adding a second visibility switch:

> *"Q2 was explicit: `role === 'admin'` is the single gate. There is no `menu_items` key and no
> `app_settings` flag, so there is nothing else to check — do not add a second, overlapping
> visibility switch."* — `server/src/routes/webhookEvents.ts`

The same rule applies here: **authoring is `admin`-only, in one place, with no extra flag.**

---

## 3. Design decisions

| # | Decision | Why |
| --- | --- | --- |
| 1 | **A full-width strip in the app shell, not a modal.** | The image shows it. It is also the right answer independently: a modal interrupts the task the user came to do, and a *notice* that must be read before you can continue is a different feature (a maintenance gate, which the app already has). The strip is passive, readable, and dismissible. |
| 2 | **Per-user, server-persisted dismissal.** | "When the person logs in, they can read the message and then close it out" — **next login it must not be back**. That rules out client-only state (`localStorage` is cleared by a different browser, a different device, or a cache wipe, and would re-nag the same person). It also rules out a single global "closed" flag, which would let the first person to click X hide the notice for everyone. Hence a join table keyed on `(message_id, user_id)`. |
| 3 | **Messages are organization-scoped (`organization_id NOT NULL`).** | The app is multi-tenant and this is a hard invariant everywhere else. A globally visible row authored by one tenant's admin would be **another tenant's staff reading that admin's prose** — a cross-tenant content leak with no mechanism to notice it. Every read and every write filters on the caller's org claim, exactly as `webhookEvents.ts` does via `scopeOf(user)`. |
| 4 | **A new router (`routes/systemMessages.ts`) and a new table, not an `app_settings` value.** | `app_settings` is a key→string store for *single* values read by key (`login_mode`, `documents_link`, …). This feature is a **collection** with per-row CRUD, an active flag, and a per-user relation — three things a key/value store cannot express without inventing a JSON blob that then has to be parsed, validated, and re-written by every reader. The Webhook Log reached the same conclusion. |
| 5 | **No foreign keys on either new table.** | Matches `webhook_events` ("DELIBERATELY HAS NO FOREIGN KEYS") and avoids SQL Server error 1785 the moment a second cascade path appears. The one relation that genuinely needs cleaning up (dismissals when a message is deleted) is handled explicitly in the delete statement, in the same transaction — which is *more* visible than a cascade hiding in DDL. |
| 6 | **Identity PK `(message_id, user_id)` on the dismissals table.** | Makes the dismiss idempotent for free: a second click cannot create a second row, and `INSERT … SELECT … WHERE NOT EXISTS` is the portable upsert shape this repo already uses. |
| 7 | **Nothing is authored as "published at a time".** `active` alone decides visibility; `created_at` is only ever a sort key and a display value. | A scheduled or expiring notice is a materially larger feature (a clock, a timezone, a "why didn't it show" question) and the request asks for a toggle, not a scheduler. |
| 8 | **Hard delete, behind a confirm step inside the drawer.** | The request says *Delete*. Following `password-recovery.md` decision 8, the confirmation lives in the drawer that already owns the record rather than in a second overlay, so "which Cancel am I clicking?" never arises. |
| 9 | **The delete confirmation names what else it destroys.** | Deleting a message also deletes everyone's dismissal rows for it. The consequence is non-obvious, so the confirm states it ("everyone's close-outs recorded against it are removed as well") instead of implying the row is all that goes. The count is deliberately NOT shown — see decision 11: the admin panel never reports close-out numbers at all, so a single number here would be the feature's only one and would need the denominator it cannot have. |
| 10 | **Dismissal is *not* optimistic.** The X disables, the POST runs, and the strip disappears only on success; a failure shows an inline message and re-enables the button. | An optimistic hide that silently fails is the "`catch → setRows([])`" trap from this repo's own history: a failed close and a successful one look identical. The round-trip is a few milliseconds and the user has just clicked one button. |
| 11 | **No close-out counts anywhere (Q5).** The admin grid shows Message / Status only; no `closed_count`, no `audience_count`, no "12 of 34". | A count of a relation names neither end of it, so the honest form needs its denominator — and a denominator that means "everyone who could have seen it" is a second, separately-scoped query whose answer changes under the reader's feet (a user added tomorrow changes yesterday's fraction). The product owner chose to drop it rather than ship a number that needs that much explaining; deleting a message still states that close-outs go with it, without a figure. |
| 12 | **No `aria-live` on the strip.** | `AppShell` is declared **per route** in `App.tsx` (every `<Route element={<ProtectedRoute><AppShell>…` is its own element), so React remounts the shell on every navigation. A live region would therefore re-announce the notice to a screen reader on **every page change**. A plain labelled region is correct for static content. |
| 13 | **No new dialect builder.** | The statements here are portable (`SELECT … WHERE …`, `INSERT … SELECT … WHERE NOT EXISTS`, `NOT EXISTS`), so they belong in `queries.ts`. A dialect builder exists for SQL that genuinely differs per engine (JSON parsing, `RETURNING` vs `OUTPUT`). Adding an unnecessary one would also force a matching entry in `libsql.test.ts`, which diffs the two dialects' member sets with `toEqual`. |
| 14 | **`title` is required (1–200), `body` optional (0–4000), and Save is disabled while the title is blank.** | An active message with an empty title renders a strip containing nothing but a stray X. The org drawer already uses exactly this guard (`disabled={orgSaving \|\| !orgForm.name.trim()}`). |
| 15 | **At most three messages are shown at once, and the cap is applied SERVER-side (Q6).** | The user asked for a stack with a maximum of three. The cap must be in the query, not in the client, or the client is silently hiding rows it was handed — the exact bug class this repo already has a rule for (`slice(0, N).filter(pred)` denies that matches exist). Because `SELECT TOP 3` is SQL Server-only and `libsql.test.ts` bans `TOP n` from shared files, the cap goes through `dialect().selectPage({ select, from, where, orderBy })` with `pageSize: 3` — the one existing builder that already knows both spellings. **The strip says nothing about there being more**: a message that will not render until somebody closes another is a reasonable product choice, but a "2 more" counter would be a second feature (what does clicking it do?), and Q6b was declined. |

---

## 4. The design the image does not show: closing it out

The strip needs a close control. Three candidate semantics, one recommendation:

| Option | Behaviour | Verdict |
| --- | --- | --- |
| **A. Per-user, persisted** — *recommended* | Clicking X writes `(message_id, user_id)` and that person never sees that message again, on any device, forever — until the row is deleted or deactivated. | **What the request describes.** "When the person logs in, they can read the message and then close it out" reads as a one-time interruption, not a per-session nag. It is also the only option where an admin can usefully answer "did everyone see it?" |
| B. Global closed flag | The first person to click X hides the notice for every other user. | **Wrong.** One staff member silently dismisses an announcement aimed at everyone, and nothing records that it happened. |
| C. Session / `localStorage` only | The notice returns on the next sign-in or the next browser. | **Wrong for the stated intent**, and inconsistent across devices in the same session. Only defensible if the message is a maintenance banner, which this is not. |

**Recommended: A.** The consequence to accept knowingly: an admin who edits a message's wording
after some people have closed it **reaches only the people who have not yet closed it**. Editing
does not resurrect it. That is the least surprising rule (an edit is not a re-send), and an admin
who genuinely needs a second announcement has the honest tool for it — a new message. Flagged as
Q2 in case the product owner prefers "editing re-opens it for everyone".

---

## 5. Data model

Two tables. Both dialects. **Four** registration points, not two — this is the trap that has bitten
this repo before (a column added to one dialect is silent, because nothing errors).

### 5.1 `dbo.system_messages`

SQL Server — append to `SQLSERVER_DDL_STATEMENTS` in `server/src/db/schema.ts`, in the same
guarded style as the `webhook_events` block:

```sql
IF OBJECT_ID('dbo.system_messages', 'U') IS NULL
CREATE TABLE dbo.system_messages (
  id              INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  organization_id INT NOT NULL,
  title           NVARCHAR(200) NOT NULL,
  body            NVARCHAR(MAX) NOT NULL CONSTRAINT DF_system_messages_body DEFAULT (''),
  active          BIT NOT NULL CONSTRAINT DF_system_messages_active DEFAULT (0),
  created_by      INT NULL,
  created_at      DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at      DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
```

Its index goes in a **separate** guarded statement (a `CREATE INDEX` in the same batch as the
`CREATE TABLE` that defines the table is SQL Server error 207 — the same reason the
`webhook_events` indexes are declared apart from its `CREATE TABLE`):

```sql
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_system_messages_org_active')
CREATE INDEX IX_system_messages_org_active
  ON dbo.system_messages (organization_id, active, created_at);
```

`created_by` is nullable and is **not** a foreign key (§3 decision 5). Store the admin's user id as
a plain integer so "who wrote this" survives an account deletion; if the account is gone, the id
still resolves to nothing and the UI says so rather than erroring.

Turso — append to `TURSO_DDL` in `server/src/db/dialect/turso.ts`, using `NOW_DEFAULT` for the
timestamp defaults (that is what `NOW_DEFAULT` exists for):

```sql
CREATE TABLE IF NOT EXISTS system_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  active          INTEGER NOT NULL DEFAULT 0,
  created_by      INTEGER,
  created_at      TEXT NOT NULL DEFAULT (NOW_DEFAULT),
  updated_at      TEXT NOT NULL DEFAULT (NOW_DEFAULT)
);
CREATE INDEX IF NOT EXISTS IX_system_messages_org_active
  ON system_messages (organization_id, active, created_at);
```

### 5.2 `dbo.system_message_dismissals`

```sql
IF OBJECT_ID('dbo.system_message_dismissals', 'U') IS NULL
CREATE TABLE dbo.system_message_dismissals (
  message_id   INT NOT NULL,
  user_id      INT NOT NULL,
  dismissed_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_system_message_dismissals PRIMARY KEY (message_id, user_id)
);
```

```sql
CREATE TABLE IF NOT EXISTS system_message_dismissals (
  message_id   INTEGER NOT NULL,
  user_id      INTEGER NOT NULL,
  dismissed_at TEXT NOT NULL DEFAULT (NOW_DEFAULT),
  PRIMARY KEY (message_id, user_id)
);
```

No `IF COL_LENGTH` addition is needed for either table because **both are new** — the guarded
`IF OBJECT_ID … IS NULL` is the whole migration. (§6 covers what to do if a column is ever added
later, because "new table" and "new column" take different paths and only the new-column path needs
`addColumns`.)

### 5.3 The four registration points

| # | Where | What | Needed? |
| --- | --- | --- | --- |
| 1 | `server/src/db/schema.ts` → `SQLSERVER_DDL_STATEMENTS` | guarded `CREATE TABLE` + guarded `CREATE INDEX` | ✅ always — a table missing here does not exist on SQL Server |
| 2 | `server/src/db/dialect/turso.ts` → `TURSO_DDL` | `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` | ✅ always — `TURSO_DDL` is the **final** schema and is never altered, so a table absent here never appears |
| 3 | `server/src/db/dialect/types.ts` → `AddColumn` + `turso.ts` `addColumns` | only for a **column added to an existing table after launch** | ❌ **not needed now** — both tables are new. If a field is added later, this is mandatory *in addition to* the `ALTER` in the ladder, or Turso silently lacks the column while SQL Server has it |
| 4 | `server/src/db/client.ts` → `BOOLEAN_COLUMNS` / `TIMESTAMP_COLUMNS` | `active` → booleans; `dismissed_at` → timestamps | `active` ✅ **already present** (`BOOLEAN_COLUMNS` is `active, required, staff_only, is_default, show_on_test_screen`) — `normalizeRow` keys on the column *name*, so `system_messages.active` is normalized for free. `dismissed_at` ⚠️ **must be added** to `TIMESTAMP_COLUMNS` |

`created_at` and `updated_at` are also already in `TIMESTAMP_COLUMNS`, so the only edit to
`client.ts` is one word: `dismissed_at`.

> **Why `dismissed_at` matters and is not cosmetic.** `normalizeRow` converts a timestamp column to
> a real `Date`/ISO value. A timestamp column left out of the set is served to the client in
> whatever raw shape the driver produced — and on SQL Server that is the same class of difference
> that took the whole deployment down once (see the `Number.isInteger` note in `requireAuth`). Add
> it on the same commit as the table, and never "later".

**Inert defaults:** `active` defaults to `0`/`false` and `body` to `''`. Nothing about deploying
this changes any behaviour until an admin creates and activates a message.

---

## 6. API surface

New router `server/src/routes/systemMessages.ts`, mounted in `server/src/index.ts` alongside the
others as `app.use("/api/system-messages", systemMessagesRouter)`.

| Method & path | Who | Purpose | Success | Failure modes |
| --- | --- | --- | --- | --- |
| `GET /api/system-messages` | admin | every message in the caller's org, with its close-out fraction | `200 {messages:[…]}` | `500` |
| `POST /api/system-messages` | admin | create | `201 {message:{…}}` | `400 VALIDATION_FAILED` (bad shape) |
| `PUT /api/system-messages/{id}` | admin | update title/body/active | `200 {message:{…}}` | `400` (bad shape) · `400 INVALID_ID` (non-numeric) · `404` (not in your org, or gone) |
| `DELETE /api/system-messages/{id}` | admin | delete the message **and its dismissals** | `200 {ok:true, dismissals_removed:n}` | `400` (non-numeric id) · `404` |
| `GET /api/system-messages/active` | **any signed-in role** | the caller's un-dismissed active messages | `200 {messages:[…]}` | never 401 for a valid session |
| `POST /api/system-messages/{id}/dismiss` | **any signed-in role** | close it out for the caller | `200 {ok:true}` (idempotent) | `400` (non-numeric id) · `404` (not visible to you) |

Registration is required in **three** places — the router, `routes/inventory.ts` (`ROUTES`), and
`swagger.ts` (`paths`) — because `swagger.test.ts` fails on a mounted-but-undocumented route *and*
on a documented-but-unmounted one. `auth` values for `inventory.ts`:

- `"staff"` for the two any-role endpoints. In this registry `"staff"` is the existing shorthand
  for `requireRoles("staff", "cdm_contact", "admin")` — that is how every route in `submissions.ts`,
  `forms.ts`, `documents.ts` and `export.ts` is labelled, so it must be used here too or the guard
  and the registry disagree.
- `"admin"` for the four authoring endpoints.
- New tag: `"System Messages"`. `swagger.ts` has **no top-level `tags` array** (tags are
  per-operation only), so this needs no central registration.

### 6.1 The route that must be declared first

`/api/system-messages/active` is a **single-segment** path. Today it collides with nothing, because
there is no `GET /{id}`. It must still be registered **before** any `/{id}` handler, with a comment
saying why, so that adding a `GET /{id}` later does not silently start capturing `active` as an
id — the same hazard `submissions.ts` avoids by using the two-segment `/archive/counts`, and the
same one `index.ts` avoids by mounting `/api/webhook/events` *before* `/api/webhook`.

### 6.2 Status-code rules this codebase enforces

- **A domain error must never be 401.** `request<T>()` in `client/src/lib/api.ts` treats *any* 401
  on an authenticated call as an expired session: it clears the token, calls `/auth/refresh`, and
  replays. A 401 here would sign the user out and re-run the request — and the dismiss would still
  not have happened. Every failure above is `400` or `404`.
- **404 covers three cases with one message** — no such row, wrong organization, or inactive —
  following the `GET /api/webhook/events/{id}` precedent verbatim: *"404 covers both 'no such row'
  and 'not in your organization' on purpose, so the response cannot be used to probe for another
  organization's events."* Same here, plus "inactive", so a curious user cannot enumerate which
  message ids exist.
- **Dismissing twice is 200, not 409.** The X can be double-clicked, and a retry after a dropped
  response must not read as an error. `INSERT … SELECT … WHERE NOT EXISTS` makes it a no-op.
- **A malformed body is validated before the auth guard runs** (the framework's ordering, documented
  in this repo): an anonymous `POST` with `{}` answers `400 VALIDATION_FAILED`, not `401`. Test the
  guard with a *valid* body or you are testing the validator.

### 6.3 Response shapes

```jsonc
// GET /api/system-messages  (admin)
{
  "messages": [
    {
      "id": 1,
      "title": "Note: you can now Archive older submissions.",
      "body": "Click edit and look for the Archive button on the upper-right hand corner of the screen.",
      "active": true,
      "created_at": "2026-09-26T14:02:11.000Z",
      "updated_at": "2026-09-26T14:02:11.000Z"
    }
  ]
}
// No close-out counters (Q5, §3 decision 11).

// GET /api/system-messages/active  (any signed-in role)
// Deliberately omits organization_id, created_by and active: the caller needs
// none of them, and an omitted field cannot leak.
{ "messages": [ { "id": 1, "title": "…", "body": "…", "created_at": "…" } ] }
```

Ordering for `/active`: `ORDER BY created_at DESC, id DESC` — the newest announcement is the one
worth reading first, and the `id` tiebreaker makes the order deterministic when two rows share a
timestamp (which they will, if an admin creates two in the same second on a fast machine or in the
same transaction in a test).

---

## 7. Server: storage functions

All in `server/src/db/queries.ts`, using the existing dialect helpers (`insertReturning`,
`updateReturning`, `deleteReturning`) — see `createForm`, `updateForm`, `deleteForm` for the shape.
No new dialect builder (§3 decision 13).

| Function | Scoping | Notes |
| --- | --- | --- |
| `listSystemMessages(organizationId)` | `WHERE organization_id = @organizationId` | one query; the two counts are correlated subqueries so the panel cannot render a count from a different snapshot than the row it labels |
| `listActiveSystemMessagesForUser(organizationId, userId)` | `WHERE organization_id = @org AND active = 1 AND NOT EXISTS (SELECT 1 FROM dbo.system_message_dismissals d WHERE d.message_id = m.id AND d.user_id = @userId)` | the one read that must be right. `NOT EXISTS` (not `NOT IN`) so a NULL `user_id` cannot silently empty the result |
| `getSystemMessage(id, organizationId)` | both | returns `null` when the row exists in another org — the guard for every write |
| `createSystemMessage({organizationId, createdBy, title, body, active})` | org on insert | `created_at`/`updated_at` from the column defaults |
| `updateSystemMessage(id, organizationId, {title, body, active})` | both in the `WHERE` | sets `updated_at` explicitly; returns the updated row |
| `deleteSystemMessage(id, organizationId)` | both | returns `{deleted, dismissalsRemoved}` — the dismissal delete and the message delete run in one transaction |
| `dismissSystemMessage(messageId, userId)` | inserts only after re-checking the message is active **and in the caller's org** | `INSERT … SELECT @messageId, @userId WHERE NOT EXISTS (…)`; SQLite has no `IF`, and SQL Server genuinely accepts `WHERE` without `FROM` (this is the portable shape already used in `upsertSetting`) |

**The org check on dismiss is the security-relevant one.** The write is a two-column insert whose
`message_id` comes straight off the URL. Without re-checking `organization_id` on the *message* at
insert time, a user could register a dismissal against another tenant's message id — harmless today
(they cannot see it) but it becomes a real leak the moment anyone counts dismissals for a message
they do not own, which §3 decision 11 does. So: resolve the message first, then insert. The route
answers `404` when that lookup is falsy.

---

## 8. Client: the strip

New component `client/src/components/SystemMessageBar.tsx`, rendered by `AppShell` in
`client/src/components/layout.tsx`.

### 8.1 Where it goes, precisely

```tsx
<div className="app-shell">
  <header className="banner">…</header>
  <SystemMessageBar />          {/* ← new: sibling of header, NOT inside main */}
  <div className="body-flex">
    …rail, main…
  </div>
</div>
```

- **Sibling of `<header>`, not a child of `<main>`.** `.app-shell` is a column flex container, so
  a sibling gets its own full-width row and pushes `.body-flex` down — the image's layout, with
  `.banner`'s existing `border-bottom` as the rule above it. Putting it inside `.main` would inset
  it by `.main`'s `padding: 20px 24px` and make the strip start below the page head.
- **It is therefore on every authenticated page** — dashboard, queue, admin, reports, account —
  which is what "when the person logs in, they can read the message" asks for.
- **It is automatically absent where it should be absent**, with no extra code:
  - the **login** and **register** pages do not use `AppShell` at all;
  - the **forced password change** page is deliberately *outside* `AppShell` (`App.tsx` carries a
    comment saying so) — so a notice cannot compete with a screen whose whole point is that nothing
    else is available yet.

### 8.2 Behaviour

| Moment | What happens |
| --- | --- |
| Mount | `api.getActiveSystemMessages()`. On failure: **render nothing and log** — do *not* show an error strip. A message strip that fails to load is invisible by definition; there is nothing to read and no reason to alarm anyone. (This is the one place where "failure looks like empty" is the *correct* behaviour, and it is worth a comment saying so, because everywhere else in this app it is a bug — see the `StaffQueue.tsx` precedent.) |
| Render, 0 messages | `null`. No empty container, no layout shift. |
| Render, N messages | N strips (N ≤ **3** — the cap is applied by the API, not here; see §3 decision 15) in the order returned, each with its own X. |
| Click X | disable that X → `POST …/dismiss` → on success remove that message from state; on failure re-enable it and show a small inline `Could not close this message — try again.` |
| Last strip removed | **move focus** — to the next strip's X if one remains, otherwise to `main.main` (given `tabIndex={-1}`). Without this the focused button unmounts and focus falls to `<body>`, which drops a keyboard user at the top of the document with no feedback. |

### 8.3 Markup

```tsx
<div className="sysmsg-stack" role="region" aria-label="System messages">
  {messages.map((m) => (
    <div className="sysmsg-bar" key={m.id}>
      <p className="sysmsg-text">
        <strong>{m.title}</strong>
        {m.body ? <> {m.body}</> : null}
      </p>
      <button
        type="button"
        className="icon-button sysmsg-close"
        title="Close this message"
        aria-label="Close this message"
        disabled={busyId === m.id}
        onClick={() => void close(m.id)}
      >
        <X size={16} />
      </button>
    </div>
  ))}
</div>
```

Three deliberate details:

- **A single `<p>` with a nested `<strong>`, not a flex row of siblings.** A flex container with a
  `gap` turns a bare text node next to an element into its own flex item and the gap lands between
  the fragments — the `.scopenote` bug, which renders ragged while every number in the block is
  still correct and so survives content assertions. A `<p>` cannot do this.
- **Both `title` and `aria-label` on the X.** An icon-only button has an **empty `textContent`**, so
  a probe using `button:has-text("Close")` times out even though the button's accessible name is
  `Close this message`. Match the attribute (`button[title="Close this message"]`) or use
  `getByRole('button', { name: 'Close this message' })`.
- **The title is the caller's text, unmodified.** The image's `Note:` is part of the message the
  admin typed, not a hard-coded prefix — otherwise an admin who writes "Reminder:" would get
  "Note: Reminder: …". (Confirm with Q4.)

### 8.4 Style — append to `client/src/styles/global.css`, next to the shell rules

```css
/* ===== System message strip ===== */
.sysmsg-stack { flex-shrink: 0; }
.sysmsg-bar {
  display: flex; align-items: flex-start; gap: 16px;
  padding: 10px 24px;
  background: var(--filled-bg);
  color: var(--filled-fg);
  border-bottom: 1px solid var(--tint-line);
}
.sysmsg-text { flex: 1 1 auto; min-width: 0; font-size: 13px; line-height: 1.5; }
.sysmsg-text strong { font-weight: 700; }
```

- The colour trio is the **same one `.alert-success` and `.badge-blue` already use**
  (`--filled-bg` / `--filled-fg` / `--tint-line`, defined at global.css:28–34), so the strip is
  legible on the app's one existing theme without inventing a colour. This app has **no
  `data-theme` selector and no dark-mode block** — verified this session — so there is no dark
  variant to add and no dark contrast to measure.
- **`.sysmsg-close` needs no rule.** `.icon-button` (global.css:264) is already
  `width: 36px; height: 36px; display: inline-flex; justify-content: center; align-items: center`,
  which is exactly `--control-h` — the single height every action control in this app shares
  (global.css:262–281 explains why it is `height` and not `min-height`). Writing a width/height for
  the X anyway would be a redundant override of a rule that already does the job, which is how the
  next reader learns to distrust the sheet.
- `.sysmsg-stack` gets `flex-shrink: 0` so a tall page cannot compress the strip; `.banner` carries
  the same rule for the same reason.
- `padding: 10px 24px` matches `.banner`'s `padding: 0 24px` horizontal inset, which is what makes
  the strip's text line up with the logo in the image.

---

## 9. Client: the admin panel

A new `CollapsibleSection` in `client/src/pages/admin/AdminSettings.tsx`, alongside the existing
ten, following the **Organizations** section (the closest match: a table of rows with a toolbar,
an edit drawer and a destructive action).

- **Placement:** after Webhook Log and before Organizations. Rationale: the authoring panels come
  before the entity-management panels in the current ordering, and putting it last would bury a
  feature whose whole purpose is to be noticed.
- **Header:** `title="System Messages"`, `subtitle="Notices shown to everyone in your organization until each person closes them."`, `bodyStyle={{padding:0}}` (it owns a grid).
- **Toolbar:** `+ Add Message` (`primary-button`), matching `+ Add Organization`.
- **Grid:** `table.grid` inside `.grid-wrap`, **three** columns — **modelled on the Organizations
  table (lines 974–1010) line for line**, because that table is the same shape: rows with an active
  flag, an editor opened by clicking the row, and a destructive action.

  | Message | Status | *(no header)* |
  | --- | --- | --- |
  | title (`cell-strong`) + body on a second line (`cell-mono`) | inline `Toggle` + `badge badge-green` "Active" / `badge badge-gray` "Inactive" | `Delete` (`.badge-button.danger`) |

  Three columns, not four: the `Closed by` column was dropped (Q5, §3 decision 11). **`colSpan={3}`
  on the loading and empty rows** — a stale `colSpan` renders a half-width row that looks like a
  layout bug.

  Four details that must be copied from the Organizations table rather than improvised:

  1. **`badge-gray` for Inactive, not `badge-blue`.** `.badge-blue`, `.badge-green` and `.badge-teal`
     are **the same three colours** (global.css:410/411/416 — all `--filled-fg` on `--filled-bg`
     with `--tint-line`) and differ only in name, so an Active/Inactive pair using two of them
     renders **identically** while looking correct in the source. `.badge-gray` (global.css:417) is
     the muted one and is what the Organizations table uses for exactly this pair.
  2. **Every `<td>` that carries content gets a `data-label`.** The mobile breakpoint (global.css:1120)
     stacks `table.grid` into cards using `content: attr(data-label)`, so a cell without one loses
     its label on a phone. The values are `data-label="Message"` etc. — matching the `<th>` text.
  3. **The action cell deliberately has NO `data-label`.** `table.grid tbody td:not([data-label])`
     (global.css:1187) is the sanctioned full-width action row on mobile. That is why the fourth
     column has no header above.
  4. **The row opens the editor** (`<td onClick={() => openMsgEdit(m)} style={{cursor:"pointer"}}>`
     on the content cells), the way the Organizations and Users rows do. An "Edit" button would be a
     second control in a two-column grid whose whole point is that the row *is* the editor.
- **Create/edit:** the existing right slide-out drawer (`drawer-overlay`/`drawer`), three fields —
  `Title` (`input.edit-input`, required), `Description` (`textarea.edit-input`, `rows={6}`),
  `Active` (a `Field label="Active" full` wrapping a `Toggle`, exactly as the Organizations drawer
  does, with a muted note under it stating what Active means: *"Inactive — nobody sees this message.
  Close-outs already recorded are kept, so reactivating it will not re-show it to the people who
  already closed it."*). Save is disabled while the title is blank (§3 decision 14) — the same guard
  as `disabled={orgSaving || !orgForm.name.trim()}`.

  > `input.edit-input` is written **tag-qualified** here on purpose: `--control-h` is applied to
  > `input.edit-input` but not to `textarea.edit-input`, because tagging it is the only way to give
  > the input a fixed `height` without collapsing the textarea. Write it exactly as the existing
  > drawers do.
- **Delete:** a confirm step **inside the drawer** (`deleteStep: "idle" | "confirm"`), exactly the
  `resetStep` pattern from the user drawer. The confirm body names the consequence:
  > Delete **"Note: you can now Archive older submissions."**? It stops appearing for everyone in
  > your organization, and everyone's close-outs recorded against it are removed as well. This
  > cannot be undone.
- **An `active` message that is also the thing you are editing** is a normal edit; there is no
  lockout risk here (a message cannot block anyone from using the app), which is why this section —
  unlike `show_on_test_screen` — needs no "you cannot turn this off" guard.

### 9.1 Target audience — added during implementation

The plan above took a message's audience as a given. The control that sets it, and the places the
audience is *stated back* to a reader, were settled while building it:

- **One stored value, three ways of reading it.** `SystemMessage.audience` is a role array, and it
  has three states that must stay distinguishable, because an empty array is a real,
  deliverable-nothing state and an empty label would look like missing data rather than a choice.
  `audienceLabel()` (`client/src/lib/settings.ts:40`) is the **single** place they are turned into
  words — so the Settings column, the drawer hint and the notice badge can never disagree:

  | `audience` | reads as |
  | --- | --- |
  | `[]` | `No one` |
  | every role in `ROLES` (`admin`, `staff`, `cdm_contact`) | `Everyone` |
  | some roles | the roles it names, joined with `", "` |

  A full roster reading as `Everyone` is correct rather than lossy: a message authored **before**
  audiences existed reads back as every role, and the server makes those two deliberately
  indistinguishable. The `?? r` fallback in the mapper is not decoration — the server passes an
  unrecognised role name through unvalidated (Zod is the boundary that rejects one), so without it
  a bad stored value would render as the literal word `undefined`.

- **A separate noun map, not `roleBadge()`.** `ROLE_AUDIENCE_LABELS` (`settings.ts:15`) reads
  `admin` → `Administrators`, `staff` → `Staff`, `cdm_contact` → `School Contacts`. A role *badge*
  names the role one account holds ("Admin"); an audience names a set of people a notice is
  addressed to ("Administrators"). Same role, two sentences — which is why this is its own map.

- **The `AudienceChips` control (`AdminSettings.tsx:100`).** One chip per role plus a bulk
  "+ Add all". A role is either in the audience or not, so chips carry the whole state without a
  multi-select. A new message defaults to `[...ROLES]` — i.e. **Everyone** — so the common case
  needs no interaction and a narrower notice is a deliberate act.

  > The caption is a plain `<span>`, **not** a `<Field>`, and that is load-bearing: `Field` renders
  > a `<label>`, and a `<label>` wrapping buttons hands every chip click to the first control inside
  > it — clicking "Staff" would also toggle "Admin". The drawer's Active field is a `Field` because
  > a `Toggle` is one control; the audience group is not, because it is several.

- **The badge on the notice itself (`SystemMessageBar.tsx`)** — a `.badge.sysmsg-audience` under the
  body, carrying the same `audienceLabel()` string as its text, `title` and `aria-label`. It is
  **not a permission check and must not be read as one**: the server only returns messages whose
  audience already includes the reader's role, so whatever renders has already reached them. Its job
  is the one thing the card cannot otherwise convey — whether the notice went to everyone or to a
  narrower group. `Everyone` renders like any other value rather than being hidden as redundant,
  because for a notice "this went to everybody" *is* the information.

### 9.2 As built — where this section differs from the plan

Three changes made while implementing, recorded here rather than by rewriting the plan above:

1. **The grid has FOUR columns, not three:** `Message | Status | Audience | Actions`
   (`AdminSettings.tsx:1235–1240`, with `colSpan={4}` on the loading/empty row at 1246). The
   Audience column shows `audienceLabel(m.audience)`. This is **not** a reversal of §3 decision 11:
   that decision dropped *counts* ("12 of 34"), and a column naming **which** roles a notice is
   addressed to is a label, not a count — it names both ends of the relation, which is what the
   decision asked for.
2. **The delete confirm is inline in the Actions cell, not in the drawer** — `Delete` swaps that one
   cell for `Delete for every user?` + Cancel/Delete (`AdminSettings.tsx:1285–1302`). Same
   destructive-action discipline (§3 decision 12), placed where the row already is.
3. **There is an explicit `Edit` button** beside Delete rather than the row being the only way in.
   With a four-column grid ending in two real actions, a row-click editor would be a third,
   invisible one.

---

## 10. File-by-file change table

| # | File | Change |
| --- | --- | --- |
| 1 | `server/src/db/schema.ts` | append the two guarded `CREATE TABLE`s + the guarded `CREATE INDEX` to `SQLSERVER_DDL_STATEMENTS`; export a `SystemMessage` interface beside `Form`/`ReportView` |
| 2 | `server/src/db/dialect/turso.ts` | append the two `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` to `TURSO_DDL` |
| 3 | `server/src/db/client.ts` | add `dismissed_at` to `TIMESTAMP_COLUMNS`. `active` is already in `BOOLEAN_COLUMNS` — **no change there** |
| 4 | `server/src/db/queries.ts` | the seven functions in §7 |
| 5 | `server/src/schemas.ts` | `systemMessageSchema` (`title` 1–200, `body` ≤4000 defaulting to `""`, `active` boolean default `false`) and `systemMessageIdSchema` (`z.coerce.number().int().positive()`) |
| 6 | `server/src/routes/systemMessages.ts` | **new** — the six endpoints, `/active` registered first |
| 7 | `server/src/index.ts` | import + mount `/api/system-messages` |
| 8 | `server/src/routes/inventory.ts` | six `ROUTES` entries (two `"staff"`, four `"admin"`) |
| 9 | `server/src/swagger.ts` | six `paths` entries with `tags: ["System Messages"]` + `security: [{bearerScheme: []}]` on all six; `SystemMessage` schema in `components.schemas` |
| 10 | `client/src/types/index.ts` | `SystemMessage`, `SystemMessageRow` (admin list row), `SystemMessageInput` |
| 11 | `client/src/lib/api.ts` | `listSystemMessages`, `createSystemMessage`, `updateSystemMessage`, `deleteSystemMessage`, `getActiveSystemMessages`, `dismissSystemMessage` |
| 12 | `client/src/components/SystemMessageBar.tsx` | **new** |
| 13 | `client/src/components/layout.tsx` | render `<SystemMessageBar />` between `</header>` and `<div className="body-flex">`; add `tabIndex={-1}` to `<main className="main">` |
| 14 | `client/src/pages/admin/AdminSettings.tsx` | the new `CollapsibleSection` + grid + drawer + delete confirm + state |
| 15 | `client/src/styles/global.css` | the `.sysmsg-*` block |
| 16 | `server/src/db/system-messages.test.ts` | **new** — see §11 |
| 17 | `docs/user-guide.md`, `docs/plans/user-guide.md` | a short "System Messages" subsection under Admin Settings |

No `git add -A`. Stage by name — `docs/guides/images/` and `school_forms-user-guide.pdf` are
untracked and must stay out.

---

## 11. Verification plan

**Automated, in this order:**

```
cd server; npm run typecheck; npm test
cd client; npm run typecheck; npm run build
```

`npm test` currently runs 7 files. Two of them must go green without edits and one is new:

- `swagger.test.ts` — its 4 tests are the enforcement of §6's three-place rule. It will fail
  immediately if the router is mounted but not in `ROUTES`, in `ROUTES` but not in `swagger.ts`, or
  documented without `security` on an `admin`/`"staff"` route.
- `libsql.test.ts` — it scans every non-exempt `.ts` under `src` for TSQL-only constructs (`TOP n`,
  `OUTPUT INSERTED`, `MERGE`, `OFFSET…FETCH`, `IF EXISTS (`) and for `dbo.` inside single-quoted
  literals. The new SQL in `queries.ts` must therefore be dialect-neutral, and **the new test
  file's own fixtures must not contain a single-quoted `dbo.` literal** — build any such string at
  runtime (`["dbo","system_messages"].join(".")`) rather than adding the file to `EXEMPT`.
- **New: `server/src/db/system-messages.test.ts`** — a source-scanning gate in the style of
  `submissions-archive.test.ts`, because "every read of `system_messages` is org-scoped" and "every
  read of `system_message_dismissals` is user-scoped" are claims about *statements*, not about any
  one function, and a claim spread over nine statements cannot be kept by reading them. The gate
  discovers every function whose SQL names either table, requires each to be **declared** with its
  scope, and fails on both a missing declaration and a stale one. That is the part that keeps it
  useful after the author has moved on.

**Manual / live probes — with a control that is designed to fail.** Every probe below is run against
a live server, and each session includes at least one assertion that *must* fail, because a run of
only passes from a new harness is unverified, not clean:

| Probe | Expected |
| --- | --- |
| `GET /api/system-messages/active` as `staff` with no messages | `200 {messages: []}` — and `@(…).Count` must be read via **bare assign then wrap** (`$x = Invoke-RestMethod …; @($x).Count`), because `@(Invoke-RestMethod …).Count` returns `1` for a JSON array in PowerShell 5.1 and would make an empty list look like one row |
| admin creates a message with `active: true` | `201` |
| `GET …/active` as `staff` in the **same** org | the message |
| `GET …/active` as a user in a **different** org | `[]` — this is the multi-tenant control, and it is the one that matters |
| `POST …/{id}/dismiss` twice | `200` then `200` (idempotent), and the dismissals table still holds **exactly one** row for that pair — read the row, not a response field (Q5 removed the counters from the API) |
| `GET …/active` after dismissing | `[]` |
| `GET …/active` as a *different* user in the same org | still shows it — proving the dismissal is per-user, not global |
| `POST …/{id}/dismiss` with the other org's id | `404` |
| `DELETE` an id that does not exist | `404` (not `200`, not `500`) |
| `POST /api/system-messages` with `{}` **and no token** | `400 VALIDATION_FAILED`, not `401` — the validator runs before the guard. Assert the ordering explicitly, with a message saying to invert the assertion if the framework ever changes it |
| require a **valid** body when testing the guard | otherwise the probe is testing the validator, not the guard |
| deliberate syntax error / unknown table in the gate's own harness | must report failure, proving the harness executes statements rather than swallowing them |

**Browser pass** (embedded browser, so: `locator.dispatchEvent('click')` rather than `click()`, and
never `setViewportSize` before a capture):

1. Sign in as staff → the strip renders under the banner, above the page head, full width.
2. **Print the control list, not just the counts.** A prior defect in this repo was *two* identical
   Restore buttons in one viewport that every count-based assertion passed. Assert
   `getByRole('button', { name: 'Close this message' })` has **count 1 per visible message**.
3. Click X → the strip is gone → navigate to another page → still gone (this is the whole feature).
4. Sign in as the *same* user in a fresh context → still gone.
5. Measure the page-level horizontal scroll honestly:
   `document.documentElement.scrollWidth === document.documentElement.clientWidth`. Do **not** use
   `rect.right > clientWidth`, which flags cells inside any `overflow-x:auto` wrapper (the designed
   behaviour) and produces false positives.
6. Take a `{ fullPage: true }` capture with an **absolute** path, and look at it — a clipping bug
   (`max-height`, `overflow`) is invisible to every measurement and obvious in a render.

---

## 12. Traps this feature is specifically exposed to

1. **A table added to only one dialect is silent.** SQL Server gets it from the ladder; Turso gets it
   only from `TURSO_DDL`. Neither errors — the queries just fail at runtime on one engine. Both
   edits are in the same commit or neither is.
2. **A new *column* on an existing table needs three edits, not one** (`ALTER` in the ladder,
   `addColumns` for Turso, plus `BOOLEAN_COLUMNS`/`TIMESTAMP_COLUMNS`). Not needed now, because both
   tables are new — but this is why §5.3 is a table rather than a sentence.
3. **`dismissed_at` must join `TIMESTAMP_COLUMNS` on the same commit as the table.** A timestamp
   column outside that set is served in the driver's raw shape; the two dialects disagree about it,
   and this is the exact class of difference that once made every authenticated request answer 401.
4. **The dismiss endpoint must never answer 401.** Any 401 on an authenticated call makes
   `request<T>()` clear the token, refresh, and replay the request — so a "you may not do that" would
   present as a sign-out loop *and still not dismiss anything*.
5. **A 200 on a dismiss that wrote nothing is the failure mode to look for.** The write is guarded by
   a pre-check; if that check is written against the wrong scope (a missing `organization_id`), the
   insert simply matches nothing and the route still returns `{ok:true}`. Assert the row.
6. **`@(Invoke-RestMethod $uri).Count` returns `1` for a JSON array in PowerShell 5.1** — every
   collection reads as a single row, and "empty" reads as `@($null).Count` = 1. Assign bare, then wrap.
7. **An icon-only X has an empty `textContent`** — `:has-text` will not find it. Match `title`/`aria-label`.
8. **`AppShell` is mounted per route**, so the strip re-fetches on every navigation. That is fine
   (one small GET) but it has two consequences: an `aria-live` region would re-announce on every page
   change (hence §3 decision 12), and any "don't re-show after navigating" logic must live *server
   side* — client state is gone on the next mount.
9. **A flex container with a `gap` holding bare text nodes renders ragged while all its content is
   correct.** Use one `<p>`.
10. **A destructive delete that leaves orphaned dismissal rows** is invisible until a count is taken.
    Delete both in one transaction, and have the confirm state what else goes.
11. **`Record<string, number>` as a payload type swallows a field the server never sent** — give the
    client DTOs their real member list, or a typo'd key is `undefined` and compares false with a
    misleading message instead of failing to compile.
12. **A cap applied in the client is a correctness bug, not a layout choice.** The three-message
    limit (§3 decision 15) is in the SQL. A `messages.slice(0, 3)` in `SystemMessageBar.tsx` would
    look identical on screen while denying that rows 4+ exist — and would leave the *next* reader
    believing the API returns everything. If a client-side cap is ever genuinely needed, it belongs
    beside a comment saying what the server already guarantees.
13. **`.badge-blue`, `.badge-green` and `.badge-teal` are the same three colours** — they differ only
    in name (global.css:410/411/416). An Active/Inactive pair written with two of them renders
    **identically** while the source reads as though it is colour-coded. Use `.badge-green` and
    `.badge-gray`. No tool warns you about this: it compiles, it matches the neighbouring row, and
    it is only visible if you compare the *computed* colours or look at the render.
14. **A new `table.grid` row without a `data-label` on each content `<td>` loses its labels on
    mobile.** The breakpoint at global.css:1120 stacks `table.grid` into cards with
    `content: attr(data-label)`, so the desktop view is perfect and the phone view shows unlabelled
    values. Conversely, `td:not([data-label])` (global.css:1187) is the *designed* full-width action
    cell — so a missing `data-label` is correct in exactly one column and a bug in every other.

---

## 13. Questions for the user — answered 2026-09-26

| # | Question | Answer | Effect on the design |
| --- | --- | --- | --- |
| **Q1** | **What does "close it out" mean?** | **(a)** — *"The messages appear on a per-user basis. Message stays at top until user hits 'x' to close it."* | Confirms §4 option A: `system_message_dismissals` keyed `(message_id, user_id)` (§3 decision 2). No change. |
| **Q2** | If an admin edits a message after people have closed it, does it re-appear? | **No** — *"No."* | Confirms §4. **No "Re-show to everyone" button is built** (§4's optional (b) is dropped). An edit reaches only the people who have not yet closed it, and a second announcement is a new message. |
| **Q3** | **Who sees a message?** | **Everyone, admins included** — *"All users, even admins."* | `/active` and `/{id}/dismiss` are `requireAuth` only: **no role filter at all**. An admin is not exempt, so the strip renders in the admin's own shell too. In `inventory.ts` these two get the `"staff"` shorthand (which is the `staff, cdm_contact, admin` trio) — that is the *permissive* label, and it is what the route really does. |
| **Q4** | Is `Note:` a prefix the app adds, or part of the text the admin types? | **Part of the text** — *"'Note' is part of the title of the message in this example."* | Confirms §8.3: the title renders exactly as typed (bold), with **no** app-added prefix. |
| **Q5** | Should the admin list show **how many people have closed** each message? | **No** — *"No."* | **Counts dropped everywhere:** no `closed_count`, no `audience_count`, no `Closed by` column, no "12 of 34", no `closed_count` in any response shape. Grid is **three** columns with `colSpan={3}`; the delete confirm states the consequence without a figure. See §3 decision 11 and §12 trap 12. |
| **Q6** | **Multiple active messages** — stack all, or only the newest? | **Stack, maximum 3** — *"Stack, max 3 messages."* | Stacking, **with a new server-side cap of 3** (§3 decision 15). The `LIMIT` lives in `listActiveSystemMessagesForUser`, expressed through the `selectPage` dialect builder so both engines get it. The client never slices. |

Nothing below this line is open. The remaining question — "what happens to close-outs when a message
is deleted?" — was answered by the design itself (§3 decision 9: they go with it, and the confirm
says so).
