import { Router } from "express";
import { listSubmissions, getExportColumns, getForm } from "../db/queries.js";
import { requireAuth, requireRoles } from "../auth.js";
import {
  filterColumnsForRole,
  withFieldId,
  buildExportRows,
  buildTableModel,
} from "../export/table.js";
import { writeCsv, CSV_CONTENT_TYPE } from "../export/writers/csv.js";

export const exportRouter = Router();

// -----------------------------------------------------------------------------
// The column/row/CSV helpers that used to live here now live in
// ../export/table.ts and ../export/writers/csv.ts so the Reports routes build
// byte-identical output from the same code.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// GET /api/export/preview?form_id=&status=&school_id= — column preview for UI
// Available to admin AND staff. Staff are always scoped to their own school and
// only ever see the staff-only columns their role is granted.
// -----------------------------------------------------------------------------
exportRouter.get("/preview", requireAuth, requireRoles("staff", "cdm_contact", "admin"), async (req, res, next) => {
  try {
    const formId = req.query.form_id ? Number(req.query.form_id) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    const isStaff = req.user!.role !== "admin";
    // Admin may filter by school; staff and School Contacts are locked to their own school.
    const schoolId = isStaff
      ? req.user!.school_id ?? undefined
      : req.query.school_id
        ? Number(req.query.school_id)
        : undefined;

    if (!formId) {
      res.status(400).json({ error: "form_id is required" });
      return;
    }
    const form = await getForm(formId, req.user!.organization_id);
    if (!form) {
      res.status(404).json({ error: "Form not found" });
      return;
    }

    const rawColumns = await getExportColumns(formId);
    // Staff-only columns are always part of the preview: for an admin that is
    // every column, and for staff the role branch of filterColumnsForRole ignores
    // this flag and grants only the staff-only columns their role is allowed to
    // see. This keeps the preview in step with /csv, which includes them too.
    const columns = withFieldId(filterColumnsForRole(rawColumns, req.user!.role, true));

    const submissions = await listSubmissions({ organizationId: req.user!.organization_id, schoolId, formId, status });
    const rows = await buildExportRows(columns, submissions);

    res.json({
      columns: columns.map((c) => ({ key: c.key, label: c.label, staff_only: c.staff_only })),
      rows,
      total: rows.length,
    });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// GET /api/export/csv?form_id=&status=&school_id=&include_staff_only=0|1 —
// returns a CSV download. Available to admin AND staff. Staff are always scoped
// to their own school; the include_staff_only flag is only honored for admins.
// -----------------------------------------------------------------------------
exportRouter.get("/csv", requireAuth, requireRoles("staff", "cdm_contact", "admin"), async (req, res, next) => {
  try {
    const formId = req.query.form_id ? Number(req.query.form_id) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    const isStaff = req.user!.role !== "admin";
    // Admin may filter by school; staff and School Contacts are locked to their own school.
    const schoolId = isStaff
      ? req.user!.school_id ?? undefined
      : req.query.school_id
        ? Number(req.query.school_id)
        : undefined;
    // Staff-only columns are only exposed to admins, regardless of the flag.
    const includeStaffOnly = !isStaff && req.query.include_staff_only === "1";

    if (!formId) {
      res.status(400).json({ error: "form_id is required" });
      return;
    }
    const form = await getForm(formId, req.user!.organization_id);
    if (!form) {
      res.status(404).json({ error: "Form not found" });
      return;
    }

    const rawColumns = await getExportColumns(formId);
    const columns = withFieldId(filterColumnsForRole(rawColumns, req.user!.role, includeStaffOnly));

    const submissions = await listSubmissions({ organizationId: req.user!.organization_id, schoolId, formId, status });
    const rows = await buildExportRows(columns, submissions);

    // The field label is the visible header; each value is looked up by its
    // internal `key` (e.g. field_9) so the columns still resolve.
    const csv = writeCsv(buildTableModel(columns, rows));

    const filename = `export_${formId}_${Date.now()}.csv`;
    res.setHeader("Content-Type", CSV_CONTENT_TYPE);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});
