import { Router } from "express";
import { requireAuth, requireRoles, scopedSchoolId, isSchoolScoped, type JwtUser } from "../auth.js";
import {
  createReportView,
  deleteReportView,
  findReportViewByName,
  getExportColumns,
  getForm,
  getReportView,
  listReportViews,
  listSubmissions,
  setDefaultReportView,
  touchReportView,
  updateReportView,
  type ReportViewRow,
} from "../db/queries.js";
import {
  buildExportRows,
  buildTableModel,
  filterColumnsForRole,
  formatSubmittedAt,
  withFieldId,
  type ExportColumnWithFieldId,
} from "../export/table.js";
import { CSV_CONTENT_TYPE, writeCsv } from "../export/writers/csv.js";
import { XLSX_CONTENT_TYPE, writeXlsx } from "../export/writers/xlsx.js";
import { PDF_CONTENT_TYPE, writePdf } from "../export/writers/pdf.js";
import {
  createReportViewSchema,
  reportQuerySchema,
  updateReportViewSchema,
  type ReportQueryInput,
} from "../schemas.js";

export const reportsRouter = Router();

// Every reports endpoint is available to the same three roles as the existing
// export endpoints. Admin is organization-scoped and may pick any school in the
// org; staff / School Contacts are hard-locked to their own school.
const REPORT_ROLES = ["staff", "cdm_contact", "admin"] as const;

// -----------------------------------------------------------------------------
// Shared query resolution
//
// The preview grid and every export format funnel through this one function, so
// the rows you see on screen are literally the rows that get written to disk.
// It is also the single choke point for column authorization: a requested
// `field_N` that the caller isn't allowed to see is dropped here, before any
// data is read.
// -----------------------------------------------------------------------------
interface ResolvedReport {
  formTitle: string;
  formId: number;
  columns: ExportColumnWithFieldId[];
  rows: Record<string, unknown>[];
  schoolId?: number;
}

type Resolution = { ok: true; report: ResolvedReport } | { ok: false; status: number; error: string };

function parseColumnParam(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const keys = raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  return keys.length ? keys : null;
}

async function resolveReport(query: unknown, user: JwtUser): Promise<Resolution> {
  const parsed = reportQuerySchema.safeParse(query);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "form_id is required" };
  }
  const q: ReportQueryInput = parsed.data;

  const isStaff = user.role !== "admin";
  // A school-scoped role is locked to its own school; admin and staff may
  // narrow the report with an optional school_id filter.
  const schoolId =
    scopedSchoolId(user) ??
    (q.school_id ? Number(q.school_id) : undefined);
  // Staff-only columns can only ever be exposed to admins, and only on request.
  const includeStaffOnly = !isStaff && q.include_staff_only === "1";

  const form = await getForm(q.form_id, user.organization_id);
  if (!form) return { ok: false, status: 404, error: "Form not found" };

  // Authorize first, then select — an unauthorized key can never reach the query.
  const visible = filterColumnsForRole(await getExportColumns(q.form_id), user.role, includeStaffOnly);

  const requested = parseColumnParam(q.columns);
  let selected = visible;
  if (requested) {
    const allowed = new Set(visible.map((c) => c.key));
    const kept = requested.filter((k) => allowed.has(k));
    if (kept.length === 0) {
      return { ok: false, status: 400, error: "No valid columns selected" };
    }
    const order = new Map(kept.map((k, i) => [k, i]));
    // Honor the caller's column order rather than the form's sort order.
    selected = visible
      .filter((c) => order.has(c.key))
      .sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  }

  const columns = withFieldId(selected);
  const submissions = await listSubmissions({
    organizationId: user.organization_id,
    schoolId,
    formId: q.form_id,
    status: q.status,
    from: q.from,
    to: q.to,
    q: q.q,
  });
  const rows = await buildExportRows(columns, submissions);

  return {
    ok: true,
    report: { formTitle: form.title, formId: q.form_id, columns, rows, schoolId },
  };
}

// Human-readable caption printed at the top of PDF/XLSX exports.
function buildSubtitle(query: ReportQueryInput, report: ResolvedReport): string {
  const parts: string[] = [];
  parts.push(report.schoolId ? `School #${report.schoolId}` : "All schools");
  parts.push(query.status ? `Status: ${query.status}` : "All statuses");
  if (query.from || query.to) {
    parts.push(`Dates: ${query.from || "…"} – ${query.to || "…"}`);
  }
  if (query.q && query.q.trim()) parts.push(`Search: "${query.q.trim()}"`);
  parts.push(`Generated ${formatSubmittedAt(new Date())}`);
  return parts.join("  ·  ");
}

// Strip internal storage fields before returning a saved view to the client.
function presentReportView(v: ReportViewRow) {
  return {
    id: v.id,
    name: v.name,
    form_id: v.form_id,
    filters: v.filters,
    columns: v.columns,
    format: v.format,
    is_default: v.is_default,
    last_used_at: v.last_used_at,
    created_at: v.created_at,
    updated_at: v.updated_at,
  };
}

function numericParam(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// -----------------------------------------------------------------------------
// GET /api/reports/preview — the exact rows the export would contain.
// -----------------------------------------------------------------------------
reportsRouter.get("/preview", requireAuth, requireRoles(...REPORT_ROLES), async (req, res, next) => {
  try {
    const resolved = await resolveReport(req.query, req.user!);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    const { report } = resolved;
    res.json({
      form_id: report.formId,
      form_title: report.formTitle,
      school_scoped: isSchoolScoped(req.user!.role),
      columns: report.columns.map((c) => ({
        key: c.key,
        label: c.label,
        staff_only: c.staff_only,
        roles: c.roles,
      })),
      rows: report.rows,
      total: report.rows.length,
    });
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// GET /api/reports/export?format=csv|xlsx|pdf — download the same table.
// -----------------------------------------------------------------------------
reportsRouter.get("/export", requireAuth, requireRoles(...REPORT_ROLES), async (req, res, next) => {
  try {
    const format = String(req.query.format ?? "csv").toLowerCase();
    if (format !== "csv" && format !== "xlsx" && format !== "pdf") {
      res.status(400).json({ error: "format must be one of csv, xlsx, pdf" });
      return;
    }

    const resolved = await resolveReport(req.query, req.user!);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    const { report } = resolved;
    const parsedQuery = reportQuerySchema.parse(req.query);
    const table = buildTableModel(report.columns, report.rows, {
      title: report.formTitle,
      subtitle: buildSubtitle(parsedQuery, report),
    });

    const stamp = Date.now();
    const filenameBase = `report_${report.formId}_${stamp}`;
    res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.${format}"`);

    if (format === "csv") {
      res.setHeader("Content-Type", CSV_CONTENT_TYPE);
      res.send(writeCsv(table));
      return;
    }
    if (format === "xlsx") {
      res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
      res.send(await writeXlsx(table, report.formTitle));
      return;
    }
    res.setHeader("Content-Type", PDF_CONTENT_TYPE);
    res.send(await writePdf(table));
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------------
// Saved Views — CRUD, always scoped to the signed-in user.
// -----------------------------------------------------------------------------
reportsRouter.get("/views", requireAuth, requireRoles(...REPORT_ROLES), async (req, res, next) => {
  try {
    const views = await listReportViews(req.user!.id);
    res.json({ views: views.map(presentReportView) });
  } catch (err) {
    next(err);
  }
});

reportsRouter.post("/views", requireAuth, requireRoles(...REPORT_ROLES), async (req, res, next) => {
  try {
    const parsed = createReportViewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const input = parsed.data;

    // The form must exist inside the caller's organization.
    const form = await getForm(input.form_id, req.user!.organization_id);
    if (!form) {
      res.status(404).json({ error: "Form not found" });
      return;
    }
    if (await findReportViewByName(req.user!.id, input.name)) {
      res.status(409).json({ error: "A view with that name already exists" });
      return;
    }

    const view = await createReportView({
      userId: req.user!.id,
      organizationId: req.user!.organization_id ?? null,
      name: input.name,
      formId: input.form_id,
      filters: input.filters,
      columns: input.columns ?? null,
      format: input.format,
      isDefault: input.is_default,
    });
    res.status(201).json({ view: presentReportView(view) });
  } catch (err) {
    next(err);
  }
});

reportsRouter.put("/views/:id", requireAuth, requireRoles(...REPORT_ROLES), async (req, res, next) => {
  try {
    const id = numericParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid view id" });
      return;
    }
    const parsed = updateReportViewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      return;
    }
    const patch = parsed.data;

    // Existence check doubles as the ownership check (WHERE user_id = caller).
    if (!(await getReportView(id, req.user!.id))) {
      res.status(404).json({ error: "View not found" });
      return;
    }
    if (patch.form_id !== undefined) {
      const form = await getForm(patch.form_id, req.user!.organization_id);
      if (!form) {
        res.status(404).json({ error: "Form not found" });
        return;
      }
    }
    if (patch.name !== undefined) {
      const clash = await findReportViewByName(req.user!.id, patch.name);
      if (clash && clash.id !== id) {
        res.status(409).json({ error: "A view with that name already exists" });
        return;
      }
    }

    const view = await updateReportView(id, req.user!.id, {
      name: patch.name,
      formId: patch.form_id,
      filters: patch.filters,
      columns: patch.columns,
      format: patch.format,
      isDefault: patch.is_default,
    });
    if (!view) {
      res.status(404).json({ error: "View not found" });
      return;
    }
    res.json({ view: presentReportView(view) });
  } catch (err) {
    next(err);
  }
});

reportsRouter.delete("/views/:id", requireAuth, requireRoles(...REPORT_ROLES), async (req, res, next) => {
  try {
    const id = numericParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid view id" });
      return;
    }
    if (!(await deleteReportView(id, req.user!.id))) {
      res.status(404).json({ error: "View not found" });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

reportsRouter.post("/views/:id/default", requireAuth, requireRoles(...REPORT_ROLES), async (req, res, next) => {
  try {
    const id = numericParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid view id" });
      return;
    }
    const view = await setDefaultReportView(id, req.user!.id);
    if (!view) {
      res.status(404).json({ error: "View not found" });
      return;
    }
    res.json({ view: presentReportView(view) });
  } catch (err) {
    next(err);
  }
});

// Mark a view as recently used so the Reports page can auto-apply the view the
// user most recently worked with when they come back.
reportsRouter.post("/views/:id/use", requireAuth, requireRoles(...REPORT_ROLES), async (req, res, next) => {
  try {
    const id = numericParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid view id" });
      return;
    }
    const view = await getReportView(id, req.user!.id);
    if (!view) {
      res.status(404).json({ error: "View not found" });
      return;
    }
    await touchReportView(id, req.user!.id);
    const fresh = await getReportView(id, req.user!.id);
    res.json({ view: presentReportView(fresh ?? view) });
  } catch (err) {
    next(err);
  }
});
