import { Router, type Request } from "express";
import {
  createSubmission,
  getSubmissionDetail,
  listSubmissions,
  listSubmissionValues,
  updateSubmissionStatus,
  updateSubmissionValues,
  archiveSubmission,
  restoreSubmission,
  deleteSubmission,
  submissionArchiveCounts,
  createAdhocField,
  updateAdhocField,
  deleteAdhocField,
  listAdhocFields,
  promoteAdhocFieldToFormField,
  getForm,
  getOrganizationBySlug,
} from "../db/queries.js";
import { requireAuth, requireRoles, canAccessSchool, scopedSchoolId } from "../auth.js";
import { canAccessForm } from "../access/formAccess.js";
import { maybeGenerateDocument } from "../google/docs.js";
import { sendSlackAlert } from "../notify/slack.js";
import {
  createSubmissionSchema,
  updateSubmissionStatusSchema,
  updateSubmissionValuesSchema,
  createAdhocFieldSchema,
  updateAdhocFieldSchema,
  promoteAdhocFieldSchema,
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

    // Admin Slack alert (not parents) — fire-and-forget, never blocks the 201.
    const schoolName = submission.school_name ?? "—";
    const studentName = submission.student_name ?? form.title;
    await sendSlackAlert(
      `📥 New submission to *${form.title}*`,
      [
        { title: "Form", value: form.title, short: true },
        { title: "Submitted ID", value: submission.public_id, short: true },
        { title: "School", value: schoolName, short: true },
        { title: "Student", value: studentName, short: true },
      ],
      { fallback: `New submission ${submission.public_id} to ${form.title}` }
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
    const orgSlug = req.query.org ? String(req.query.org) : undefined;
    const org = orgSlug ? await getOrganizationBySlug(orgSlug) : null;
    const submission = await getSubmissionDetail(req.params.publicId, org?.id ?? null, "parent");
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
// The two access guards every row-level route applies, in one place.
//
// ★ They MUST stay together and in this order. `canAccessSchool` is the school
// rule (a School Contact sees only their own school); `canAccessForm` is the
// private-form rule (docs/plans/public-private-forms.md §7.2). Writing them out
// at each of the ten call sites is how one of them eventually gets forgotten on
// a new route — and the failure is silent, because a missing guard looks exactly
// like a route nobody has called yet.
//
// Returns the 403 body to send, or null when the caller may proceed.
// -----------------------------------------------------------------------------
async function submissionAccessError(
  req: Request,
  submission: { school_id: number | null; form_id: number }
): Promise<{ status: number; error: string } | null> {
  if (!canAccessSchool(req.user!, submission.school_id)) {
    return { status: 403, error: "Forbidden: submission belongs to another school" };
  }
  if (!(await canAccessForm(req.user!, submission.form_id))) {
    return { status: 403, error: "Forbidden: no access to this form" };
  }
  return null;
}

// -----------------------------------------------------------------------------
// Shared filter reading for the submission list AND its archive counts.
//
// ONE reader for both. The counts badge ("N archived hidden") is only meaningful
// if it was computed from the exact filter the grid was handed, so a second,
// hand-written parameter list here is precisely how the badge starts describing a
// different query than the rows underneath it.
// -----------------------------------------------------------------------------
function submissionFiltersFrom(req: Request) {
  // Every caller is org-scoped. A School Contact is narrowed further to their
  // own school; admin and staff may narrow with an optional ?school_id filter.
  return {
    organizationId: req.user!.organization_id,
    schoolId:
      scopedSchoolId(req.user!) ??
      (req.query.school_id ? Number(req.query.school_id) : undefined),
    formId: req.query.form_id ? Number(req.query.form_id) : undefined,
    status: req.query.status ? String(req.query.status) : undefined,
    from: req.query.from ? String(req.query.from) : undefined,
    to: req.query.to ? String(req.query.to) : undefined,
    // ★ The viewer travels WITH the filter, so the list and the archive counts
    // narrow together — see the note on SubmissionListFilters.
    viewer: req.user!,
  };
}

// -----------------------------------------------------------------------------
// STAFF: GET /api/submissions — list submissions scoped to their school
// -----------------------------------------------------------------------------
submissionsRouter.get("/", requireAuth, requireRoles("staff", "cdm_contact", "admin"), async (req, res, next) => {
  try {
    // Archive visibility, and the ONE place the grid's flag is read:
    //   omitted / 0  → the normal view; archived rows are HIDDEN
    //   1 / true     → the Archive view; ONLY archived rows
    // There is no "both" mode on purpose. A merged list cannot answer "which of
    // these is put away?", so the reader could not tell an archived row from an
    // active one — and every count, export and action downstream would have to
    // carry that doubt. Two lists, one at a time, keeps the question answerable.
    //
    // Accepts "true" as well as "1" because the client builds this from a
    // boolean, and `String(true)` is "true" — a URL that says ?archived=true and
    // silently returns the unarchived list would be a lie the type system cannot
    // see through.
    const archived = req.query.archived === "1" || req.query.archived === "true";
    const submissions = await listSubmissions({ ...submissionFiltersFrom(req), archived });
    res.json(submissions);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// STAFF: GET /api/submissions/archive/counts — how many rows the CURRENT filter
// puts on each side of the archive line ({ active, archived }).
//
// Exists so the UI can say what it is hiding. Without it, a filtered grid with
// the Archive toggle off looks identical whether four of its rows were archived
// or four never matched — the two only differ by a number the client cannot
// compute from a list it never received.
//
// Registered at a two-segment path so it can never be captured by the
// single-segment `GET /:publicId` below, whatever order these are wired in.
// -----------------------------------------------------------------------------
submissionsRouter.get("/archive/counts", requireAuth, requireRoles("staff", "cdm_contact", "admin"), async (req, res, next) => {
  try {
    res.json(await submissionArchiveCounts(submissionFiltersFrom(req)));
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// STAFF: GET /api/submissions/:publicId — full detail with answers + fields
// -----------------------------------------------------------------------------
submissionsRouter.get("/:publicId", requireAuth, requireRoles("staff", "cdm_contact", "admin"), async (req, res, next) => {
  try {
    const submission = await getSubmissionDetail(req.params.publicId, req.user!.organization_id, req.user!.role);
    if (!submission) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    // A School Contact may only view submissions belonging to their own school,
    // and nobody may read a row on a private form they hold no grant for.
    const denied = await submissionAccessError(req, submission);
    if (denied) {
      res.status(denied.status).json({ error: denied.error });
      return;
    }
    res.json(submission);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// STAFF: PATCH /api/submissions/:publicId/status — update workflow state
// -----------------------------------------------------------------------------
submissionsRouter.patch("/:publicId/status", requireAuth, requireRoles("staff", "cdm_contact", "admin"), async (req, res, next) => {
  try {
    const parsed = updateSubmissionStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const submission = await getSubmissionDetail(req.params.publicId, req.user!.organization_id, req.user!.role);
    if (!submission) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    const denied = await submissionAccessError(req, submission);
    if (denied) {
      res.status(denied.status).json({ error: denied.error });
      return;
    }
    await updateSubmissionStatus(submission.id, parsed.data.status);
    const updated = await getSubmissionDetail(req.params.publicId, req.user!.organization_id, req.user!.role);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// STAFF: POST /api/submissions/:publicId/archive — hide a submission from every
// view (lists, counts, exports, reports, document lists) without deleting it.
//
// Staff and school contacts, not admin-only — matching the rest of this router.
// The row is resolved by public id (org-scoped) and then gated on the actor's
// school, so the reach of this endpoint is the actor's own schools either way;
// making it admin-only only decided *who inside a school* could do it, and left
// the staff member who is actually looking at the queue unable to put anything
// away. DELETE below is the one that stays admin-only, because it is the one that
// cannot be undone.
//
// Reversible and non-destructive: every answer, staff-only field, ad-hoc field and
// generated document stays exactly where it was, which is what makes Restore a
// single column update rather than a rebuild. The app's one destructive path for a
// submission is `DELETE /:publicId` below, and it can only be reached once this
// one has already been applied.
//
// 409 when the row is already archived rather than a silent 200: the action has
// a visible effect (the button becomes "Restore"), so "nothing changed" must be
// distinguishable from "it changed and you are seeing a stale page". The guard
// lives in the UPDATE's WHERE clause (`archived_at IS NULL`), so two concurrent
// clicks cannot both report success.
// -----------------------------------------------------------------------------
submissionsRouter.post("/:publicId/archive", requireAuth, requireRoles("staff", "cdm_contact", "admin"), async (req, res, next) => {
  try {
    const submission = await getSubmissionDetail(req.params.publicId, req.user!.organization_id, req.user!.role);
    if (!submission) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    const denied = await submissionAccessError(req, submission);
    if (denied) {
      res.status(denied.status).json({ error: denied.error });
      return;
    }
    const changed = await archiveSubmission(submission.id, req.user!.id);
    if (!changed) {
      res.status(409).json({ error: "This submission is already archived." });
      return;
    }
    // Re-read and return the detail so the client renders the banner and the
    // Restore button from the server's own state rather than from its guess about
    // what the POST did.
    const updated = await getSubmissionDetail(req.params.publicId, req.user!.organization_id, req.user!.role);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// STAFF: POST /api/submissions/:publicId/restore — return a submission to every
// view.
//
// Same guards as the archive above, and for the same reason: the action is only
// half a feature if whoever put something away cannot get it back. Workflow
// status is untouched by both directions, so restoring lands on the status the
// submission held when it was archived. That is the property the separate
// `archived_at` column buys over a `status = 'archived'` value: there is no
// remembered status to get out of step with the row.
// -----------------------------------------------------------------------------
submissionsRouter.post("/:publicId/restore", requireAuth, requireRoles("staff", "cdm_contact", "admin"), async (req, res, next) => {
  try {
    const submission = await getSubmissionDetail(req.params.publicId, req.user!.organization_id, req.user!.role);
    if (!submission) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    const denied = await submissionAccessError(req, submission);
    if (denied) {
      res.status(denied.status).json({ error: denied.error });
      return;
    }
    const changed = await restoreSubmission(submission.id);
    if (!changed) {
      res.status(409).json({ error: "This submission is not archived." });
      return;
    }
    const updated = await getSubmissionDetail(req.params.publicId, req.user!.organization_id, req.user!.role);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// ADMIN: DELETE /api/submissions/:publicId — delete an ARCHIVED submission for
// good, with its answers, ad-hoc fields and document rows.
//
// THE ORDER IS THE DESIGN: archive first, then delete. Every control in the app
// therefore asks the reader to make the reversible move before it offers the
// irreversible one, and the extra step is where a second look is cheap. The rule
// is enforced in `deleteSubmission`'s own WHERE clause (`archived_at IS NOT
// NULL`), not by a check here — see that function for why the predicate has to
// live in the statement.
//
// 409, not 403, for a row that is not archived. The actor IS allowed to delete
// archived submissions here; what is wrong is the row's state, and a 403 would
// tell an admin to go and get a permission they already have. It also matches
// what archive/restore answer for a no-op, so "the row was not in the state this
// action needs" reads the same in all three endpoints.
//
// 204 with no body: there is no row left to return, and the client's next move is
// to refresh the list it came from. Returning the old detail would be a body
// describing something that no longer exists.
//
// Admin-only, unlike archive/restore. Deleting destroys the submission's answers
// and its links to any generated document, and unlike archiving that cannot be
// walked back — so it is the one submission action that stays administrative.
//
// ONE KNOWN, DELIBERATELY UNCLOSED WINDOW: a fire-and-forget document generation
// (see `maybeGenerateDocument` in google/docs.ts) can be in flight while this
// runs. If its `documents` INSERT lands between `deleteSubmission`'s child removes
// and its parent remove, the new child re-blocks the parent and this answers 500
// rather than 204 — retrying succeeds and leaves nothing behind. Closing it would
// need ON DELETE CASCADE on the live child keys (a schema change on a database
// this app did not create) or a cross-instance lock (there is none; an in-process
// guard serializes nothing under App Service scale-out and would be a false
// guarantee). The full description is on the Swagger path for this route.
// -----------------------------------------------------------------------------
submissionsRouter.delete("/:publicId", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    // Resolve first so an unknown id is 404 and another school's id is 403. Without
    // this the delete's own WHERE would answer 409 for a submission the actor
    // cannot even see, which reads as "archive it first" and would be advice about
    // someone else's data.
    const submission = await getSubmissionDetail(req.params.publicId, req.user!.organization_id, req.user!.role);
    if (!submission) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    const denied = await submissionAccessError(req, submission);
    if (denied) {
      res.status(denied.status).json({ error: denied.error });
      return;
    }
    const deleted = await deleteSubmission(submission.id);
    if (!deleted) {
      res.status(409).json({ error: "This submission must be archived before it can be deleted." });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// STAFF: PUT /api/submissions/:publicId/values — edit submission answers
// (staff/admin correcting parent input across all fields, incl. staff-only)
// -----------------------------------------------------------------------------
submissionsRouter.put("/:publicId/values", requireAuth, requireRoles("staff", "cdm_contact", "admin"), async (req, res, next) => {
  try {
    const parsed = updateSubmissionValuesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const submission = await getSubmissionDetail(req.params.publicId, req.user!.organization_id, req.user!.role);
    if (!submission) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    const denied = await submissionAccessError(req, submission);
    if (denied) {
      res.status(denied.status).json({ error: denied.error });
      return;
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
    const updated = await getSubmissionDetail(req.params.publicId, req.user!.organization_id, req.user!.role);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// STAFF: GET /api/submissions/:publicId/documents — list document rows for a
// submission (used by the detail card). Reuses the staff school ownership check.
// -----------------------------------------------------------------------------
submissionsRouter.get("/:publicId/documents", requireAuth, requireRoles("staff", "cdm_contact", "admin"), async (req, res, next) => {
  try {
    const submission = await getSubmissionDetail(req.params.publicId, req.user!.organization_id, req.user!.role);
    if (!submission) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    const denied = await submissionAccessError(req, submission);
    if (denied) {
      res.status(denied.status).json({ error: denied.error });
      return;
    }
    const documents = submission.documents;
    res.json(documents);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// STAFF: GET /api/submissions/:publicId/adhoc — list staff-only ad-hoc fields
// -----------------------------------------------------------------------------
submissionsRouter.get("/:publicId/adhoc", requireAuth, requireRoles("staff", "cdm_contact", "admin"), async (req, res, next) => {
  try {
    const submission = await getSubmissionDetail(req.params.publicId, req.user!.organization_id, req.user!.role);
    if (!submission) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    const denied = await submissionAccessError(req, submission);
    if (denied) {
      res.status(denied.status).json({ error: denied.error });
      return;
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
submissionsRouter.post("/:publicId/adhoc", requireAuth, requireRoles("staff", "cdm_contact", "admin"), async (req, res, next) => {
  try {
    const parsed = createAdhocFieldSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const submission = await getSubmissionDetail(req.params.publicId, req.user!.organization_id, req.user!.role);
    if (!submission) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    const denied = await submissionAccessError(req, submission);
    if (denied) {
      res.status(denied.status).json({ error: denied.error });
      return;
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
submissionsRouter.put("/:publicId/adhoc/:fieldId", requireAuth, requireRoles("staff", "cdm_contact", "admin"), async (req, res, next) => {
  try {
    const parsed = updateAdhocFieldSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const submission = await getSubmissionDetail(req.params.publicId, req.user!.organization_id, req.user!.role);
    if (!submission) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    const denied = await submissionAccessError(req, submission);
    if (denied) {
      res.status(denied.status).json({ error: denied.error });
      return;
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
submissionsRouter.delete("/:publicId/adhoc/:fieldId", requireAuth, requireRoles("staff", "cdm_contact", "admin"), async (req, res, next) => {
  try {
    const submission = await getSubmissionDetail(req.params.publicId, req.user!.organization_id, req.user!.role);
    if (!submission) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    const denied = await submissionAccessError(req, submission);
    if (denied) {
      res.status(denied.status).json({ error: denied.error });
      return;
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

// -----------------------------------------------------------------------------
// ADMIN: POST /api/submissions/:publicId/adhoc/:fieldId/promote
// Make a captured question a real form field
// (docs/plans/google-form-undefined-fields.md §11 — the escalation path)
//
// ★ ADMIN-only, deliberately, and it is not an oversight about who does the work:
// this writes to `form_fields`, the form's DEFINITION, and every other route that
// touches it is admin-only (`PUT /api/forms/:id`). Letting a queue worker promote
// would hand them form-design rights one field at a time. It also rewrites OTHER
// people's submissions, which is an admin-scale action however convenient it is
// from the detail page.
//
// Responds with the new field, how many submissions were migrated, and the
// re-read submission — so the page can re-render without a second round trip,
// and can say "promoted, 3 submissions migrated" rather than "done".
// -----------------------------------------------------------------------------
submissionsRouter.post(
  "/:publicId/adhoc/:fieldId/promote",
  requireAuth,
  requireRoles("admin"),
  async (req, res, next) => {
    try {
      // The empty body is the normal case, so an absent body is a valid request
      // rather than a validation failure.
      const parsed = promoteAdhocFieldSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
        return;
      }
      const submission = await getSubmissionDetail(
        req.params.publicId,
        req.user!.organization_id,
        req.user!.role
      );
      if (!submission) {
        res.status(404).json({ error: "Submission not found" });
        return;
      }
      const denied = await submissionAccessError(req, submission);
      if (denied) {
        res.status(denied.status).json({ error: denied.error });
        return;
      }
      const fieldId = Number(req.params.fieldId);
      const current = (await listAdhocFields(submission.id)).find((f) => f.id === fieldId);
      if (!current) {
        res.status(404).json({ error: "Ad-hoc field not found on this submission" });
        return;
      }

      const { field, migrated } = await promoteAdhocFieldToFormField({
        submissionId: submission.id,
        formId: submission.form_id,
        adhocFieldId: fieldId,
        type: parsed.data.type,
        options: parsed.data.options ?? null,
        required: parsed.data.required,
        staffOnly: parsed.data.staff_only,
        backfill: parsed.data.backfill,
      });

      // Re-read rather than patching the copy in hand: the promoted answer has
      // moved from `adhocFields` into `values`, which is two changes to two
      // arrays, and guessing at them is how the page ends up disagreeing with
      // the database.
      const updated = await getSubmissionDetail(
        req.params.publicId,
        req.user!.organization_id,
        req.user!.role
      );

      res.json({ field, migrated_submissions: migrated, submission: updated });
    } catch (err) {
      next(err);
    }
  }
);
