# Webhooks Area (Settings) — Reusable Feature Plan

> **Audience** ⚠️ This document is written as a **reusable plan**. It describes the
> feature in a generic, app-agnostic way so you can lift it into other apps with
> the same backend stack (Node/Express + SQL Server, React SPA). Where it makes
> sense, concrete **School Forms** examples are inline so the plan is directly
> actionable in this repo.

---

## 1. Purpose / Concept

Admins need to push application events to **their own** HTTP endpoint, so their
systems can react in near-real time (e.g. "a user was created", "a submission
arrived"). This is the classic **outbound webhook** pattern.

Today the app only has *inbound* webhooks (Google Forms → us). This feature adds
the inverse: **us → a customer URL**, configurable entirely from the Admin UI.

> **Not this document:** the inbound side has its own feature — the **Webhook Log & Replay**
> (`docs/plans/webhook-log.md`, user guide §2.18), which records every inbound attempt
> including rejected ones and can re-send a response that arrived while its form was
> unpublished. The `dbo.webhooks` / `dbo.webhook_deliveries` tables described below are
> for **outbound** delivery and are unrelated to the inbound `dbo.webhook_events` log.

### Core capability

The Admin opens **Settings → Webhooks** and sees a list of configured webhooks.
Clicking **“New webhook”** opens a **right slide-out drawer** where the Admin enters:

| Field                  | Notes                                                                  |
| ---------------------- | ---------------------------------------------------------------------- |
| **Title**              | Friendly display name, e.g. “Notify our ERP of new users”.              |
| **Webhook URL**        | `https://customer.example.com/hooks/user-created`.                      |
| **Webhook JSON body**  | A JSON **template** with `{{placeholder}}` tokens, e.g. `{"id": "{{user.id}}"}`. |
| **Event**              | A dropdown of the app’s supported API events, e.g. **“User Created”**.  |
| **Active / Inactive**  | A toggle. Inactive webhooks are saved but never fired.                  |

Every configured webhook is also **listed in this area** with its event, active
state, and latest delivery status.

---

## 2. Terminology

- **Event** — a named, app-defined occurrence that can trigger webhooks. Each has
  a stable identifier (`user.created`) and a human label (“User Created”).
- **Webhook** — a *configuration* row binding an event to a destination URL and a
  body template.
- **Template** — the JSON body with `{{token}}` placeholders that get substituted
  with data from the event payload at delivery time.
- **Delivery** — a single attempt to POST a rendered body to a webhook URL. Recorded
  so admins can see success/failure history.
- **Event payload** — the structured object passed to `emitEvent(type, payload)`.
  Placeholders resolve against this object.

---

## 3. Data Model

Two new tables. The `webhooks` table stores configuration; `webhook_deliveries`
records the fire-and-forget attempt history. Both use the existing SQL Server
idioms (idempotent DDL, surrogate PK, `SYSUTCDATETIME()` defaults) from
`server/src/db/schema.ts`.

### 3.1 `dbo.webhooks`

| Column                 | Type                                     | Notes                                             |
| ---------------------- | ---------------------------------------- | ------------------------------------------------- |
| `id`                   | `INT IDENTITY(1,1) PRIMARY KEY`          | Surrogate PK.                                     |
| `organization_id`      | `INT NULL`                               | FK → organizations. `NULL` = app-global. *(Optional for multi-tenant apps.)* |
| `title`                | `NVARCHAR(200) NOT NULL`                 | Display name.                                     |
| `event`                | `NVARCHAR(100) NOT NULL`                 | Event id, e.g. `user.created`. Matches the registry. |
| `url`                  | `NVARCHAR(2000) NOT NULL`                | Destination endpoint. Validation below.           |
| `body_template`        | `NVARCHAR(MAX) NOT NULL`                 | JSON with `{{token}}` placeholders.               |
| `active`               | `BIT NOT NULL DEFAULT 1`                 | Toggle. Inactive = saved but never fired.         |
| `created_at`           | `DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()` |                                          |
| `updated_at`           | `DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()` |                                          |
| `last_delivery_status` | `NVARCHAR(20) NULL`                      | Denormalized latest attempt (`success` / `failed` / `NULL`). |
| `last_delivery_at`     | `DATETIME2 NULL`                         | Latest attempt timestamp.                        |

```sql
IF OBJECT_ID('dbo.webhooks', 'U') IS NULL
CREATE TABLE dbo.webhooks (
  id                  INT IDENTITY(1,1) PRIMARY KEY,
  organization_id     INT NULL,
  title               NVARCHAR(200) NOT NULL,
  [event]             NVARCHAR(100) NOT NULL,
  url                 NVARCHAR(2000) NOT NULL,
  body_template       NVARCHAR(MAX) NOT NULL,
  active              BIT NOT NULL CONSTRAINT DF_webhooks_active DEFAULT 1,
  created_at          DATETIME2 NOT NULL CONSTRAINT DF_webhooks_created_at DEFAULT SYSUTCDATETIME(),
  updated_at          DATETIME2 NOT NULL CONSTRAINT DF_webhooks_updated_at DEFAULT SYSUTCDATETIME(),
  last_delivery_status NVARCHAR(20) NULL,
  last_delivery_at    DATETIME2 NULL,
  CONSTRAINT FK_webhooks_organization FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id) ON DELETE CASCADE
);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_webhooks_event')
  CREATE INDEX IX_webhooks_event ON dbo.webhooks([event]);
```

> **Cascade note:** `organizations` is an ancestor of **nothing** on this FK is the
> only path, so `ON DELETE CASCADE` is safe here (no “multiple cascade paths”).
> If you make this app-global (`organization_id NULL`), you can drop the FK entirely.

### 3.2 `dbo.webhook_deliveries`

| Column       | Type                            | Notes                                            |
| ------------ | ------------------------------- | ------------------------------------------------ |
| `id`         | `INT IDENTITY(1,1) PRIMARY KEY` | Surrogate PK.                                    |
| `webhook_id` | `INT NOT NULL`                  | FK → webhooks `ON DELETE CASCADE`.               |
| `event`      | `NVARCHAR(100) NOT NULL`        | Snapshot of the event id.                        |
| `payload`    | `NVARCHAR(MAX) NOT NULL`        | The **rendered** body actually POSTed.           |
| `status`     | `NVARCHAR(20) NOT NULL`         | `success` / `failed`. `CHECK` constraint.        |
| `http_status`| `INT NULL`                      | Response code (or `NULL` on network error).      |
| `attempts`   | `INT NOT NULL DEFAULT 1`        | Retry count.                                     |
| `error`      | `NVARCHAR(MAX) NULL`            | Reason for failure.                              |
| `created_at` | `DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()` |                                     |

```sql
IF OBJECT_ID('dbo.webhook_deliveries', 'U') IS NULL
CREATE TABLE dbo.webhook_deliveries (
  id          INT IDENTITY(1,1) PRIMARY KEY,
  webhook_id  INT NOT NULL,
  [event]     NVARCHAR(100) NOT NULL,
  payload     NVARCHAR(MAX) NOT NULL,
  status      NVARCHAR(20) NOT NULL
              CHECK (status IN ('success','failed')),
  http_status INT NULL,
  attempts    INT NOT NULL CONSTRAINT DF_webhook_deliveries_attempts DEFAULT 1,
  [error]     NVARCHAR(MAX) NULL,
  created_at  DATETIME2 NOT NULL CONSTRAINT DF_webhook_deliveries_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_webhook_deliveries_webhook FOREIGN KEY (webhook_id) REFERENCES dbo.webhooks(id) ON DELETE CASCADE
);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_webhook_deliveries_webhook')
  CREATE INDEX IX_webhook_deliveries_webhook ON dbo.webhook_deliveries(webhook_id);
```

---

## 4. Event Registry

The “select the API request that triggers the webhook” dropdown is driven by a
**single source of truth**: a registry of events, each mapping a stable name to a
label + description + the payload it carries.

### 4.1 Registry shape

Define it once in the backend (`server/src/webhooks/events.ts`), then serve it to
the UI. This keeps the dropdown and the emitter in lockstep.

```ts
export interface WebhookEvent {
  /** Stable identifier used in the DB and in emitEvent(). */
  name: string;
  /** Human label for the Settings dropdown, e.g. "User Created". */
  label: string;
  /** Optional short description shown under the label. */
  description?: string;
}

export const WEBHOOK_EVENTS: WebhookEvent[] = [
  { name: "user.created", label: "User Created", description: "A user was added." },
  { name: "submission.created", label: "Submission Received", description: "A form was submitted." },
  { name: "document.completed", label: "Document Generated", description: "A Google Doc was created from a submission." },
  { name: "school.imported", label: "Schools Imported", description: "The school roster was imported." },
];
```

> **Porting a new app:** edit this one array. The dropdown, the emitter’s type
> safety, and the schema CHECK all derive from it. No other code needs touching
> to add a new event.

### 4.2 School Forms example events (grounded in real routes)

| Event                 | Firing route (School Forms)      | Payload highlights                              |
| --------------------- | -------------------------------- | ----------------------------------------------- |
| `user.created`        | `POST /api/users`                | `{ user: { id, email, role, display_name, school_id } }` |
| `submission.created`  | `POST /api/submissions` + `/api/webhook/google` | `{ submission: { public_id, form_id, school_id, submitted_at } }` |
| `document.completed`  | document creation path           | `{ document: { submission_id, document_id, status } }` |
| `school.imported`     | `POST /api/schools/import`       | `{ import: { total } }`                        |

---

## 5. Backend — Emit + Dispatch Engine

Two responsibilities:

1. **Emit** — call `emitEvent(type, payload)` from a route after a successful
   mutation. This is the app’s single hook point.
2. **Dispatch** — asynchronously render the template, POST to the URL, and record
   a delivery. **Never block the main request**; webhooks are fire-and-forget.

### 5.1 The emitter

```ts
// server/src/webhooks/notify.ts
import { pool } from "../db/pool.js";

export async function emitEvent(event: string, payload: unknown): Promise<void> {
  // Load every **active** webhook registered for this event.
  // Fire-and-forget: the caller must NOT await this.
  const rows = await pool.request()
    .input("event", event)
    .query(`SELECT * FROM dbo.webhooks WHERE [event] = @event AND active = 1`);

  await Promise.allSettled(
    rows.recordset.map(async (wh) => {
      try {
        const body = renderTemplate(wh.body_template, payload);
        const res = await deliver(wh, body, payload);
        await recordDelivery(wh.id, event, body, res);
      } catch (err) {
        await recordDelivery(wh.id, event, bodyForLog(payload), { ok: false, status: null, error: String(err) });
      }
    })
  );
}
```

> **Two guaranteed behaviors:**
> - `emitEvent` catches everything (via `Promise.allSettled`), so a failing customer
>   URL can never break creating the user/submission.
> - Callers `void emitEvent(...)` (or `.catch(() => {})`) so they don’t await it.

### 5.2 Template rendering

Template tokens use `{{path.to.value}}`. Rendering walks the payload object:

```ts
function renderTemplate(template: string, payload: unknown): string /* JSON string */ {
  return template.replace(/\{\{\s*([\w.[\]-]+)\s*\}\}/g, (_m, path) => {
    const val = getPath(payload, path);
    return val === undefined || val === null ? "" : JSON.stringify(val).replace(/^"|"$/g, "");
  });
}
```

**Rules to document in the UI:**
- `{{user.id}}` → the value at that path.
- Missing/`null` path → an empty string (never `"undefined"`).
- Arrays/objects are JSON-encoded; scalars are unquoted.
- The template must be **valid JSON** — validate it on save (see §7).

Add a small **“Test”** button in the drawer that POSTs a sample payload to be sure
the template resolves before saving.

### 5.3 The dispatcher (URL validation, timeout, retries, signing)

```ts
const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;

async function deliver(webhook: Webhook, body: string, payload: unknown) {
  if (!isAllowedUrl(webhook.url)) throw new Error("Blocked URL");
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Event": webhook.event,
          ...(signingSecret ? { "X-Webhook-Signature": sign(payload, signingSecret) } : {}),
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (res.ok) return { ok: true, status: res.status, error: null };
      // 4xx/5xx → record and maybe retry
    } catch (err) {
      // network error / timeout → retry
    }
    await sleep(1000 * attempt); // simple backoff
  }
  return { ok: false, status: null, error: "Max retries reached" };
}
```

---

## 6. Security Considerations (important for a *reusable* plan)

| Concern         | Handling                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------- |
| **SSRF**        | Only allow `https://` (optionally `http://` only for localhost dev). Block private IPs / `localhost` / link-local & metadata ranges unless explicitly allowed. `isAllowedUrl()` above. |
| **Signing**      | Optional `X-Webhook-Signature` = `HMAC-SHA256` of the raw body using a per-app secret (`WEBHOOK_SIGNING_SECRET`). Recipient verifies integrity. |
| **Secrets**      | Never store the signing secret in a webhook row. Only the *destination* URL is user-controlled. |
| **TLS**          | Require HTTPS in production. Reject plain `http://` outside dev.                                |
| **Payload leaks**| Only put non-sensitive data in event payloads. Avoid secrets/tokens.                             |
| **Rate limiting**| Cap deliveries per webhook per minute to protect both parties.                                  |

---

## 7. API Endpoints

All admin-only (`requireRoles("admin")`), except `GET /api/webhooks/events` which
can also be public if any future role needs it.

| Method | Path                       | Purpose                                | Notes |
| ------ | -------------------------- | -------------------------------------- | ----- |
| `GET`  | `/api/webhooks`            | List all webhooks.                     | Include latest delivery status. |
| `GET`  | `/api/webhooks/events`     | List available events (for the dropdown). | From the registry. |
| `POST` | `/api/webhooks`            | Create a webhook.                      | Validate event exists, URL allowed, template is valid JSON. |
| `PUT`  | `/api/webhooks/:id`        | Update a webhook.                      | Same validation. |
| `DELETE`| `/api/webhooks/:id`        | Delete a webhook.                      | Cascades deliveries. |
| `POST` | `/api/webhooks/:id/test`   | Send a sample payload to verify.       | Uses a canned payload for that event. |

**Validation on create/update (reusable list):**
- `title` — non-empty string ≤ 200 chars.
- `event` — must be in `WEBHOOK_EVENTS`.
- `url` — valid, allowed by `isAllowedUrl()`.
- `body_template` — must parse as valid JSON **after** token substitution with a
  sample payload. (Cheap way: render against the event’s sample payload and
  `JSON.parse` the result.)
- `active` — boolean.

### 7.1 Concrete School Forms wiring

Add `server/src/routes/webhooks.ts` (N.B. distinct from the existing
`webhook.ts` *inbound* Google route) and mount:

```ts
app.use("/api/webhooks", webhooksRouter);
```

---

## 8. Frontend UI

All inside `client/src/pages/admin/AdminSettings.tsx`, following the **Organizations
drawer** pattern that already exists (right slide-out drawer, form-grid fields,
`Toggle` switch, optimistic updates).

### 8.1 Settings → Webhooks section

A new `CollapsibleSection title="Webhooks"` with:

- A **`+ Add Webhook`** button (opens the drawer).
- A **table** listing each webhook: **Title**, **Event** (badge), **Active** toggle,
  **Last delivery** status (e.g. “Success · 2m ago” / “Failed”), and an **Edit**
  action. Clicking a row opens the drawer pre-filled for edit.

### 8.2 The right slide-out drawer (“New webhook”)

Reuse the existing `.drawer` / `.drawer-overlay` markup from the Organizations
panel. Fields:

1. **Title** — text input.
2. **Event** — `<select>` populated from `GET /api/webhooks/events`.
3. **Webhook URL** — text input `https://…`.
4. **Webhook JSON body** — `<textarea>` (monospace) with a **live “Test”**
   button and an inline **parse error** line if the template isn’t valid JSON.
5. **Active** — the existing `<Toggle>` switch.

Form state:

```ts
interface WebhookForm {
  id: number | null;      // null → create
  title: string;
  event: string;          // e.g. "user.created"
  url: string;
  body_template: string;  // JSON template
  active: boolean;
}
```

### 8.3 API client additions (`client/src/lib/api.ts`)

```ts
async listWebhooks(): Promise<WebhookRow[]>
async listWebhookEvents(): Promise<WebhookEvent[]>
async createWebhook(input: WebhookInput): Promise<WebhookRow>
async updateWebhook(id: number, input: Partial<WebhookInput>): Promise<WebhookRow>
async deleteWebhook(id: number): Promise<void>
async testWebhook(id: number): Promise<{ ok: boolean }>
```

Add the corresponding types to `client/src/types/index.ts`:

```ts
export type WebhookEventName =
  | "user.created"
  | "submission.created"
  | "document.completed"
  | "school.imported";

export interface WebhookEvent {
  name: WebhookEventName;
  label: string;
  description?: string;
}

export interface WebhookRow {
  id: number;
  title: string;
  event: WebhookEventName;
  url: string;
  body_template: string;
  active: boolean;
  last_delivery_status: "success" | "failed" | null;
  last_delivery_at: string | null;
}
```

---

## 9. Implemented UX Flow

```
Settings → Webhooks
   │
   ├─ List (table): Title · Event · Active toggle · Last delivery · Edit
   │
   └─ [ + Add Webhook ] ──► right slide-out drawer
        ├─ Title
        ├─ Event  (dropdown ← GET /api/webhooks/events)
        ├─ Webhook URL
        ├─ Webhook JSON body (textarea + [ Test ] + parse-error line)
        └─ Active toggle
             │
             └─ [ Save ] → POST/PUT /api/webhooks → refresh list
```

---

## 10. Retry / Delivery UX Considerations

- Watch **only** the latest delivery on the list; full history in a per-webhook
  “Deliveries” action (optional v2).
- On a `failed` destination, keep the webhook `active` but surface a red badge.
- Consider a **global event log** of every emission (even when no webhook matches)
  if you want to debug “why didn’t my webhook fire?” — cheap and helpful.

---

## 11. Reusability — How to Port This to Another App

This plan is self-contained. To drop it into another app:

1. **Copy the two tables** §3 into your schema (drop the org FK if not multi-tenant).
2. **Copy the event registry** §4.1 and replace `WEBHOOK_EVENTS` with your own
   events — add a new event by adding one line there.
3. **Copy the emitter + dispatcher** §5 into a `webhooks/notify.ts` module.
4. **Add `emitEvent(<your event>, <payload>)`** calls in the routes that should fire.
   One line per trigger point.
5. **Copy the API** §7 (adjust auth guard to match your role model).
6. **Copy the Settings UI** §8 — the drawer/table pattern maps cleanly to any admin
   settings page.

**The single strongest reuse decision:** keep the event registry as the one source of
truth. It drives the dropdown, the emitter’s allowed values, and the schema CHECK —
so adding or removing events never requires touching UI or dispatch code in multiple
places.

---

## 12. School Forms Implementation File Map

| Change                    | File                                       |
| ------------------------- | ------------------------------------------ |
| Two new tables            | `server/src/db/schema.ts` (append DDL)     |
| Typed rows + events      | `server/src/db/queries.ts` + `server/src/webhooks/events.ts` |
| Emitter + dispatcher      | `server/src/webhooks/notify.ts` (new)      |
| API route + validation    | `server/src/routes/webhooks.ts` (new)      |
| Mount router + Swagger    | `server/src/index.ts` + `server/src/swagger.ts` |
| `emitEvent(...)` calls    | route handlers (e.g. `routes/users.ts`, `routes/submissions.ts`) |
| API client + types        | `client/src/lib/api.ts` + `client/src/types/index.ts` |
| Settings section + drawer | `client/src/pages/admin/AdminSettings.tsx` |

---

## 13. Open Questions (decide before build)

1. **Default active?** Recommend **Inactive by default** so a misconfigured URL can’t
   fire until the admin toggles it on and tests.
2. **Retries?** Recommend 3 with simple backoff, then mark `failed`. Configurable per
   webhook is an optional v2.
3. **Delivery history UI depth?** v1 = latest status only. v2 = expandable per-webhook
   history table.
4. **Signing secret**: set one global `WEBHOOK_SIGNING_SECRET` env var (recommended),
   or expose per-webhook secrets (more secure, more UI).
5. **Events to start with**: In School Forms, ship `user.created` + `submission.created`
   first — they map to existing routes and are easy to verify.
