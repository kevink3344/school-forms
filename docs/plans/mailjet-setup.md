# Mailjet Email Setup — Reusable Plan

> **Reusable across projects.** This doc captures a complete, step-by-step Mailjet
> integration that can be copied into any Node/TypeScript app. The only parts that
> differ from project to project are the `.env` variable names and the import path
> for `env`. The Mailjet account/API flow, the Postman validation, and the
> `sendMail` helper are project-agnostic.
>
> Timeline: updated 2026-08-29. Free tier = **6,000 emails/month, 200/day**.

---

## 1. Why Mailjet

- **No domain required.** Unlike SendGrid (now paid-only) and Resend (requires domain
  verification), Mailjet supports **single-sender verification** with just a mailbox.
- **Generous free tier** (6,000/mo, 200/day) — overkill for a school-forms-style app.
- **Simple REST API** via `fetch` — no vendor SDK needed.
- Supports both **transactional** and **marketing** email (send API + SMTP relay) in one.

---

## 2. Create the account & sender

### 2.1 Sign up
- Go to **https://www.mailjet.com** → **Try for Free** (no credit card for free plan).
- Confirm the email; you'll land in the Mailjet dashboard.

### 2.2 Add + verify the sender (no DNS needed)
1. Dashboard → **Account → Senders** (or `https://app.mailjet.com/account/senders`).
2. Click **Add a Sender**.
3. Enter:
   - **Email** — the address you want to send *from* (e.g. `noreply@yourdomain.com`).
     - Must be a mailbox you can access. Free/webmail senders are allowed.
   - **Name** — e.g. `School Forms` (the visible From name).
4. Mailjet emails a **confirmation link** to that address — click it to verify.
5. The sender becomes **active** only after verification. You cannot send from an
   unverified sender (API returns a `400 Sender email ... is not verified`).

> **Optional (later):** authenticate the full domain (Account → Domain Authentication)
> with SPF/DKIM DNS records to improve deliverability and avoid spam folders. Not
> required to start sending.

---

## 3. Get API credentials

| Value | Where | Example |
|-------|-------|---------|
| **API Key** | Account → **API Key Management** | `a1b2c3...` (username) |
| **API Secret Key** | Same page | `d4e5f6...` (password) |

- If none exist, click **Create an API Key**.
- Mailjet auth is **HTTP Basic Auth**: `username = API Key`, `password = API Secret`.
- Mailjet keys are hex/numeric — **not** `SG.` (SendGrid) or `xkeysib-` (Brevo).

---

## 4. Validate with Postman (before writing any code)

### 4.1 Postman Environment
Create an environment (gear icon → Environments → **+**) named `Mailjet`:

| Variable | value |
|----------|-------|
| `api_key` | your API Key |
| `secret_key` | your Secret Key |
| `from_email` | your verified sender |
| `from_name` | e.g. `School Forms` |
| `to_email` | a test recipient you own |

### 4.2 Request
- **Method:** `POST` — **URL:** `https://api.mailjet.com/v3.1/send`
- **Authorization:** Basic Auth → Username `{{api_key}}`, Password `{{secret_key}}`
- **Headers:** `Content-Type: application/json`
- **Body (raw → JSON):**
```json
{
  "Messages": [
    {
      "From": { "Email": "{{from_email}}", "Name": "{{from_name}}" },
      "To": [ { "Email": "{{to_email}}" } ],
      "Subject": "School Forms test – notification",
      "TextPart": "Plain-text fallback.",
      "HTMLPart": "<h2>New submission</h2><p>Hello, you have a new submission.</p>"
    }
  ]
}
```

### 4.3 Expected result
`200 OK` → check the `to_email` inbox (~seconds). Response shape includes a
`Messages[0].Status: "success"` and per-recipient `MessageID`.

### 4.4 Common Postman errors
| Error | Fix |
|-------|-----|
| `400 Authorization Error` | Wrong key/secret, or Basic Auth not set |
| `400 Sender email ... is not verified` | Verify the sender (section 2.2) |
| `403 Sender address not allowed` | Sender not activated |
| `429` | Free-tier daily cap reached; pace tests |

---

## 5. Backend helper (`email.ts`)

Project-agnostic. Only the `env` import path and var names change per project.

```ts
// server/src/lib/email.ts
import { env } from "../config/env.js";

export async function sendMail(to: string, subject: string, html: string) {
  // Mailjet uses Basic Auth: username=API Key, password=Secret Key
  const auth = Buffer.from(`${env.sendgrid.apiKey}:${env.sendgrid.apiSecret}`).toString("base64");

  const res = await fetch("https://api.mailjet.com/v3.1/send", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      Messages: [
        {
          From: { Email: env.sendgrid.fromEmail, Name: env.sendgrid.fromName },
          To: [{ Email: to }],
          Subject: subject,
          HTMLPart: html,   // plain-text fallback: also send TextPart for deliverability
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Mailjet ${res.status}: ${await res.text()}`);
}
```

> **Deliverability tip:** prefer setting key env vars only when present:
> ```ts
> if (!env.sendgrid.apiKey || !env.sendgrid.fromEmail) return;  // no-op when not configured
> ```
> so the app works in development/CI where email is not wired up.

---

## 6. `.env` keys

Add to your repo-root `.env` (gitignored — holds real creds):

```dotenv
MAILJET_API_KEY=a1b2c3...
MAILJET_API_SECRET=d4e5f6...
MAILJET_FROM_EMAIL=noreply@yourdomain.com
MAILJET_FROM_NAME=School Forms
```

> Note: `env.ts` here maps these to `sendgrid.apiKey` / `sendgrid.apiSecret` /
> `sendgrid.fromEmail` / `sendgrid.fromName`. If you'd rather not carry the SendGrid
> name, rename the `env.ts` block to `mailjet.{apiKey,apiSecret,fromEmail,fromName}`.

---

## 7. Config block (`env.ts`)

Mirror the existing sub-object style (e.g. `db`, `google`):

```ts
mailjet: {
  apiKey: process.env.MAILJET_API_KEY ?? "",
  apiSecret: process.env.MAILJET_API_SECRET ?? "",
  fromEmail: process.env.MAILJET_FROM_EMAIL ?? "",
  fromName: process.env.MAILJET_FROM_NAME ?? "School Forms",
},
```

---

## 8. Notification hooks (where to trigger)

| Event | Hook location (school-forms) | Recipients |
|-------|------------------------------|-----------|
| **New submission** | `POST /api/submissions` success path | Staff for that school (or a configured admin) |
| **Google Doc generation failure** | `catch` in `server/src/google/docs.ts` | Admin |

Wire these as **background/no-await** (fire-and-forget with `.catch(() => {})`) so a
mail failure never breaks the submission request.

---

## 9. Production (Azure App Service)

When deployed to Azure, set the same values as **App Settings** (not `.env`):

| App setting | Value |
|-------------|-------|
| `MAILJET_API_KEY` | API key |
| `MAILJET_API_SECRET` | Secret key |
| `MAILJET_FROM_EMAIL` | verified sender |
| `MAILJET_FROM_NAME` | `School Forms` |

---

## 10. Alternatives (if Mailjet ever changes)

| Service | Free tier | Domain needed? | Auth style |
|---------|-----------|----------------|------------|
| **Mailjet** | 6,000/mo, 200/day | No (single sender) | Basic Auth (key+secret) |
| **Brevo** | ~300/day | No (single sender) | `api-key` header (Bearer) |
| **Resend** | 3,000/mo, 100/day | **Yes** (verify domain) | Bearer `re_...` |

The `sendMail` helper only needs the URL + payload shape swapped; `env.ts` and hooks
stay identical.
