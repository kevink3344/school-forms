# Access Requests — an admin notification bell and a dedicated page

**Status:** ✅ **Shipped (2026-10-16)** — §4 **Option A** (derive, never store), no schema change. §10's
questions were answered as recommended except Q2 stays *"pending"* (Option C / an unread cursor is **still
deferred**, so §7.2 remains unbuilt). See §15 for what shipped and how it was verified.
**Date:** 2026-10-04
**Area:** Admin → **Access Requests** (a new page beside Settings) · the app banner (an admin notification bell)
**Related:**

- [`docs/plans/public-private-forms.md`](./public-private-forms.md) — **the parent plan.** This document
  **extends and partly supersedes** its §10.2 (the Settings section) and its §10.3 / §15 Q3 (*"in-app only;
  the count … is the notification"*). Everything it built — the `form_access` / `form_access_events` tables
  (§5), the router (§8) and the server functions (§9) — is **reused, not re-derived**, and its §15 Q1/Q2/Q4/Q6/Q7
  answers still hold unchanged.
- [`docs/plans/system-messages.md`](./system-messages.md) — the closest precedent: a per-user in-app surface
  with a `(item, user)` dismissal key, and the §3 "at most three, capped server-side" warning about counts.
- [`docs/plans/webhook-log.md`](./webhook-log.md) — an **admin-only surface with its own page** rather than a
  Settings section (the precedent for §8's "move it out of Settings").
- [`docs/plans/organizing-settings.md`](./organizing-settings.md) — what belongs in Settings and what has
  earned its own page.
- `docs/screenshots/admin-screen.html` (L291) — the mockup **already draws the bell**: a `Notifications`
  icon button carrying a `.notif-badge` count, in the banner's `.actions` area.

---

## 1. What was asked

> *"I now need a plan for 'Access Requests' for administrators. When someone wants access to a form, they
> click the 'Request Access' button. It should send them an in-app notification with a link to the item.
> Admins should have a page where they can view all of their access requests."*

Three asks, and they are separable — which matters, because one of them is already half-built:

1. **A notification.** When a request arrives, the administrator should be *told in the app*, not have to
   go looking. Today the only signal is a count on a **collapsed** Settings section (parent plan §10.3).
2. **A link to the item.** The notification must lead to *the specific request*, not to a generic queue.
3. **A page.** Administrators want a real page (`/admin/access-requests`) listing **all** of their
   organization's access requests — not a section buried inside Settings.

The word **"all"** in ask 3 is load-bearing and is the one place this plan changes behaviour rather than
just presentation: the parent plan's queue is *pending only* (§10.2's table is `status=pending`, oldest
first). "All of their access requests" means the page shows **pending, approved and denied**, filterable.

---

## 2. Current state

Verified against the tree, not assumed:

| Claim | Where | Result |
| --- | --- | --- |
| The request workflow exists | `server/src/routes/formAccess.ts` (9 routes), `server/src/db/formAccess.ts` | ✅ Complete — request, withdraw, decide, grants, per-user access, `summary` |
| The requester's buttons exist | `client/src/components/LockedFormPanel.tsx`, `client/src/pages/forms/AvailableForms.tsx` | ✅ `Request access` / `Request access again` / `Withdraw request` |
| Admins see the queue | `client/src/pages/admin/AdminSettings.tsx` L1907–2025 (`CollapsibleSection` "Access Requests") | ⚠️ **A section in Settings, pending-only, no link, closed by default** |
| The notification is "the count" | `routes/formAccess.ts` L171–182 (`/summary`); plan §10.3 / §15 Q3 | ⚠️ **BY DESIGN — and this plan reverses that decision** |
| A notification entity/table | `grep notifications / unread / seen_at` across `server/src` and `client/src` | ❌ **None exists.** No bell, no notifications table, no read state |
| A bell is designed, just not built | `docs/screenshots/admin-screen.html` L291 | ⚠️ Mockup only — `class="icon-btn" … <span class="notif-badge">2</span>` |
| The page route | `client/src/App.tsx` | ❌ No `/admin/access-requests` |
| The nav item + menu key | `client/src/lib/settings.ts` L103, `server/src/routes/settings.ts` L29 | ❌ `MENU_ITEMS = ["forms","reports","available_forms"]` — no `access_requests` |
| The queue is org-scoped server-side | `listAccessRequests(organizationId, status)` | ✅ `WHERE f.organization_id = @organizationId` — the tenant boundary is already right |

**So this is a *new surface over existing data*, not a new feature.** The only genuinely new things are the
page, the bell, and one read endpoint. No new table is required (§4).

---

## 3. What this feature is — and is not

**It is:**

- **A second *view* of one existing rule.** "Who is waiting?" is already answered by `form_access`
  rows in `status='pending'`. The bell, the count and the page are three renderings of that one answer.
- **A promotion of a Settings section to a page** (§8), because a page is linkable, deep-linkable and
  bookmarkable and a collapsed section is none of those.

**It is not:**

- **Not a new permission system.** Approving is still the only thing that grants access, and every route
  stays `requireRoles("admin")` (parent plan §15 Q4 — *any* administrator). No owner column, no approver list.
- **Not a change to what a requester sees.** The locked panel already reports the outcome when they next
  visit (`LockedFormPanel.tsx` renders `pending` / `declined` / *access removed* from `last_event`). §10 Q1
  asks whether to *also* notify the requester; v1 does not, to keep the blast radius on admins only.
- **Not a push channel.** The app has no websocket and no server-initiated events (parent plan §15 Q3).
  "In-app notification" here means a **pull-based indicator**: a bell that updates the next time the
  administrator's browser asks. This is stated up front so nobody waits for a toast that cannot arrive.

---

## 4. The one design decision that decides everything: is a notification *stored* or *derived*?

A "notification" can mean two very different things, and the choice of one settles the data model, the
API and about half of this document. Three candidates:

| Option | What a notification *is* | Cost | Verdict |
| --- | --- | --- | --- |
| **A. Derived — the pending request *is* the notification** *(recommended)* | The bell lists the organization's `form_access` rows in `status='pending'`. There is no notification row; there is a **read** of the queue. The "link to the item" is a deep link into the page that focuses that row. | **One new read endpoint + one component + one page. Zero schema.** | ✅ **Recommended.** It cannot disagree with the queue because it is the queue. |
| B. Stored, per-item, per-admin — a `notifications` table | Writing a request fans out **one row per administrator** (`user_id`, `type='access_request'`, `title`, `body`, `link`, `read_at`). Read state is per item. | A new table in **both dialects**, fan-out on write, read/unread endpoints, and **cleanup** when a request is decided (otherwise the bell shows notifications for work that is gone). | ❌ **Rejected for v1.** This is the parent plan's named failure mode — *"two mechanisms for one rule"* (§4.3). The row says *"Ada wants form 2"* and the `form_access` row says exactly the same thing, in a second place that can drift. |
| C. Stored, per-admin **cursor** — `users.access_requests_seen_at` | One nullable timestamp per admin: "when did this admin last open the page?". The badge shows requests *newer* than that, so `unread` is distinguishable from `pending`. | One **column** (three registration points — §7.2) + a write endpoint. | 🟡 **Deferred, not wrong.** This is the honest "new since you last looked" reading of *"send them a notification"* — see **§10 Q2**. It adds a *second* number (unread ≠ pending), which is the thing to decide consciously rather than by accident. |

### 4.1 Why A is the recommendation

1. **It cannot disagree with the queue, because it *is* the queue.** Parent plan §16.4 already rejected a
   `listForms` + `listLockedFormsFor` pair for exactly this reason: two reads can straddle a state change and
   render a form twice. A stored notification has the same disease one step removed — a request approved
   between two renders leaves a "new request" bell pointing at nothing.
2. **A pending request is *work*, not a passive notice.** It stays actionable until it is decided. That is
   why the recommendation is **not** to offer "mark as read" in v1: clearing a work item requires *deciding*
   it. A "mark read" on an unanswered request would let a request **disappear from the bell while still
   unanswered** — the same class of bug this repo already has a rule against (`slice(0, N).filter(pred)`
   *"denies that matches exist"*). The count falling to zero and the work being done stay the same event.
3. **It is the smallest change that satisfies all three asks** — a bell, a link, a page — and it is the
   only option that adds **no schema**.

### 4.2 ★ The honest limitation of A, stated so it is not discovered later

Because the badge equals the **pending** count, it does **not** distinguish *"new since you last looked"*
from *"still waiting."* An administrator who has seen a request five times still sees the same count. That
is the cost of A, and it is deliberate: for a *queue of work*, "still waiting" is the more useful number,
and it cannot be dismissed by looking. **If the reviewed answer to §10 Q2 is "I want a true unread
count," Option C is the smallest way to get it** and this section is where it plugs in.

---

## 5. The notification bell

### 5.1 The mockup already draws it

`docs/screenshots/admin-screen.html` L291:

```html
<button class="icon-btn" title="Notifications" style="position:relative;">
  <svg …bell glyph…></svg><span class="notif-badge">2</span>
</button>
```

It sits in the banner's `.actions` group, **between Help and the user chip**. The live app's equivalent is
`client/src/components/layout.tsx` L242–286 (`<div className="actions">`), which today holds only the user
chip and the Log out button. The bell is the first thing added **before** the user chip, matching the image.
(The mockup's class is `.icon-btn` / `.notif-badge`; the app's existing class is `.icon-button`. Reuse
`.icon-button` and add a small `.notif-badge` rule — one new selector, not a second button style.)

### 5.2 Behaviour

- **Admin only.** The bell renders when `user.role === "admin"` and is otherwise absent. It is **not** gated
  by `menu_items` — see §5.4.
- **Badge = pending count.** `0` renders **nothing** (no "0" bubble) — the same "no empty wrapper" rule
  `SystemMessageBar` follows (`layout.tsx` L370–377). The bubble is capped for legibility (`99+`).
- **Click → a small dropdown**, newest-first, of the organization's pending requests, each row:
  *"{Requester name} · #{form_id} {form title}"* + the requested date, and a **link to the item**
  (§6.4). The list is capped (recommended **5**) with a footer link *"View all →"* to the page. ★ The
  cap goes **server-side** in the read endpoint, not by `slice(0, 5)` in the component — a client slice is
  exactly the `slice(0, N).filter(pred)` pattern this repo bans, and the footer would then be a lie about
  how many are hidden.
- **Empty state:** the badge is absent, so the bell still opens a one-line *"No requests are waiting."*
- **Refresh policy.** `AppShell` is declared **per route** (`App.tsx`), so React remounts it on every
  navigation — the bell refetches on each page change for free (the same fact `system-messages.md` §3
  decision 12 relies on). Add **one modest interval** (recommended 60 s, and only while
  `document.visibilityState === "visible"`) so a long-lived page does not go stale. The refetch is a plain
  `GET`; see §7.4 for the rate-limit note.
- **Refetch on decision.** Deciding a request from the page or the dropdown must refresh the badge
  **without a reload** — see §6.6 for the one-source recommendation.

### 5.3 Accessibility

- The bell is `<button aria-haspopup="menu" aria-expanded>` like the existing user chip (`layout.tsx`
  L245–259), and closes on outside-`mousedown` and `Escape` — **reuse those two effects**, do not write a
  third dismissal mechanism (the closures are at `layout.tsx` L184–214).
- The badge count is announced by including it in the button's accessible name
  (`aria-label={\`Access requests: ${pending} waiting\`}`) — a bare colour bubble is invisible to a screen
  reader.
- ★ **No `aria-live` on the badge.** The count changes on a timer and on navigation; a live region would
  announce *"3 waiting"* repeatedly and on every remount. Same reasoning as `system-messages.md` §3
  decision 12.

### 5.4 ★ The bell is deliberately NOT in `menu_items`

`menu_items` is a **per-role visibility** switch (Settings → Menu Settings). Adding the bell to it would let
an administrator hide the only signal that work is waiting — which recreates the exact defect §16.8 trap 1
is about (*"an affordance reachable only from an empty state disappears the moment the state is not
empty"*). The **nav link** may be toggleable (§6.3); the **bell** may not. This asymmetry is intentional.

---

## 6. The Access Requests page

### 6.1 Route

`/admin/access-requests` → `client/src/pages/admin/AccessRequests.tsx`, declared in `client/src/App.tsx`
inside the admin block (L41–132), wrapped exactly like its siblings:

```tsx
<Route path="/admin/access-requests" element={
  <ProtectedRoute roles={["admin"]}>
    <AppShell><AccessRequests /></AppShell>
  </ProtectedRoute> } />
```

**Admin only** — the route guard and the server's `requireRoles("admin")` agree, so a typed URL and a nav
click are gated identically (`ProtectedRoute` gating on the path, not by hiding links).

### 6.2 What the page shows — "all of their access requests"

Parent plan §10.2's queue is `?status=pending`. This page adds a **status filter** so *"all"* is honest:

| Tab | Source | Default |
| --- | --- | --- |
| **Pending** | `listAccessRequests(org, "pending")` | ✅ default (oldest first) |
| **Approved** | `listAccessRequests(org, "approved")` | |
| **Denied** | `listAccessRequests(org, "denied")` — covers *declined* **and** *revoked* | |
| **All** | the three concatenated, newest first | |

Columns (reusing `AccessRequestRow`, `client/src/types/index.ts` L300): **Requester** (`user_name`,
`user_email`, `school_name`) · **Form** (`#form_id form_title`, plus the existing *"Who has access?"*
affordance) · **Requested** (`requested_at`) · **Status** (`status`) · **Note** (`note`) · **Actions**.

Actions per row, **reusing the existing decide endpoint** (`POST /api/form-access/requests/decide`) and the
existing verbs from `AdminSettings` L1966–2018:

- `pending` → **Approve** · **Decline** (opens the inline reason field — the decline `note` is shown to the
  requester)
- `approved` → **Revoke** (with the §15.2 confirmation wording — a revocation is permanent from the
  requester's side, so the button must *say so in words*)
- `denied` → no action (the requester may re-ask from *Available Forms*; the administrator acts from the
  Pending tab when they do)

The **per-form grant list + event history** (the `grants` view currently inline in `AdminSettings`
L2027–2100) moves here behind the *"Who has access?"* control — see §8.

### 6.3 Nav item

A new item in the **admin** nav block (`layout.tsx` L299–342), beside *Dashboard / Forms / Settings*:

```tsx
{menuVisible("access_requests") && (
  <NavLink to="/admin/access-requests" className="sidebar-link" onClick={() => setSidebarOpen(false)}>
    <Inbox size={18} /><span className="s-label">Access Requests</span>
  </NavLink>
)}
```

★ **`menu_items` keys are a hand-copy pair.** The key must be added to **both**
`client/src/lib/settings.ts` `MENU_ITEMS` (L103) **and** its `MENU_ITEM_LABELS` (L107), **and**
`server/src/routes/settings.ts` `MENU_ITEM_KEYS` (L29). Add it to one and Settings → Menu Settings silently
cannot see it — a drift this repo has an incident recorded for (`settings.ts` L90–115 →
`routes/settings.ts` L22–29). Label: **"Access Requests"**. Default: unrestricted (`null`), like every other
key.

Whether this page should be hideable at all is **§10 Q5** — the recommended answer is *yes, add the key*
(consistency with `forms`, which is likewise admin-only **and** toggleable), accepting the caveat that an
administrator who hides it hides the link but **not the bell** (§5.4).

### 6.4 ★ "A link to the item" — deep links

The item is a `(user_id, form_id)` pair (the `form_access` primary key), and the page addresses it directly:

```
/admin/access-requests?form_id=2&user_id=9
```

On load the page: selects the **Pending** tab, finds the row whose key is `${user_id}:${form_id}`, gives it
`id="req-2-9"`, applies a brief highlight (`.row-flash`), and `scrollIntoView({ block: "center" })`. If the
row is not in the loaded tab (already decided), the page says so plainly — *"That request has already been
decided"* — rather than scrolling nowhere (a silent no-op is the parent plan §13 trap-13 class of defect).
**Every bell row links this way**, so "the notification" and "the link to the item" are the same affordance.

### 6.5 Empty states

One per tab, in words a person acts on — not a blank grid (parent plan §10.1: *"an empty grid says there is
nothing here"*):

- **Pending, empty:** *"No requests are waiting."*
- **Approved / Denied, empty:** *"Nothing has been {approved, declined} yet."*
- **Pending, empty *and* the org has private forms:** add the sentence that makes the page useful —
  *"Requests appear here when someone asks for access to a private form from **Available Forms**."*

### 6.6 Refreshing without a reload

The page loads its tab on mount and after every decision (the `loadAccess()` shape, `AdminSettings`
L677–693). The **bell** must update too. Recommended: a tiny `AccessRequestsProvider` (or a
`refreshAccessRequests` on the existing `AuthContext`) that owns the pending count **and** the dropdown
list, so the page and the bell read **one** source and a decision refreshes both. Two components fetching
the same endpoint independently is the drift this repo keeps removing (see `useRoleCatalog`'s "fetches once
and dedupes" note, `AdminSettings` L426–431).

---

## 7. Data & API

### 7.1 No new table (recommended, Option A)

The recommended design adds **no schema**. Everything the bell and the page show already exists:

- `dbo.form_access` — one row per `(user, form)`, `status ∈ {pending, approved, denied}` (parent plan §5.2)
- `dbo.form_access_events` — the append-only log, already surfaced per form (§5.3)
- `dbo.forms`, `dbo.users`, `dbo.schools` — joined by `listAccessRequests` for the name/e-mail/school/title

### 7.2 If Option C is chosen (a per-admin "seen" cursor), the migration touches four places

Stated now because a column added to one dialect is **silent** (`dual-db.md` §5.3 — *"a column added to one
dialect is silent, because nothing errors"*). A `users.access_requests_seen_at` column needs all of:

| Dialect | Where | What |
| --- | --- | --- |
| SQL Server | `server/src/db/schema.ts` | `IF COL_LENGTH('dbo.users','access_requests_seen_at') IS NULL ALTER TABLE dbo.users ADD …` in its own batch |
| Turso | `server/src/db/dialect/turso.ts` | the column in the `users` CREATE **and** an `addColumns` entry |
| Shared | `server/src/db/client.ts` | `access_requests_seen_at` → `TIMESTAMP_COLUMNS` (or it reads back as a raw string on Turso and a `Date` on SQL Server — the `invalid time value` class of bug) |
| Test | `server/src/db/*.test.ts` | the `TIMESTAMP_COLUMNS` assertion only exists for tables it names; extend the check |

`dialect/sqlserver.ts` `addColumns` stays `[]` (the ladder is cumulative).

### 7.3 The read endpoint

**One new read**, replacing `GET /api/form-access/summary` (L171–182):

```
GET /api/form-access/notifications?limit=5      admin
→ { "pending": 3, "requests": [ AccessRequestRow, … ] }
```

- `pending` is `countPendingAccessRequests(org)` — **already written** (`db/formAccess.ts` L262).
- `requests` is `listAccessRequests(org, "pending")` — **already written** (L241) — capped at `limit`
  (default 5, max 20) and ordered **newest first** for the bell. (The queue endpoint stays `ASC`/oldest-first
  for triage; the bell wants newest.) The cap is applied in SQL via the existing page builder, **not** in the
  client (§5.2).
- ★ **`/summary` is replaced, not kept.** It has exactly one caller (`getAccessRequestSummary`,
  `api.ts` L599, used only by the Settings section this plan removes, §8). Leaving both endpoints would be
  two names for one question — the drift this repo removes. If the reviewer prefers to keep `/summary` for
  compatibility, it must become a thin alias, never a second query.

The page itself uses the **existing** queue endpoint, unchanged:

```
GET /api/form-access/requests?status=pending|approved|denied     admin   (L114, already built)
POST /api/form-access/requests/decide                            admin   (L124, already built)
GET /api/form-access/grants?form_id=N                            admin   (L158, already built)
```

**No request/decision route changes.** The notification is a read; it never writes.

### 7.4 Rate limiting (a real, if small, consideration)

`server/src/index.ts` L74–88 exempts the login-page bootstrap reads (`/health`, `/docs`, `/settings`,
`/info`) from the API limiter, but **`/api/form-access/*` is not exempt**. The default budget is
**1000 requests / 15 min / IP** (`env.ts` L147–155). A 60 s visible-tab poll is ~15 requests/hour/tab — an
order of magnitude inside the budget, so **no exemption is needed**. The note exists so that if the interval
is ever lowered (or the budget in `RATE_LIMIT_MAX` is), the bell is the first thing to check, and so nobody
adds a second exemption "to be safe". Exempting a **write-adjacent** path is exactly the bug the comment at
L65–70 in `index.ts` warns about; `/form-access/notifications` is a plain authenticated `GET` and does not
belong on that list.

### 7.5 Route registration

The new `GET /api/form-access/notifications` must be added in **the same three places as every other route**
(parent plan §8, §16.4): the router (`routes/formAccess.ts`), `routes/inventory.ts`, and `routes/swagger.ts`.
Missing one is a silent hole in the API inventory, and this repo has a test that diffs the inventory against
the declared routes.

---

## 8. What happens to §10.2's Settings section

The parent plan put the queue in a `CollapsibleSection` inside **Admin → Settings** (`AdminSettings.tsx`
L1907–2025), with the pending count on the closed title as "the notification". This plan **moves that
section to its own page** and reverses the "count is the notification" half of §10.3. Three options were
considered:

| Option | Verdict |
| --- | --- |
| **Keep both** (Settings section *and* a page) | ❌ Two places render the same queue and the same count. They will disagree the moment one forgets to refetch — the drift the repo removes (`useRoleCatalog`'s note). **Rejected.** |
| **Remove the Settings section entirely** | 🟡 Clean, but an administrator who learned the feature in Settings goes looking there and finds nothing. |
| **Move it, and leave a one-line link** *(recommended)* | ✅ The section is **deleted**; Settings keeps a single link row — *"Access Requests (3 pending) →"* — pointing at `/admin/access-requests`. It reads the **same** endpoint (§7.3) as the bell and the page, so it is one fact rendered three times, never a second implementation. |

The recommended link row replaces the whole `CollapsibleSection`. Concretely, deleted from `AdminSettings`:
the `accessRequests` / `accessPending` / `accessError` / `accessBusy` / `grantsFormId` / `grants` /
`declineFor` / `declineNote` state (L627–636), `loadAccess` / `decide` / `toggleGrants` (L677–726), the
section render (L1907–2025) and the grants table (L2027–2100) — all of it moves to `AccessRequests.tsx`.
`listAccessRequests`, `decideFormAccess`, `listAccessGrants`, `getAccessRequestSummary` move out of
`api.ts`'s "used by Settings" grouping and into the page's.

**Unchanged by this plan:** the **Edit User drawer**'s per-account access list (`listUserAccess`,
`removeUserAccess`, `AdminSettings` L638–675) stays in Settings — it is about *one account*, not the queue,
and it belongs where the account is edited (parent plan §18.3).

---

## 9. File-by-file change table

| File | Change |
| --- | --- |
| `server/src/routes/formAccess.ts` | **Replace** `GET /summary` (L171–182) with `GET /notifications?limit=` — one read composing `countPendingAccessRequests` + `listAccessRequests(org,"pending")` capped, newest-first |
| `server/src/routes/inventory.ts` | Register `GET /api/form-access/notifications`; drop `summary` |
| `server/src/swagger.ts` | The same swap in the spec (L1798–1810 block) |
| `server/src/db/formAccess.ts` | Add an optional `limit`/`order` to `listAccessRequests` **or** a thin `listRecentAccessRequests(org, limit)` that reuses its join. Prefer the latter so the triage queue's `ORDER BY requested_at ASC` is untouched |
| *(Option C only)* `server/src/db/schema.ts`, `dialect/turso.ts`, `db/client.ts`, a `*.test.ts` | The four registration points in §7.2 |
| `client/src/components/NotificationBell.tsx` | **New** — admin-only bell + dropdown; reuses the user chip's outside-click/Escape handlers |
| `client/src/components/layout.tsx` | Mount `<NotificationBell />` in `.actions` (L242), before the user chip; add the **Access Requests** nav item to the admin block (L299–342) |
| `client/src/context/AccessRequestsContext.tsx` | **New** — owns `{pending, requests}` and `refresh()`; read by both the bell and the page (§6.6) |
| `client/src/pages/admin/AccessRequests.tsx` | **New** — the page (§6): tabs, table, decide actions, grants view, deep-link focus |
| `client/src/App.tsx` | The `/admin/access-requests` route in the admin block |
| `client/src/lib/api.ts` | `getAccessRequestNotifications(limit)` replaces `getAccessRequestSummary()` (L599); the queue/decide/grants calls move next to it |
| `client/src/lib/settings.ts` | `MENU_ITEMS` (L103) + `MENU_ITEM_LABELS` (L107): add `access_requests` → "Access Requests" |
| `server/src/routes/settings.ts` | `MENU_ITEM_KEYS` (L29): add `access_requests` — **both lists or neither** (§6.3) |
| `client/src/pages/admin/AdminSettings.tsx` | Delete the Access Requests section + its state/handlers (§8); add the one-line link row |
| `client/src/styles/global.css` | `.notif-badge`, the bell dropdown, `.row-flash` — a handful of rules, reusing existing tokens |
| `client/src/types/index.ts` | Reuse `AccessRequestRow` (L300); add the notifications response shape |
| *(tests)* `server/src/db/form-access.test.ts` | Extend with the §11 checks for the new endpoint |

**A test worth naming:** this repo diffs the client's `MENU_ITEMS` against the server's `MENU_ITEM_KEYS`
(the hand-copy pair) — see §6.3 — so the new key must be in both or that test fails. Good: the failure is
the feature telling us it is mis-wired.

---

## 10. The questions, for review

The parent plan's §15 pattern: each question carries a **recommended** answer the build will follow unless
overruled, so silence is not a blocker.

| # | Question | Recommended | Why, and what it costs |
| --- | --- | --- | --- |
| **Q1** | **Should the requester be notified too** — when their request is approved, declined or revoked? | **No, not in v1.** | The locked panel and *Available Forms* already report the outcome when the person next visits (`LockedFormPanel.tsx`, `last_event`). A requester bell is a **second audience** for the same feature and would want its own decision about push. Defer; §4's derived model extends to it cleanly later if wanted. |
| **Q2** | **Should the badge be "pending" (work waiting) or "unread" (new since I last looked)?** | **"pending"** (§4.2). | "Pending" is the more useful number for a queue and cannot be cleared by looking. If you want a true unread count, that is **Option C** (§4) — one column + one write endpoint — and this is the question that decides it. |
| **Q3** | **Remove the Settings section, or keep it *and* add the page?** | **Remove it; leave a one-line link** (§8). | Two live copies of one queue drift. A single link preserves discoverability without a second render. |
| **Q4** | **In-app only, or also Slack / e-mail?** | **In-app only.** | Parent plan §15 Q3 answered this the same way and §10.3 deliberately built **no** notification abstraction to unwind. Slack is a one-line change *later* (`notify/slack.ts`) once the in-app shape has settled — doing it now means designing a message for a UI that does not exist yet. |
| **Q5** | **Should the Access Requests nav item be hideable via Settings → Menu Settings?** | **Yes** — add the `access_requests` key to both lists. | Consistency: `forms` is likewise admin-only and toggleable. **Caveat:** hiding the link does **not** hide the bell (§5.4), which is intentional — the bell is the notification and is never defeatable. If you would rather the page be *never* hideable, say so and the key is omitted (the route guard already gates it). |
| **Q6** | **How many items in the bell dropdown, and what poll interval?** | **5 items / 60 s while the tab is visible.** | Both are cosmetic and cheap to tune; the load-bearing rule is that the cap is **server-side** (§5.2). |

★ **Nothing here blocks starting §8/§9's mechanical work** (moving the section to a page) — only Q2 (the
data model) and Q3 (what remains in Settings) change the file plan, and both are answered above with a
recommended default.

---

## 11. Verification plan

Server-side checks extend `server/src/db/form-access.test.ts`; UI checks are manual (the repo has no DOM
test harness). Each check names the failure it is designed to catch.

**Endpoint (`GET /api/form-access/notifications`)**

1. **`pending` equals the count of `status='pending'` rows for the caller's org** — and a control asserts it
   is **not** zero when a pending row exists, or "equals" passes against an endpoint that returned nothing.
2. **`requests` is capped** at `limit` (default 5, max 20) and ordered **newest-first**; `limit=0`/garbage
   falls back to the default rather than returning everything.
3. **403 for every non-admin role** (`staff`, `cdm_contact`). *The bell is admin-only; this is the check that
   the read did not become a new permission surface* (parent plan §12's failing control).
4. **Org isolation:** an admin in org 1 sees **zero** requests whose form belongs to org 2
   (`technology-services`). The org filter is `AND`-ed, never substituted (parent plan §13 trap 1).
5. **Draft/archived forms never appear** — the query joins `forms`; confirm a request whose form was
   archived after the fact is handled the same way `listAccessRequests` handles it (no crash, consistent
   with the queue).
6. **`/summary` is gone** (404) and nothing calls it — `grep` the client for `getAccessRequestSummary`.

**Behaviour**

7. **Request → bell → page, one pass.** A `cdm_contact` requests access via *Available Forms*; the admin's
   bell badge becomes `+1` **without a reload** (or after the interval), the dropdown lists the new row
   **first**, its link opens `/admin/access-requests?form_id=…&user_id=…`, and the page focuses + flashes
   that row.
8. **Decide → both surfaces update.** Approving from the page drops the badge by one **and** removes the row
   from the Pending tab, with no manual refresh.
9. **Withdraw → disappears.** The requester withdraws (`POST /requests/withdraw`); the admin's badge drops
   and the row leaves the dropdown. *This is the check that the bell is a genuine read of `form_access` and
   not a stored copy that forgot to delete.*
10. **Deep link to an already-decided request** shows *"That request has already been decided"* — not a blank
    page and not a silent no-scroll.
11. **Tabs agree with the endpoint.** Pending + Approved + Denied counts match three separate
    `?status=` calls; the **All** tab is their union with no row in two tabs.
12. **Zero pending = no badge** (not a "0" bubble), and the bell still opens to the empty message.

**Guards**

13. **The nav item is reachable only by an admin** (a `staff` account navigating to `/admin/access-requests`
    is redirected by `ProtectedRoute`, identically to a typed URL).
14. **`MENU_ITEMS` and `MENU_ITEM_KEYS` both contain `access_requests`** — the hand-copy test (§6.3/§9).
15. **Responsive:** the bell dropdown is usable at the narrow breakpoint (it is inside the banner, which is
    already handled; confirm it does not overflow off-screen on a phone width).

---

## 12. Traps this feature is specifically exposed to

In the order they are most likely to bite.

1. **★★ Storing a notification that duplicates `form_access`.** The single most attractive wrong turn (§4
   Option B). It reads as "more correct" and it is the one design that can tell an administrator a request
   is waiting when it has already been decided — because the notification and the queue are two facts and one
   of them was not updated. **Derive; do not store** (unless Option C, which stores a *cursor*, not a copy).
2. **★ A client-side `slice(0, 5)`.** The bell cap must be applied in the read (§5.2/§7.3), or the "View
   all →" footer is a lie about hidden rows — the exact `slice(0, N).filter(pred)` smell this repo names.
3. **★ `MENU_ITEMS` / `MENU_ITEM_KEYS` drift.** The hand-copy pair (§6.3). Add `access_requests` to one and
   the Settings → Menu Settings toggle silently cannot see it. The pairing test should catch it; do not
   "fix" the test.
4. **★ A second visibility implementation on the page.** Render `status`/`note` from the payload; never test
   `visibility` in the component (parent plan §13 trap 3 / §16.8 trap 3 — `FormAccess` is derived server-side
   on purpose).
5. **★ The bell's count disagreeing with the page's count.** Guaranteed if they fetch independently (§6.6).
   One context, one source, one `refresh()`.
6. **A "0" badge or an empty wrapper.** The bell must render *nothing* at zero, matching
   `SystemMessageBar`'s null-when-empty rule. A `0` bubble is noise that trains people to ignore the bell.
7. **`aria-live` on the badge.** It changes on a timer and on every route remount; announcing it repeatedly
   is worse than not announcing it (§5.3).
8. **A "mark as read" that is not a decision.** If Option C is ever built, take care: `unread` must fall on
   *viewing*, but the row must **stay** in the Pending queue until decided. Conflating the two makes an
   unanswered request disappear from the bell while still pending (§4.1 point 2).
9. **The bell hidden by `menu_items`.** Do not add the bell to `menu_items` (§5.4). Hiding the only signal
   that work is waiting recreates the defect the parent plan's §16.8 trap 1 exists to prevent.
10. **A deep link that silently no-ops.** If the target row is not in the loaded tab, say so; do not render
    a normal-looking page with nothing focused (§6.4, and parent plan §13 trap 13 — *"a link to a 403 is
    worse than a button that asks"*).
11. **Route-registration drift.** New route → three files (router, `inventory.ts`, `swagger.ts`); the
    inventory/diff test exists to catch a miss (§7.5).
12. **Rate limiting assumed exempt.** `/api/form-access/*` is **not** on the bootstrap exemption list
    (§7.4); the default budget absorbs the poll, but lowering the interval or the budget without re-checking
    is how a bell starts returning 429s.

---

## 13. Deploy order

Chosen so that **every step is independently releasable** and no step changes anyone's access.

1. **Server read.** Replace `GET /summary` with `GET /notifications` (router + inventory + swagger), extend
   the tests. Nothing on screen changes yet; the old Settings section breaks its count, so ship steps 1–3
   together or keep `/summary` as a one-release alias.
2. **The page.** `AccessRequests.tsx`, the route, the API calls, the context. The Settings section still
   exists at this point — that is fine for one commit, not for the release.
3. **Move, don't duplicate.** Delete the Settings section, add the one-line link, add the nav key to both
   lists. **★ This is the step that must not be skipped** — leaving both is trap §12.1's cousin (two
   renderings of one fact).
4. **The bell.** `NotificationBell.tsx` + the context wiring + the styles. Purely additive; if it misbehaves
   it can be hidden by rendering it for nobody without touching the page.
5. **Tune.** Dropdown size and poll interval (§10 Q6) once real usage is visible.

**No schema step — unless §10 Q2 is answered "unread", in which case Option C's column (§7.2) ships as
step 1.5, before the bell reads it.**

---

## 14. Relationship to the parent plan

| Parent plan (§) | This plan |
| --- | --- |
| §5 `form_access`, `form_access_events` | **Reused unchanged.** No new table (recommended). |
| §8 API surface (7 form-access routes) | **Reused unchanged** except `GET /summary`, which becomes `GET /notifications`. |
| §9 server functions | **Reused unchanged**; one thin wrapper (`listRecentAccessRequests`) for the capped, newest-first read. |
| §10.2 *"Admin: Access Requests, a section in Settings"* | **Superseded** — it becomes its own page (§6, §8). |
| §10.3 / §15 Q3 *"in-app only; the count is the notification"* | **Half-superseded.** In-app only **still stands** (§10 Q4); *"the count is the notification"* is **replaced** by a bell + a link + a page. §10.3's *"no notification abstraction"* is honoured: this plan adds **no** notification entity, only a read. |
| §13 trap 13 (*"a UI control the API refuses is worse than no control"*) | **Extended** — §12.10 (a deep link that no-ops). |
| §15 Q1/Q2/Q4/Q6/Q7 (who is restricted, per-person grants, any admin approves, revocable, history) | **Unchanged.** |
| §15 Q5 / §18 (a `denied` row is re-requestable) | **Unchanged** — the page's Denied tab shows the outcome; the *Request access again* button lives on *Available Forms*, not here. |
| §16 *Available Forms* (§16.5 the page, §16.6 does an admin need it) | **Complementary.** §16.6's open question (*"does an admin need the Available Forms page?"*) is answered here from the other side: an admin needs **this** page, and the bell is how they are told to open it. |

**One-line summary for the reviewer:** the request workflow is already built and org-scoped; this plan
**promotes its admin queue from a collapsed Settings section to a page, and turns the count into a bell with a
link to the item** — over existing data, with one new read endpoint and no schema change (unless you want a
true unread count, §10 Q2).


---

## 15. What shipped (2026-10-16)

Built as designed: **§4 Option A — derived, never stored.** The bell is a read of the org's
`status='pending'` `form_access` rows. **No new table, no column, no migration, no backfill**, and the
handler writes nothing (asserted by test — see below). Because the bell *is* the queue, it cannot disagree
with it, which is what makes inline Approve/Decline safe.

### 15.1 Delivered

| Plan § | Delivered as |
| --- | --- |
| §7.3 the read endpoint | `GET /api/form-access/notifications?limit=` in `server/src/routes/formAccess.ts`, registered in `inventory.ts` + `swagger.ts` (§7.5). **`GET /summary` is removed, not aliased** — nothing else called it. Default limit **5**, max **20**, clamped server-side. |
| §5 the bell | `client/src/components/NotificationBell.tsx`, mounted as the first child of `.actions` in `layout.tsx`. Badge = pending count, **nothing rendered at zero**, `99+` cap, count in the button's `aria-label`, **no `aria-live`** (§5.3), outside-click + Escape close. Admin-only. |
| §5.4 not gated | The bell is **not** in `menu_items` and is never defeatable; only the nav link is keyed. Verified by setting `menu_items.access_requests = ["staff"]` — the nav link disappeared, the bell stayed. |
| §6 the page | `client/src/pages/admin/AccessRequests.tsx` at `/admin/access-requests`. Tabs **Pending** (default) / Approved / Denied / All; columns Requester · Form · Requested · Status · Note · Actions. The **Status** cell carries the badge plus, once decided, *"By &lt;administrator&gt; on &lt;date&gt;"* (from `decided_by_name`, a LEFT join on the decider's account) — the badge alone cannot answer *"who approved this?"*. Per-row Actions: `pending` → Approve / Decline (inline reason input), `approved` → Revoke, `denied` → `—`. A **"Who has access?"** disclosure per row shows the per-form grant list with its own Revoke plus the full event history. |
| §6.4 deep links | `?user_id=&form_id=` forces the **Pending** tab, finds `id="req-{user}-{form}"`, `scrollIntoView({block:"center"})` and flashes `.row-flash` — **once per key** (a `focused` ref stops re-flash on unrelated rerenders). A key that is no longer pending says so rather than silently no-op'ing (§12.10). |
| §6.6 no reload | `AccessRequestsContext` is the single source for badge + dropdown + page; one decision calls `refresh()`, so both surfaces update in place. Re-reads on `location.pathname` change, plus one 60 s poll while the tab is visible. |
| §8 Settings retired | The `AdminSettings` triage section is now a **one-line link row** (*"No requests are waiting. Open Access Requests →"*). `loadUserAccess` / `removeAccess` are kept. |
| §10 Q5 nav key | `access_requests` added to `MENU_ITEM_KEYS` (server) and `MENU_ITEMS` + `MENU_ITEM_LABELS` (client), behind the same `menuVisible()` guard as `forms`. |

**One deliberate addition beyond the plan:** the page's **Refresh** action also calls `refreshBell()`, so a
manual refresh cannot leave the badge stale against the table beside it.

### 15.2 How it was verified

- **Server:** `describe("the administrator's bell")` — 8 new tests in `server/src/db/form-access.test.ts`,
  using source slices to assert the endpoint's *shape* rather than only its output: `/summary` is gone from
  all three registration files; `/notifications` is registered **and** documented; the handler contains **no**
  `INSERT|UPDATE|DELETE` and no `seen|unread|markAsRead`; it reads the same pending set as
  `countPendingAccessRequests`; the cap is in SQL (`selectPage(... pageSize: limit)`, no `.slice(`); and the
  triage queue's `ORDER BY` is untouched. **Suite: 327 passed / 16 files.**
- **Live API:** `limit=0` falls back to the default; `limit=99` clamps without error; **no token → 401**;
  **as `cdm_contact` → 403** (§11's permission control). The `menu_items` round trip was exercised and then
  **restored to its exact prior value**.
- **UI, end to end in a real browser** (all six §11 behavioural checks, against a real pending request from
  `kkey2@wcpss.net` on a restricted role): badge appears; deep link lands on Pending and flashes the right
  row; **Approve from the bell clears the badge to zero with no reload** and the requester can then read the
  form (confirmed by API); **Decline** shows the inline reason input and persists the note, rendered in the
  Denied tab; a **stale** deep link shows the "no longer waiting" notice; the **All** tab merges approved +
  denied; **Revoke** on an approved row works; Settings shows the retired one-line section; and the panel
  stays inside the viewport at **390 px**.
- **Client:** `npm run build` (`tsc -b && vite build`) exits 0.

### 15.3 Still deferred

- **§4.2 / §7.2 Option C** — a true *unread* count (`access_requests_seen_at` + a write endpoint). The badge
  counts **work waiting**, not new-since-last-look, so it cannot be cleared by looking. Unchanged from the
  plan's recommendation.
- **§10 Q1** — notifying the *requester*. `LockedFormPanel` / *Available Forms* report the outcome when they
  next visit; a requester bell is a second audience and its own decision.
- **§10 Q4** — Slack / e-mail. Still in-app only.