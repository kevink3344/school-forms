import { Router } from "express";
import {
  listForms,
  getForm,
  getFormWithFields,
  createForm,
  updateForm,
  execute,
  getOrganizationBySlug,
  getViewColumnsConfig,
  setViewColumns,
  countSubmissionsForForm,
  deleteForm,
} from "../db/queries.js";
import { requireAuth, requireRoles } from "../auth.js";
import { createFormSchema, updateFormSchema } from "../schemas.js";
import { validateDriveFolder } from "../google/docs.js";

export const formsRouter = Router();

// PUBLIC: List published forms (for the anonymous parent submission page).
// Returns only published forms, with staff-only fields stripped. When an `org`
// slug is supplied, only forms owned by that org are returned (org-scoped URLs).
formsRouter.get("/public", async (req, res, next) => {
  try {
    const orgSlug = req.query.org ? String(req.query.org) : undefined;
    if (orgSlug) {
      const org = await getOrganizationBySlug(orgSlug);
      if (!org) {
        res.status(404).json({ error: "Organization not found" });
        return;
      }
    }
    const org = orgSlug ? await getOrganizationBySlug(orgSlug) : null;
    const all = await listForms(null, org?.id ?? null);
    const published = all.filter((f) => f.status === "published");
    // Safe projection of fields (strip staff_only) done below per-form
    const out = [];
    for (const form of published) {
      const full = await getFormWithFields(form.id, org?.id ?? null);
      if (!full) continue;
      out.push({
        ...full,
        fields: full.fields.filter((f) => !f.staff_only),
      });
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// PUBLIC: Get a published form with its fields (staff-only stripped).
// When an `org` slug is supplied, the form must belong to that org.
formsRouter.get("/:id/public", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const orgSlug = req.query.org ? String(req.query.org) : undefined;
    const org = orgSlug ? await getOrganizationBySlug(orgSlug) : null;
    const form = await getFormWithFields(id, org?.id ?? null);
    if (!form) {
      res.status(404).json({ error: "Form not found" });
      return;
    }
    if (form.status !== "published") {
      res.status(400).json({ error: "Form is not accepting submissions" });
      return;
    }
    // Strip staff_only fields from the parent-facing payload
    res.json({ ...form, fields: form.fields.filter((f) => !f.staff_only) });
  } catch (err) {
    next(err);
  }
});

// Admin: list forms (optionally filter by school) — scoped to the admin's org
formsRouter.get("/", requireAuth, requireRoles("staff", "cdm_contact", "admin"), async (req, res, next) => {
  try {
    const isStaff = req.user!.role !== "admin";
    // Admins may filter by school; staff (and School Contacts) see all org forms
    // (templates are org-wide and shared across schools, so school-scoping
    // would hide forms their school contributes to).
    const schoolId = !isStaff && req.query.school_id ? Number(req.query.school_id) : undefined;
    const forms = await listForms(schoolId, req.user!.organization_id);
    res.json(forms);
  } catch (err) {
    next(err);
  }
});

// Admin: get a form with its fields — org-scoped
formsRouter.get("/:id", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const form = await getFormWithFields(id, req.user!.organization_id);
    if (!form) {
      res.status(404).json({ error: "Form not found" });
      return;
    }
    res.json(form);
  } catch (err) {
    next(err);
  }
});

// Admin: create a form with fields — assigned to the admin's org
formsRouter.post("/", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const parsed = createFormSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const designerId = req.user!.id;
    const organizationId = req.user!.organization_id;
    if (!organizationId) {
      res.status(400).json({ error: "Your account is not assigned to an organization" });
      return;
    }
    const form = await createForm(
      {
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        schoolId: parsed.data.school_id ?? null,
        designerId,
        organizationId,
        docFolderId: parsed.data.doc_folder_id?.trim() ?? null,
        googleFormUrl: parsed.data.google_form_url?.trim() || null,
      },
      parsed.data.fields
    );
    res.status(201).json(form);
  } catch (err) {
    next(err);
  }
});

// Admin: update form (title/description/status/fields) — pragmatic in-place update
formsRouter.put("/:id", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    // Verify the form belongs to the admin's org before mutating.
    const existing = await getFormWithFields(id, req.user!.organization_id);
    if (!existing) {
      res.status(404).json({ error: "Form not found" });
      return;
    }
    const parsed = updateFormSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const updated = await updateForm(id, {
      title: parsed.data.title,
      description: parsed.data.description,
      status: parsed.data.status,
      fields: parsed.data.fields,
      // Only pass `doc_folder_id` when actually supplied so an omitted key can
      // never clear the stored value (nullable clear semantics in updateForm).
      ...(Object.prototype.hasOwnProperty.call(parsed.data, "doc_folder_id")
        ? { doc_folder_id: parsed.data.doc_folder_id?.trim() ?? null }
        : {}),
      // Same null-vs-absent handling for the Google Form URL.
      ...(Object.prototype.hasOwnProperty.call(parsed.data, "google_form_url")
        ? { google_form_url: parsed.data.google_form_url?.trim() || null }
        : {}),
    });
    if (!updated) {
      res.status(404).json({ error: "Form not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// Admin: validate that a supplied Google Drive Folder ID is an accessible
// folder (used by the form designer to show a green checkmark). Takes the id in
// the body so the admin can test a value before saving it to the form. Requires
// the form to belong to the admin's org.
formsRouter.post("/:id/drive-validate", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await getFormWithFields(id, req.user!.organization_id);
    if (!existing) {
      res.status(404).json({ error: "Form not found" });
      return;
    }
    const folderId = typeof req.body?.folder_id === "string" ? req.body.folder_id : null;
    const result = await validateDriveFolder(folderId?.trim() || null);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Admin: generate form fields from the linked Google Form.
//
// NOT YET IMPLEMENTED — reading a Google Form's questions requires the Google
// Forms API (`https://www.googleapis.com/auth/forms.body.readonly`), which needs
// a refresh token minted with that scope. Until that OAuth credential is
// provided, this returns 501 with an actionable message so the designer can show
// a clear "not configured yet" state instead of a generic failure.
//
// When the credential is available, replace the body with a call to
// `fetchGoogleFormFields(url)` (see docs/plans/google-form-url.md §5.3) and
// return `{ title, fields }`. The route deliberately does NOT persist — the
// client merges the fields into the editor and the admin saves.
formsRouter.post("/:id/generate-fields", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await getFormWithFields(id, req.user!.organization_id);
    if (!existing) {
      res.status(404).json({ error: "Form not found" });
      return;
    }
    const url = typeof req.body?.google_form_url === "string" ? req.body.google_form_url.trim() : "";
    if (!url) {
      res.status(400).json({ error: "A Google Form URL is required" });
      return;
    }
    res.status(501).json({
      error:
        "Automatic field generation isn't configured yet. Add the Google Forms OAuth scope " +
        "to enable it, or add the fields manually.",
      code: "GOOGLE_FORMS_NOT_CONFIGURED",
    });
  } catch (err) {
    next(err);
  }
});

// Admin: publish/unpublish a form — org-scoped
formsRouter.patch("/:id/status", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const status = req.body?.status;
    if (!["draft", "published", "archived"].includes(status)) {
      res.status(400).json({ error: "Invalid status" });
      return;
    }
    const existing = await getFormWithFields(id, req.user!.organization_id);
    if (!existing) {
      res.status(404).json({ error: "Form not found" });
      return;
    }
    await execute(
      `UPDATE dbo.forms SET status=@status, updated_at=SYSUTCDATETIME() WHERE id=@id`,
      { id, status }
    );
    res.json(await getFormWithFields(id, req.user!.organization_id));
  } catch (err) {
    next(err);
  }
});

// Admin: delete an UNUSED form (zero submissions). Refuses with 409 when the
// form has any submission history: submissions.form_id is ON DELETE CASCADE, so
// a naive delete would silently destroy every submission (and its values,
// ad-hoc fields and documents). The count is enforced here, on the
// server, and never trusted to the client. Published forms are deletable as long
// as they are unused.
formsRouter.delete("/:id", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid form id" });
      return;
    }
    // Org-scoped lookup: 404 (not 403) so we never reveal forms in other orgs.
    const existing = await getForm(id, req.user!.organization_id);
    if (!existing) {
      res.status(404).json({ error: "Form not found" });
      return;
    }
    const submissionCount = await countSubmissionsForForm(id);
    if (submissionCount > 0) {
      res.status(409).json({
        error: `This form has ${submissionCount} submission${submissionCount === 1 ? "" : "s"} and cannot be deleted.`,
        submission_count: submissionCount,
      });
      return;
    }
    await deleteForm(id, req.user!.organization_id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Admin: get a form's view-columns config (which columns the Submissions grid
// shows). This is separate from Export — Export columns are always all fields.
// Returns the full column list plus the subset of keys currently displayed.
formsRouter.get("/:id/columns", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await getFormWithFields(id, req.user!.organization_id);
    if (!existing) {
      res.status(404).json({ error: "Form not found" });
      return;
    }
    res.json(await getViewColumnsConfig(id));
  } catch (err) {
    next(err);
  }
});

// Admin: save a form's view-columns config. body.view_keys must be an array of
// `field_N` strings. We only persist the config — Export is left untouched.
formsRouter.put("/:id/columns", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await getFormWithFields(id, req.user!.organization_id);
    if (!existing) {
      res.status(404).json({ error: "Form not found" });
      return;
    }
    const viewKeys = req.body?.view_keys;
    if (!Array.isArray(viewKeys) || viewKeys.some((k) => typeof k !== "string" || !/^field_\d+$/.test(k))) {
      res.status(400).json({ error: "view_keys must be an array of field_N strings" });
      return;
    }
    await setViewColumns(id, viewKeys);
    res.json(await getViewColumnsConfig(id));
  } catch (err) {
    next(err);
  }
});
