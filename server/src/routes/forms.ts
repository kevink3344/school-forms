import { Router } from "express";
import {
  listForms,
  getFormWithFields,
  createForm,
  updateForm,
  execute,
} from "../db/queries.js";
import { requireAuth, requireRoles } from "../auth.js";
import { createFormSchema, updateFormSchema } from "../schemas.js";

export const formsRouter = Router();

// PUBLIC: List published forms (for the anonymous parent submission page).
// Returns only published forms, with staff-only fields stripped.
formsRouter.get("/public", async (req, res, next) => {
  try {
    const all = await listForms();
    const published = all.filter((f) => f.status === "published");
    // Safe projection of fields (strip staff_only) done below per-form
    const out = [];
    for (const form of published) {
      const full = await getFormWithFields(form.id);
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
formsRouter.get("/:id/public", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const form = await getFormWithFields(id);
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

// Admin: list forms (optionally filter by school)
formsRouter.get("/", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const schoolId = req.query.school_id ? Number(req.query.school_id) : undefined;
    const forms = await listForms(schoolId);
    res.json(forms);
  } catch (err) {
    next(err);
  }
});

// Admin: get a form with its fields
formsRouter.get("/:id", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const form = await getFormWithFields(id);
    if (!form) {
      res.status(404).json({ error: "Form not found" });
      return;
    }
    res.json(form);
  } catch (err) {
    next(err);
  }
});

// Admin: create a form with fields
formsRouter.post("/", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const parsed = createFormSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const designerId = req.user!.id;
    const form = await createForm(
      {
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        schoolId: parsed.data.school_id ?? null,
        designerId,
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

// Admin: publish/unpublish a form
formsRouter.patch("/:id/status", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const status = req.body?.status;
    if (!["draft", "published", "archived"].includes(status)) {
      res.status(400).json({ error: "Invalid status" });
      return;
    }
    await execute(
      `UPDATE dbo.forms SET status=@status, updated_at=SYSUTCDATETIME() WHERE id=@id`,
      { id, status }
    );
    res.json(await getFormWithFields(id));
  } catch (err) {
    next(err);
  }
});
