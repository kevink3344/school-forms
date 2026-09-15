import { Router } from "express";
import crypto from "node:crypto";
import { env } from "../config/env.js";
import { recordWebhookEvent } from "../db/webhook-events.js";
import type { WebhookAuthResult } from "../db/schema.js";
import { bodyFormId, handleGoogleWebhookPayload, type IntakeOutcome } from "../webhook/intake.js";
import { capturedPayload, remoteIp, userAgent } from "../webhook/raw-body.js";

export const webhookRouter = Router();

// Constant-time secret comparison to avoid timing attacks.
function secretMatches(expected: string, provided: string | undefined): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(provided));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// -----------------------------------------------------------------------------
// PUBLIC (secret-guarded): POST /api/webhook/google
// Body (same shape as the in-app submission): { form_id, answers: [{ field_id, value }] }
// Header: X-Webhook-Secret
//
// EVERY attempt is recorded in dbo.webhook_events, success or failure
// (docs/plans/webhook-log.md Q1). The write happens BEFORE the reply is sent, and
// it cannot be skipped by an early return — the previous shape returned
// 401/400/404 BEFORE writing anything, which meant a Google Form response that
// arrived while its form was unpublished vanished without a trace.
//
// Capture payload -> decide outcome -> LOG -> answer. Logging first (rather than
// in a `finally` after `res.json()`) is what makes "every attempt is recorded"
// true at the moment the caller is answered: Apps Script retries the instant it
// sees a failure, and an admin opens this log to find out why, so the row must
// already exist. It also closes the window in which a crash after replying lost
// the record of the very request that had just been answered.
//
// Safe to write first because `recordWebhookEvent` never throws (see
// db/webhook-events.ts) — a logging failure must not replace a legitimate
// response with a 500.
// -----------------------------------------------------------------------------
webhookRouter.post("/google", async (req, res, next) => {
  const payload = capturedPayload(req);
  const ip = remoteIp(req);
  const ua = userAgent(req);

  // Defaults describe the worst case: if something throws below, this is what
  // gets logged, which is exactly when a record matters most.
  let outcome: IntakeOutcome = {
    status: "failed",
    httpStatus: 500,
    errorCode: "internal_error",
    error: "Unexpected error during intake",
    formId: bodyFormId(req.body),
    organizationId: null,
    submissionId: null,
    publicId: null,
    body: { error: "INTERNAL_SERVER_ERROR" },
    schoolYear: null,
  };
  let authResult: WebhookAuthResult = "ok";
  // Held rather than rethrown so the record is still written for a crash.
  let unexpected: unknown = null;

  try {
    const provided = req.header("x-webhook-secret");
    if (!secretMatches(env.googleWebhookSecret, provided ?? "")) {
      // Distinguish "no header at all" from "wrong header": the first is a
      // misconfigured Apps Script, the second a rotated secret.
      authResult = provided ? "invalid" : "missing";
      outcome = {
        ...outcome,
        httpStatus: 401,
        errorCode: "unauthorized",
        error: "Invalid or missing webhook secret",
        body: { error: "Invalid or missing webhook secret" },
      };
    } else {
      outcome = await handleGoogleWebhookPayload(req.body, { origin: "live" });
    }
  } catch (err) {
    // Genuinely unexpected (DB down, bug). The 500 default above is what gets
    // logged, then the error goes through the normal error handler so the stack
    // is logged and the client sees the usual 500 shape.
    unexpected = err;
  }

  await recordWebhookEvent({
    source: "google",
    remoteIp: ip,
    userAgent: ua,
    authResult,
    status: outcome.status,
    httpStatus: outcome.httpStatus,
    errorCode: outcome.errorCode,
    error: outcome.error,
    formId: outcome.formId,
    organizationId: outcome.organizationId,
    submissionId: outcome.submissionId,
    publicId: outcome.publicId,
    // A failed secret check means the body came from someone who does not hold
    // the secret, so it is NOT stored — otherwise the endpoint becomes free
    // storage for anyone who can guess the URL. The row is still written, so a
    // burst of probing is visible even though its contents are not.
    payloadRaw: authResult === "ok" ? payload.raw : null,
    payloadBytes: payload.bytes,
    payloadHash: authResult === "ok" ? payload.hash : null,
    replayOf: null,
    replayedBy: null,
  });

  if (unexpected) {
    next(unexpected);
    return;
  }
  res.status(outcome.httpStatus).json(outcome.body);
});
