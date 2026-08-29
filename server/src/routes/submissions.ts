import { Router } from "express";
import {
  createSubmission,
  getSubmissionDetail,
  listSubmissions,
  listSubmissionValues,
  listComments,
  updateSubmissionStatus,
  updateSubmissionValues,
  createComment,
  createAdhocField,
  updateAdhocField,
  deleteAdhocField,
  listAdhocFields,
  getForm,
  getOrganizationBySlug,
} from "../db/queries.js";
import { requireAuth, requireRoles } from "../auth.js";
import { maybeGenerateDocument } from "../google/docs.js";
import {
  createSubmissionSchema,
  updateSubmissionStatusSchema,
  updateSubmissionValuesSchema,
  createCommentSchema,
  createAdhocFieldSchema,
  updateAdhocFieldSchema,
} from "../schemas.js";

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

    // Org-slug optional query param — when present, the form must belong to that
    // org (used by the org-scoped public /org/:slug/submission routes).
    const orgSlug = req.query.org ? String(req.query.org) : undefined;
    const org = orgSlug ? await getOrganizationBySlug(orgSlug) : null;

    const form = await getForm(form_id, org?.id ?? null);
    if (!form) {
      res.status(404).json({ error: "Form not found" });
      return;
    }
    if (form.status !== "published") {
      res.status(400).json({ error: "Form is not accepting submissions" });
      return;
    }

    const submission = await createSubmission(form, answers);

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
    const orgSlug = req.query.org ? String(req.query.org) : undefined;
    const org = orgSlug ? await getOrganizationBySlug(orgSlug) : null;
    const submission = await getSubmissionDetail(req.params.publicId, org?.id ?? null);
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
    const organizationId = req.user!.organization_id;
    const schoolId = isStaff ? req.user!.school_id : (req.query.school_id ? Number(req.query.school_id) : undefined);
    const formId = req.query.form_id ? Number(req.query.form_id) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    const from = req.query.from ? String(req.query.from) : undefined;
    const to = req.query.to ? String(req.query.to) : undefined;

    const submissions = await listSubmissions({ organizationId, schoolId, formId, status, from, to });
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
    const submission = await getSubmissionDetail(req.params.publicId, req.user!.organization_id);
    if (!submission) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    // Staff can only view submissions belonging to their own school within their org
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
    const submission = await getSubmissionDetail(req.params.publicId, req.user!.organization_id);
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
    const updated = await getSubmissionDetail(req.params.publicId, req.user!.organization_id);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// STAFF: PUT /api/submissions/:publicId/values — edit submission answers
// (staff/admin correcting parent input across all fields, incl. staff-only)
// -----------------------------------------------------------------------------
submissionsRouter.put("/:publicId/values", requireAuth, requireRoles("staff", "admin"), async (req, res, next) => {
  try {
    const parsed = updateSubmissionValuesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const submission = await getSubmissionDetail(req.params.publicId, req.user!.organization_id);
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
    await updateSubmissionValues(submission.id, parsed.data.answers, {
      staffOnly: parsed.data.staff_only === true,
      updaterId: req.user!.id,
    });
    // Staff-only save: if the "Generate document" checkbox was ticked, fire the
    // Google Doc generation (idempotent, fire-and-forget — never blocks the 200).
    if (parsed.data.staff_only === true) {
      await maybeGenerateDocument(submission.id, req.user!.id, parsed.data.answers);
    }
    const updated = await getSubmissionDetail(req.params.publicId, req.user!.organization_id);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// STAFF: GET /api/submissions/:publicId/documents — list document rows for a
// submission (used by the detail card). Reuses the staff school ownership check.
// -----------------------------------------------------------------------------
submissionsRouter.get("/:publicId/documents", requireAuth, requireRoles("staff", "admin"), async (req, res, next) => {
  try {
    const submission = await getSubmissionDetail(req.params.publicId, req.user!.organization_id);
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
    const documents = submission.documents;
    res.json(documents);
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
    const submission = await getSubmissionDetail(req.params.publicId, req.user!.organization_id);
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

// -----------------------------------------------------------------------------
// STAFF: GET /api/submissions/:publicId/adhoc — list staff-only ad-hoc fields
// -----------------------------------------------------------------------------
submissionsRouter.get("/:publicId/adhoc", requireAuth, requireRoles("staff", "admin"), async (req, res, next) => {
  try {
    const submission = await getSubmissionDetail(req.params.publicId, req.user!.organization_id);
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
    const fields = await listAdhocFields(submission.id);
    res.json(fields);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// STAFF: POST /api/submissions/:publicId/adhoc — add a staff-only ad-hoc field
// -----------------------------------------------------------------------------
submissionsRouter.post("/:publicId/adhoc", requireAuth, requireRoles("staff", "admin"), async (req, res, next) => {
  try {
    const parsed = createAdhocFieldSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const submission = await getSubmissionDetail(req.params.publicId, req.user!.organization_id);
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
    const existing = await listAdhocFields(submission.id);
    const nextSort = existing.length ? Math.max(...existing.map((f) => f.sort_order)) + 1 : 0;
    const field = await createAdhocField({
      submissionId: submission.id,
      label: parsed.data.label,
      type: parsed.data.type,
      options: parsed.data.options ?? null,
      value: parsed.data.value ?? null,
      sortOrder: nextSort,
      createdBy: req.user!.id,
    });
    res.status(201).json(field);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// STAFF: PUT /api/submissions/:publicId/adhoc/:fieldId — update an ad-hoc field
// -----------------------------------------------------------------------------
submissionsRouter.put("/:publicId/adhoc/:fieldId", requireAuth, requireRoles("staff", "admin"), async (req, res, next) => {
  try {
    const parsed = updateAdhocFieldSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const submission = await getSubmissionDetail(req.params.publicId, req.user!.organization_id);
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
    const fieldId = Number(req.params.fieldId);
    const current = (await listAdhocFields(submission.id)).find((f) => f.id === fieldId);
    if (!current) {
      res.status(404).json({ error: "Ad-hoc field not found on this submission" });
      return;
    }
    const updated = await updateAdhocField(fieldId, {
      label: parsed.data.label,
      type: parsed.data.type,
      options: parsed.data.options ?? null,
      value: parsed.data.value ?? null,
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// STAFF: DELETE /api/submissions/:publicId/adhoc/:fieldId — remove an ad-hoc field
// -----------------------------------------------------------------------------
submissionsRouter.delete("/:publicId/adhoc/:fieldId", requireAuth, requireRoles("staff", "admin"), async (req, res, next) => {
  try {
    const submission = await getSubmissionDetail(req.params.publicId, req.user!.organization_id);
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
    const fieldId = Number(req.params.fieldId);
    const current = (await listAdhocFields(submission.id)).find((f) => f.id === fieldId);
    if (!current) {
      res.status(404).json({ error: "Ad-hoc field not found on this submission" });
      return;
    }
    await deleteAdhocField(fieldId);
    const fields = await listAdhocFields(submission.id);
    res.json(fields);
  } catch (err) {
    next(err);
  }
});
