import { Router } from "express";
import {
  listForms,
  getFormWithFields,
  createForm,
  updateForm,
  execute,
  getOrganizationBySlug,
} from "../db/queries.js";
import { requireAuth, requireRoles } from "../auth.js";
import { createFormSchema, updateFormSchema } from "../schemas.js";

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
formsRouter.get("/", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const schoolId = req.query.school_id ? Number(req.query.school_id) : undefined;
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
