import { Router } from "express";
import {
  createSubmission,
  getSubmissionDetail,
  listSubmissions,
  listSubmissionValues,
  listComments,
  updateSubmissionStatus,
  createComment,
} from "../db/queries.js";
import { requireAuth, requireRoles } from "../auth.js";
import {
  createSubmissionSchema,
  updateSubmissionStatusSchema,
  createCommentSchema,
} from "../schemas.js";
import { newPublicId } from "../db/schema.js";
import { getForm } from "../db/queries.js";

export const submissionsRouter = Router();

// -----------------------------------------------------------------------------
// PUBLIC: POST /api/submissions — anonymous Parent submission
// -----------------------------------------------------------------------------
submissionsRouter.post("/", async (req, res, next) => {
  try {
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

    const publicId = newPublicId();
    const submission = await createSubmission(
      form_id,
      form.school_id,
      publicId,
      answers
    );

    res.status(201).json({
      public_id: submission.public_id,
      message: "Submission received. Thank you.",
    });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// PUBLIC: GET /api/submissions/:publicId — confirmation readback (thin)
// It deliberately returns only a timestamp and status, NOT answers, so
// anonymity is preserved for anyone who finds the URL.
// -----------------------------------------------------------------------------
submissionsRouter.get("/:publicId/public", async (req, res, next) => {
  try {
    const submission = await getSubmissionDetail(req.params.publicId);
    if (!submission) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    res.json({
      public_id: submission.public_id,
      status: submission.status,
      submitted_at: submission.submitted_at,
      form_name: submission.form_name,
    });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// STAFF: GET /api/submissions — list submissions scoped to their school
// -----------------------------------------------------------------------------
submissionsRouter.get("/", requireAuth, requireRoles("staff", "admin"), async (req, res, next) => {
  try {
    const isStaff = req.user!.role === "staff";
    const schoolId = isStaff ? req.user!.school_id : (req.query.school_id ? Number(req.query.school_id) : undefined);
    const formId = req.query.form_id ? Number(req.query.form_id) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    const from = req.query.from ? String(req.query.from) : undefined;
    const to = req.query.to ? String(req.query.to) : undefined;

    const submissions = await listSubmissions({ schoolId, formId, status, from, to });
    res.json(submissions);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// STAFF: GET /api/submissions/:publicId — full detail with answers + comments
// -----------------------------------------------------------------------------
submissionsRouter.get("/:publicId", requireAuth, requireRoles("staff", "admin"), async (req, res, next) => {
  try {
    const submission = await getSubmissionDetail(req.params.publicId);
    if (!submission) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    // Staff can only view submissions belonging to their own school
    if (req.user!.role === "staff") {
      const isOwner = submission.school_id === req.user!.school_id;
      if (!isOwner) {
        res.status(403).json({ error: "Forbidden: submission belongs to another school" });
        return;
      }
    }
    // Ensure comments are loaded
    const comments = await listComments(submission.id);
    res.json({ ...submission, comments });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// STAFF: PATCH /api/submissions/:publicId/status — update workflow state
// -----------------------------------------------------------------------------
submissionsRouter.patch("/:publicId/status", requireAuth, requireRoles("staff", "admin"), async (req, res, next) => {
  try {
    const parsed = updateSubmissionStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const submission = await getSubmissionDetail(req.params.publicId);
    if (!submission) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    if (req.user!.role === "staff") {
      const isOwner = submission.school_id === req.user!.school_id;
      if (!isOwner) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
    }
    await updateSubmissionStatus(submission.id, parsed.data.status);
    const updated = await getSubmissionDetail(req.params.publicId);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// STAFF: POST /api/submissions/:publicId/comments — add staff-only comment
// -----------------------------------------------------------------------------
submissionsRouter.post("/:publicId/comments", requireAuth, requireRoles("staff", "admin"), async (req, res, next) => {
  try {
    const parsed = createCommentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const submission = await getSubmissionDetail(req.params.publicId);
    if (!submission) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    if (req.user!.role === "staff") {
      const isOwner = submission.school_id === req.user!.school_id;
      if (!isOwner) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
    }
    const comment = await createComment(
      submission.id,
      req.user!.id,
      parsed.data.body,
      parsed.data.visibility
    );
    const comments = await listComments(submission.id);
    res.status(201).json({ comment, comments });
  } catch (err) {
    next(err);
  }
});
