import { Router } from "express";
import {
  listSubmissions,
  getExportColumns,
  listSubmissionValues,
  execute,
} from "../db/queries.js";
import { requireAuth, requireRoles } from "../auth.js";
import { getForm } from "../db/queries.js";

export const exportRouter = Router();

// -----------------------------------------------------------------------------
// Helper: build the exportable rows for a set of submissions + columns
// -----------------------------------------------------------------------------
async function buildExportRows(
  formId: number,
  columns: { key: string; label: string; staff_only: boolean; field_id: number }[],
  submissions: { id: number; public_id: string; submitted_at: Date; status: string }[]
) {
  const rows = [];
  for (const s of submissions) {
    const values = await listSubmissionValues(s.id);
    const row: Record<string, unknown> = {
      submission_public_id: s.public_id,
      submitted_at: s.submitted_at,
      status: s.status,
    };
    for (const v of values) {
      const col = columns.find((c) => c.field_id === v.field_id);
      if (col) {
        row[col.key] = v.value;
      }
    }
    rows.push(row);
  }
  return rows;
}

// CSV escaping helper
function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (typeof value === "object") {
    s = JSON.stringify(value);
  } else {
    s = String(value);
  }
  // Wrap in quotes if it contains commas, quotes, or newlines
  const needsQuote = /[",\n\r]/.test(s);
  if (needsQuote) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// -----------------------------------------------------------------------------
// GET /api/export/preview?form_id=&status=&school_id= — column preview for UI
// -----------------------------------------------------------------------------
exportRouter.get("/preview", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const formId = req.query.form_id ? Number(req.query.form_id) : undefined;
    const schoolId = req.query.school_id ? Number(req.query.school_id) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;

    if (!formId) {
      res.status(400).json({ error: "form_id is required" });
      return;
    }
    const form = await getForm(formId);
    if (!form) {
      res.status(404).json({ error: "Form not found" });
      return;
    }

    const rawColumns = await getExportColumns(formId);
    const columns = rawColumns.map((c) => {
      const m = /^field_(\d+)$/.exec(c.key);
      return { ...c, field_id: m ? Number(m[1]) : 0 };
    });

    const submissions = await listSubmissions({ schoolId, formId, status });
    const rows = await buildExportRows(formId, columns, submissions);

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
// returns a CSV download
// -----------------------------------------------------------------------------
exportRouter.get("/csv", requireAuth, requireRoles("admin"), async (req, res, next) => {
  try {
    const formId = req.query.form_id ? Number(req.query.form_id) : undefined;
    const schoolId = req.query.school_id ? Number(req.query.school_id) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    const includeStaffOnly = req.query.include_staff_only === "1";

    if (!formId) {
      res.status(400).json({ error: "form_id is required" });
      return;
    }
    const form = await getForm(formId);
    if (!form) {
      res.status(404).json({ error: "Form not found" });
      return;
    }

    let rawColumns = await getExportColumns(formId);
    if (!includeStaffOnly) {
      rawColumns = rawColumns.filter((c) => !c.staff_only);
    }
    const columns = rawColumns.map((c) => {
      const m = /^field_(\d+)$/.exec(c.key);
      return { ...c, field_id: m ? Number(m[1]) : 0 };
    });

    const submissions = await listSubmissions({ schoolId, formId, status });
    const rows = await buildExportRows(formId, columns, submissions);

    // Build CSV — use the field label as the visible header, but look up each
    // value by its internal `key` (e.g. field_9) so the columns still resolve.
    const headers = [
      { header: "submission_public_id", key: "submission_public_id" },
      { header: "submitted_at", key: "submitted_at" },
      { header: "status", key: "status" },
      ...columns.map((c) => ({ header: c.label, key: c.key })),
    ];
    const csvLines = [headers.map((h) => csvEscape(h.header)).join(",")];
    for (const row of rows) {
      csvLines.push(headers.map((h) => csvEscape(row[h.key])).join(","));
    }
    const csv = "\uFEFF" + csvLines.join("\r\n");

    const filename = `export_${formId}_${Date.now()}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});
