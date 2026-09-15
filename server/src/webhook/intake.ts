import { createSubmissionSchema } from "../schemas.js";
import { getForm, createSubmission } from "../db/queries.js";
import { sendSlackAlert } from "../notify/slack.js";
import type { WebhookErrorCode, WebhookEventStatus } from "../db/schema.js";

// -----------------------------------------------------------------------------
// Google Forms webhook intake (docs/plans/webhook-log.md).
//
// This module is the single definition of "what counts as a valid inbound
// webhook". Both the live route (routes/webhook.ts) and the replay route
// (routes/webhookEvents.ts) call `handleGoogleWebhookPayload`, so a replay can
// never drift from the live path — and, crucially, so a replay re-runs the
// *current* form-status check. That is what makes "an admin accidentally
// unpublished the form, republished it, now push the lost responses in" work:
// the stored payload is unchanged, but the check it runs against is today's.
//
// The module returns an outcome instead of writing a response, because the
// caller has to record the outcome in the log BEFORE it answers, and because the
// live route and the replay route answer differently (201 to Apps Script, a JSON
// row to the admin's browser).
// -----------------------------------------------------------------------------

export type IntakeOutcome = {
  /** Did a submission actually get created? */
  status: WebhookEventStatus;
  /** The HTTP status the LIVE route would return for this outcome. */
  httpStatus: number;
  errorCode: WebhookErrorCode | null;
  /** Short human-readable reason, stored on the log row. */
  error: string | null;
  /** Best-effort extraction — recorded even when the form does not exist. */
  formId: number | null;
  /**
   * The resolved form's organization, or null when the form could not be found.
   * Recorded as a value rather than derived from a join at read time: a deleted
   * form would leave the join NULL and hide the row from every admin.
   */
  organizationId: number | null;
  submissionId: number | null;
  publicId: string | null;
  /** The response body the live route sends (201 body, or the error envelope). */
  body: Record<string, unknown>;
  /** Set when the caller overrode the school year (replay — see Q7). */
  schoolYear: string | null;
};

export type IntakeOptions = {
  /**
   * Replay only: the school year to file the submission under, derived from the
   * ORIGINAL `received_at`. `createSubmission` otherwise computes it from
   * `new Date()`, so a response captured in July and replayed in September would
   * land in the wrong school year.
   */
  schoolYear?: string;
  /** Whether this is a live intake or a replay — changes the Slack wording only. */
  origin?: "live" | "replay";
};

/** Pull `form_id` out of an unvalidated body, for logging when validation fails. */
export function bodyFormId(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { form_id?: unknown }).form_id;
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isInteger(n)) return n;
  }
  return null;
}

/**
 * Validate and file one inbound webhook payload.
 *
 * Throws only for genuinely unexpected failures (a DB outage, a bug). Those
 * propagate to the caller's error handler so the request still 500s through the
 * normal `next(err)` path — the caller records the failure in a `finally`, so a
 * throw still produces a log row. Every *expected* condition (bad body, missing
 * form, unpublished form) is returned as an outcome, because those are exactly
 * the cases the log exists to make visible.
 */
export async function handleGoogleWebhookPayload(
  body: unknown,
  opts: IntakeOptions = {}
): Promise<IntakeOutcome> {
  const formId = bodyFormId(body);
  const base = {
    formId,
    organizationId: null,
    submissionId: null,
    publicId: null,
    schoolYear: opts.schoolYear ?? null,
  };

  const parsed = createSubmissionSchema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.flatten();
    return {
      ...base,
      status: "failed",
      httpStatus: 400,
      errorCode: "invalid_body",
      error: "Validation failed",
      body: { error: "Validation failed", details },
    };
  }
  const { form_id } = parsed.data;

  const form = await getForm(form_id);
  if (!form) {
    return {
      ...base,
      formId: form_id,
      status: "failed",
      httpStatus: 404,
      errorCode: "form_not_found",
      error: `Form ${form_id} not found`,
      body: { error: "Form not found" },
    };
  }
  if (form.status !== "published") {
    return {
      ...base,
      formId: form.id,
      organizationId: form.organization_id,
      status: "failed",
      httpStatus: 400,
      errorCode: "form_not_published",
      // The response text is unchanged (Apps Script may match on it) but the log
      // row records the actual status, which is what makes the UI able to say
      // "arrived while the form was an archived draft" instead of nothing.
      error: `Form is not accepting submissions (status: ${form.status})`,
      body: { error: "Form is not accepting submissions" },
    };
  }

  const submission = await createSubmission(form, parsed.data.answers, {
    schoolYear: opts.schoolYear,
  });

  // Admin Slack alert (not parents) — fire-and-forget, never blocks the 201.
  const isReplay = opts.origin === "replay";
  await sendSlackAlert(
    `📥 New submission to *${form.title}* (via Google Forms${isReplay ? ", replayed" : ""})`,
    [
      { title: "Form", value: form.title, short: true },
      { title: "Submitted ID", value: submission.public_id, short: true },
      { title: "School", value: submission.school_name ?? "—", short: true },
      { title: "Student", value: submission.student_name ?? form.title, short: true },
    ],
    {
      fallback: `New submission ${submission.public_id} to ${form.title} (Google Forms${
        isReplay ? ", replayed" : ""
      })`,
    }
  );

  return {
    ...base,
    formId: form.id,
    organizationId: form.organization_id,
    status: "succeeded",
    httpStatus: 201,
    errorCode: null,
    error: null,
    submissionId: submission.id,
    publicId: submission.public_id,
    body: {
      public_id: submission.public_id,
      message: "Submission received via webhook.",
    },
  };
}
