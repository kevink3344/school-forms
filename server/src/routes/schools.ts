import { Router } from "express";
import {
  createSchool,
  featureToSchool,
  getSchoolByName,
  getSchoolFacets,
  listSchools,
  listSchoolsPage,
  updateSchool,
  upsertSchoolFromSource,
} from "../db/queries.js";
import { requireAuth, requireRoles, scopedSchoolId } from "../auth.js";
import { createSchoolSchema, updateSchoolSchema } from "../schemas.js";
import type { School } from "../db/schema.js";
import { env } from "../config/env.js";

export const schoolsRouter = Router();

// Max page size — also what the admin UI requests.
const MAX_PAGE_SIZE = 50;

// A duplicate `name` is refused by the unique index UX_schools_name, not by the
// application. Both drivers report that differently — SQL Server as error
// number 2601/2627, libSQL as SQLITE_CONSTRAINT — so match either shape and let
// the route answer 409. Without this the global error handler would turn a
// duplicate into a 500 that leaks the driver's message.
//
// The error NUMBER does not identify WHICH index refused the row: 2601 is raised
// by every unique index on the table, and UX_schools_source_id raises it too, for
// a reason that has nothing to do with the name. Treating that as a name clash made
// the route answer `409 A school named "Riverside High" already exists` to an admin
// who had just typed that name for the first time — naming a duplicate that did not
// exist and sending them looking for a row nobody created. The source_id index is
// now correctly filtered (see the DDL ladder), so that particular collision is
// unreachable; the exclusion stays anyway, so that if it ever becomes reachable
// again it surfaces as what it is instead of as a phantom duplicate. Both dialects
// are covered: SQL Server names the index, libSQL names the column.
function isDuplicateName(err: unknown): boolean {
  const e = err as { number?: number; code?: string; message?: string } | null;
  const message = e?.message ?? "";
  if (/UX_schools_source_id|schools\.source_id/i.test(message)) return false;
  if (e?.number === 2601 || e?.number === 2627) return true;
  return /SQLITE_CONSTRAINT|UNIQUE constraint failed|duplicate key/i.test(message);
}

// Authenticated: list schools. Only a school-scoped role is narrowed to its own
// school; admin and staff see the full shared list.
//  - admin / staff  → full list
//  - School Contact → their own school (users.school_id)
schoolsRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const schools = await listSchools(scopedSchoolId(req.user!));
    res.json(schools);
  } catch (err) {
    next(err);
  }
});

// Admin: the table columns to render (from SCHOOL_TABLE_COLUMNS).
schoolsRouter.get("/columns", requireAuth, requireRoles("admin"), (_req, res) => {
  res.json({ columns: env.schoolImport.columns });
});

// Admin: paginated school listing (pageSize capped at 50), with optional
// filter query params: search (name/district), gradeLevel, calendar.
schoolsRouter.get("/page", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.pageSize) || MAX_PAGE_SIZE));
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const gradeLevel = typeof req.query.gradeLevel === "string" ? req.query.gradeLevel : "";
    const calendar = typeof req.query.calendar === "string" ? req.query.calendar : "";
    const result = await listSchoolsPage({ page, pageSize, search, gradeLevel, calendar });
    const totalPages = result.total === 0 ? 0 : Math.ceil(result.total / pageSize);
    res.json({ ...result, page, pageSize, totalPages });
  } catch (err) {
    next(err);
  }
});

// Admin: distinct grade-level/calendar values for the filter dropdowns.
schoolsRouter.get("/facets", requireAuth, requireRoles("admin"), async (_req, res, next) => {
  try {
    const facets = await getSchoolFacets();
    res.json(facets);
  } catch (err) {
    next(err);
  }
});

// Admin: create a school by hand.
//
// The name is the key a submission's typed answer is matched against, so it must
// be spelled exactly as the form spells it. Duplicates are refused before the
// insert so the caller gets a readable 409 rather than a unique-index 500; the
// catch below is the backstop for a race between that check and the insert.
//
// A manually added school gets source_id = NULL, which is what keeps the feed
// import from ever matching it (upsertSchoolFromSource keys on source_id).
schoolsRouter.post("/", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const parsed = createSchoolSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    // `min(1)` passes a whitespace-only name, so trim before trusting it.
    const name = parsed.data.name.trim();
    if (!name) {
      res.status(400).json({ error: "Name cannot be blank" });
      return;
    }

    const clash = await getSchoolByName(name);
    if (clash) {
      res.status(409).json({ error: `A school named "${clash.name}" already exists` });
      return;
    }

    let school: School | null = null;
    let duplicate = false;
    try {
      school = await createSchool(
        name,
        parsed.data.district?.trim() || null,
        parsed.data.grade_level?.trim() || null,
        parsed.data.calendar?.trim() || null
      );
    } catch (err) {
      // Only the unique-index violation is swallowed here; anything else is a
      // real failure and belongs in the global handler.
      if (!isDuplicateName(err)) throw err;
      duplicate = true;
    }
    if (duplicate) {
      res.status(409).json({ error: `A school named "${name}" already exists` });
      return;
    }
    if (!school) {
      res.status(500).json({ error: "Could not create the school" });
      return;
    }
    res.status(201).json(school);
  } catch (err) {
    next(err);
  }
});

// Admin: update a school (name / grade level / calendar / district).
// Partial: an omitted key leaves that column alone, so the drawer can save one
// field without blanking the others. 404 if the id does not exist.
//
// ★ A rename changes what NEW submissions resolve to, not the ones already
// stored: submissions.school_id is computed once at insert and never re-run. Use
// the backfill script to repair rows that were stored against the old name.
schoolsRouter.patch("/:id", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid school id" });
      return;
    }
    const parsed = updateSchoolSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }

    const patch: {
      name?: string;
      grade_level?: string | null;
      calendar?: string | null;
      district?: string | null;
    } = { ...parsed.data };

    if (patch.name !== undefined) {
      patch.name = patch.name.trim();
      if (!patch.name) {
        res.status(400).json({ error: "Name cannot be blank" });
        return;
      }
      // The unique index is case-insensitive, so a school cannot be renamed onto
      // its own current spelling by accident — but it also cannot be renamed to
      // another school's name. id is compared as a Number because the driver
      // hands numeric columns back as strings.
      const clash = await getSchoolByName(patch.name);
      if (clash && Number(clash.id) !== id) {
        res.status(409).json({ error: `A school named "${clash.name}" already exists` });
        return;
      }
    }
    // Blank text fields clear the column rather than storing an empty string, so
    // "not set" has one representation in the table.
    if (typeof patch.grade_level === "string") patch.grade_level = patch.grade_level.trim() || null;
    if (typeof patch.calendar === "string") patch.calendar = patch.calendar.trim() || null;
    if (typeof patch.district === "string") patch.district = patch.district.trim() || null;

    let school: School | null = null;
    let duplicate = false;
    try {
      school = await updateSchool(id, patch);
    } catch (err) {
      if (!isDuplicateName(err)) throw err;
      duplicate = true;
    }
    if (duplicate) {
      res.status(409).json({ error: `A school named "${patch.name}" already exists` });
      return;
    }
    if (!school) {
      res.status(404).json({ error: "School not found" });
      return;
    }
    res.json(school);
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
