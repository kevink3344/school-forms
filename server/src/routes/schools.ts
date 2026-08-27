import { Router } from "express";
import { createSchool, listSchools } from "../db/queries.js";
import { requireAuth, requireRoles } from "../auth.js";
import { createSchoolSchema } from "../schemas.js";

export const schoolsRouter = Router();

// Public: list schools for registration picker
schoolsRouter.get("/", async (_req, res, next) => {
  try {
    const schools = await listSchools();
    res.json(schools);
  } catch (err) {
    next(err);
  }
});

// Admin: create a school
schoolsRouter.post("/", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const parsed = createSchoolSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const school = await createSchool(parsed.data.name, parsed.data.district ?? null);
    res.status(201).json(school);
  } catch (err) {
    next(err);
  }
});
