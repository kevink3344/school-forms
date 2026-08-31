import { Router } from "express";
import crypto from "node:crypto";
import { createSubmissionSchema } from "../schemas.js";
import { getForm, createSubmission } from "../db/queries.js";
import { env } from "../config/env.js";
import { sendSlackAlert } from "../notify/slack.js";

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
// -----------------------------------------------------------------------------
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

    const submission = await createSubmission(form, answers);

    // Admin Slack alert (not parents) — fire-and-forget, never blocks the 201.
    await sendSlackAlert(
      `📥 New submission to *${form.title}* (via Google Forms)`,
      [
        { title: "Form", value: form.title, short: true },
        { title: "Submitted ID", value: submission.public_id, short: true },
        { title: "School", value: submission.school_name ?? "—", short: true },
        { title: "Student", value: submission.student_name ?? form.title, short: true },
      ],
      { fallback: `New submission ${submission.public_id} to ${form.title} (Google Forms)` }
    );

    res.status(201).json({
      public_id: submission.public_id,
      message: "Submission received via webhook.",
    });
  } catch (err) {
    next(err);
  }
});
