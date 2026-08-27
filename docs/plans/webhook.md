# Google Forms Webhook — Intake Plan

## Purpose

This lets a **Google Form** be an alternate intake path. A parent (or staff member)
fills in a Google Form instead of the in-app `/submit` page; a Google Apps Script
`onSubmit` trigger forwards the responses to our REST API, which creates a normal,
anonymous submission record exactly like the in-app flow.

Because the API is role-gated (`admin`/`staff` only) and parents are anonymous,
the webhook endpoint is **public** but **protected by a shared secret** so only your
script can post. The submission itself is still just a `submissions` row — it shows up
in the admin spreadsheet view and staff queue like any other.

> **Why a webhook route instead of reusing `POST /api/submissions` directly?**
> The existing `POST /api/submissions` is the in-app public endpoint. Reusing it from
> Google would be fine, but a separate `/api/webhook/google` endpoint lets us:
> - require the webhook secret header (the in-app endpoint can't), and
> - keep the two intake paths independently auditable.
>
> If you'd rather not add a route, the Apps Script below can POST straight to
> `{API_BASE_URL}/api/submissions` and omit the `X-Webhook-Secret` header. Both work.

---

## 1. Backend — new route `server/src/routes/webhook.ts`

Create this file. It mirrors the logic of `POST /api/submissions` but adds the
`X-Webhook-Secret` guard.

```ts
import { Router } from "express";
import crypto from "node:crypto";
import { createSubmissionSchema } from "../schemas.js";
import { getForm, createSubmission } from "../db/queries.js";
import { newPublicId } from "../db/schema.js";
import { env } from "../config/env.js";

export const webhookRouter = Router();

// Constant-time secret comparison to avoid timing attacks.
function secretMatches(expected: string, provided: string | undefined): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(provided));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// PUBLIC (secret-guarded): POST /api/webhook/google
// Body (same shape as the in-app submission): { form_id, answers: [{ field_id, value }] }
// Header: X-Webhook-Secret
webhookRouter.post("/google", async (req, res, next) => {
  try {
    if (!secretMatches(env.googleWebhookSecret, req.header("x-webhook-secret") ?? "")) {
      res.status(401).json({ error: "Invalid or missing webhook secret" });
      return;
    }

    const parsed = createSubmissionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const { form_id, answers } = parsed.data;

    const form = await getForm(form_id);
    if (!form) {
      res.status(404).json({ error: "Form not found" });
      return;
    }
    if (form.status !== "published") {
      res.status(400).json({ error: "Form is not accepting submissions" });
      return;
    }

    const submission = await createSubmission(form_id, form.school_id, newPublicId(), answers);

    res.status(201).json({
      public_id: submission.public_id,
      message: "Submission received via webhook.",
    });
  } catch (err) {
    next(err);
  }
});
```

### Mount the router in `server/src/index.ts`

Add the import near the other route imports:

```ts
import { webhookRouter } from "./routes/webhook.js";
```

And mount it alongside the other routers (after the existing route mounts):

```ts
app.use("/api/webhook", webhookRouter);
```

### Register it in Swagger (`server/src/swagger.ts`)

Add a path so the route is documented and testable in the UI:

```ts
"/api/webhook/google": {
  post: {
    summary: "Google Forms webhook — create submission",
    description:
      "Public endpoint guarded by the X-Webhook-Secret header. " +
      "Accepts the same body as POST /api/submissions. Calls must include the " +
      "X-Webhook-Secret header set via GOOGLE_FORMS_WEBHOOK_SECRET.",
    security: [],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/CreateSubmission" },
        },
      },
    },
    parameters: [
      {
        name: "X-Webhook-Secret",
        in: "header",
        required: true,
        schema: { type: "string" },
        description: "Shared secret from GOOGLE_FORMS_WEBHOOK_SECRET.",
      },
    ],
    responses: {
      "201": {
        description: "Submission created",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                public_id: { type: "string" },
                message: { type: "string" },
              },
            },
          },
        },
      },
      "400": { description: "Validation failed" },
      "401": { description: "Invalid or missing webhook secret" },
      "404": { description: "Form not found" },
    },
  },
},
```

---

## 2. Environment — `.env`

`GOOGLE_FORMS_WEBHOOK_SECRET` is already read by `server/src/config/env.ts`
(exposed as `env.googleWebhookSecret`) and already present in `.env` / `.env.example`.
Just make sure it's a long, random value and **not** the placeholder:

```env
GOOGLE_FORMS_WEBHOOK_SECRET=your-long-random-secret
```

Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## 3. Google Apps Script

In your Google Form → **Extensions → Apps Script**. This script runs on every form
submission. It:

1. Reads the latest submitted response.
2. Maps each **question title** to the matching **field_id** on your published form
   (via `GET /api/forms/:id/public`).
3. Posts `{ form_id, answers }` to the webhook endpoint with the secret header.

```javascript
/**
 * Google Forms → School Forms webhook.
 *
 * CONFIG — edit these to match your environment:
 */
const API_BASE_URL = "https://your-school-forms-api.azurewebsites.net"; // or http://localhost:4000
const FORM_ID = 1;                       // the numeric id of the published form in School Forms
const WEBHOOK_SECRET = "your-long-random-secret"; // must match GOOGLE_FORMS_WEBHOOK_SECRET

/**
 * Runs on form submission. Trigger: Form -> On form submit.
 */
function onFormSubmit(e) {
  // e.response is the form response. In newer triggers it's also accessible
  // via e.source. We guard for both trigger shapes.
  const itemResponses = (e.response || e.source.getActiveResponse()).getItemResponses();

  // 1. Get the published form's fields so we can map question title -> field_id.
  const fieldMap = getFieldMap(FORM_ID); // { "Question title": field_id }

  // 2. Build the answers array.
  const answers = [];
  for (const itemResponse of itemResponses) {
    const title = itemResponse.getItem().getTitle();
    const raw = itemResponse.getResponse();
    // Normalize value: single value -> string; checkbox -> string[].
    const value = Array.isArray(raw) ? raw.map((v) => String(v)) : String(raw);

    const fieldId = fieldMap[title];
    if (fieldId) {
      answers.push({ field_id: fieldId, value });
    } else {
      // Unmatched question — log and continue (don't block the whole submission).
      console.log("No matching field for question: " + title);
    }
  }

  if (answers.length === 0) {
    throw new Error("No answers mapped to form fields. Check question titles against form labels.");
  }

  // 3. Post to the webhook.
  const payload = { form_id: FORM_ID, answers: answers };
  const options = {
    method: "post",
    contentType: "application/json",
    headers: { "X-Webhook-Secret": WEBHOOK_SECRET },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true, // so we can inspect the HTTP status on failure
  };

  const response = UrlFetchApp.fetch(API_BASE_URL + "/api/webhook/google", options);
  const status = response.getResponseCode();

  if (status !== 201) {
    // 400 = validation, 401 = bad secret, 404 = unknown form.
    throw new Error("Webhook failed (" + status + "): " + response.getContentText());
  }

  console.log("Submission created, public_id: " + response.getContentText());
}

/**
 * Fetch the published form and return a map of { label: field_id }.
 * Only non staff_only fields are returned by the public endpoint.
 */
function getFieldMap(formId) {
  const options = {
    method: "get",
    contentType: "application/json",
    muteHttpExceptions: true,
  };
  const response = UrlFetchApp.fetch(API_BASE_URL + "/api/forms/" + formId + "/public", options);
  if (response.getResponseCode() !== 200) {
    throw new Error("Could not fetch form " + formId + ": " + response.getContentText());
  }
  const form = JSON.parse(response.getContentText());
  const map = {};
  for (const field of form.fields) {
    map[field.label] = field.id;
  }
  return map;
}
```

### Important matching note

The Apps Script maps **question title** → **field_id** by exact label match. So the
Google Form question titles must **exactly match** the `label` values you set in the
School Forms form designer. If a label changes, update the Google Form title (or the
mapping) accordingly.

### Set up the trigger

1. In Apps Script, click the clock icon (**Triggers**).
2. **Add trigger** → choose `onFormSubmit`.
3. Event source: **From spreadsheet** or **From form** (your choice).
4. Run as: your account, access level required.
5. Test it by submitting the Google Form once, then check **Executions** for success.

---

## 4. Testing the webhook

Once the backend is running (`npm run dev`):

```bash
# Happy path (expect 201)
curl -X POST "http://localhost:4000/api/webhook/google" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: your-long-random-secret" \
  -d '{"form_id":1,"answers":[{"field_id":1,"value":"Jane Doe"},{"field_id":2,"value":"54321"}]}'

# Bad secret (expect 401)
curl -X POST "http://localhost:4000/api/webhook/google" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: wrong" \
  -d '{"form_id":1,"answers":[{"field_id":1,"value":"Jane Doe"}]}'

# Unknown form (expect 404)
curl -X POST "http://localhost:4000/api/webhook/google" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: your-long-random-secret" \
  -d '{"form_id":999,"answers":[{"field_id":1,"value":"Jane Doe"}]}'
```

Confirmed submissions appear in the admin spreadsheet view and the staff queue exactly
like in-app submissions, with `status = submitted`.

---

## 5. Optional — server-side secret as a constant-time issue

The `secretMatches` helper uses `crypto.timingSafeEqual`. `env.googleWebhookSecret`
defaults to an empty string when unset, so an unset secret causes every webhook call to
return `401` rather than accidentally succeeding — a safe fail-closed behavior.

## 6. Deploying to Azure

In **Azure Web Apps → Configuration → App settings**, ensure these are set in production
(mirroring your `.env`):

- `GOOGLE_FORMS_WEBHOOK_SECRET`
- `API_BASE_URL` = `https://your-school-forms-api.azurewebsites.net`

Then update the `API_BASE_URL` constant in the Apps Script to the production URL.
