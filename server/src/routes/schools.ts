import { Router } from "express";
import {
  createSchool,
  featureToSchool,
  listSchools,
  listSchoolsPage,
  upsertSchoolFromSource,
} from "../db/queries.js";
import { requireAuth, requireRoles } from "../auth.js";
import { createSchoolSchema } from "../schemas.js";
import { env } from "../config/env.js";

export const schoolsRouter = Router();

// Max page size — also what the admin UI requests.
const MAX_PAGE_SIZE = 50;

// Authenticated: list schools, scoped for non-admins.
//  - admin  → full list
//  - staff  → only their own school (users.school_id)
schoolsRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const schools =
      req.user!.role === "admin"
        ? await listSchools()
        : await listSchools(req.user!.school_id);
    res.json(schools);
  } catch (err) {
    next(err);
  }
});

// Admin: the table columns to render (from SCHOOL_TABLE_COLUMNS).
schoolsRouter.get("/columns", requireAuth, requireRoles("admin"), (_req, res) => {
  res.json({ columns: env.schoolImport.columns });
});

// Admin: paginated school listing (pageSize capped at 50).
schoolsRouter.get("/page", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.pageSize) || MAX_PAGE_SIZE));
    const result = await listSchoolsPage({ page, pageSize });
    const totalPages = result.total === 0 ? 0 : Math.ceil(result.total / pageSize);
    res.json({ ...result, page, pageSize, totalPages });
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

// Admin: manual import from the SCHOOL_JSON GeoJSON feed.
// Upserts by stable source_id (FID); never deletes. Returns the ingested count.
schoolsRouter.post("/import", requireAuth, requireRoles("admin"), async (_req, res, next) => {
  try {
    const url = env.schoolImport.url;
    if (!url) {
      res.status(400).json({ error: "SCHOOL_JSON is not configured" });
      return;
    }
    const response = await fetch(url);
    if (!response.ok) {
      res.status(502).json({ error: `Failed to fetch SCHOOL_JSON: ${response.status}` });
      return;
    }
    const data = (await response.json()) as Record<string, unknown>;
    const features = Array.isArray(data?.features) ? (data.features as Record<string, unknown>[]) : [];
    const columns = env.schoolImport.columns;
    let imported = 0;
    for (const feature of features) {
      const school = featureToSchool(feature, columns);
      if (!school.sourceId) continue;
      await upsertSchoolFromSource(school);
      imported++;
    }
    res.json({ total: imported });
  } catch (err) {
    next(err);
  }
});
