import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import type { ExportPreview, Form, School, SubmissionRow } from "../../types";
import { PageHead, StatusBadge } from "../../components/layout";
import ExportModal from "../../components/ExportModal";

interface Filters {
  school_id: string;
  form_id: string;
  status: string;
  from: string;
  to: string;
}

export default function AdminDashboard() {
  const navigate = useNavigate();
  const [forms, setForms] = useState<Form[]>([]);
  const [schools, setSchools] = useState<School[]>([]);
  const [submissions, setSubmissions] = useState<SubmissionRow[]>([]);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);

  const [filters, setFilters] = useState<Filters>({
    school_id: "",
    form_id: "",
    status: "",
    from: "",
    to: "",
  });

  // Load forms + schools once
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listForms(), api.listSchools()])
      .then(([f, s]) => {
        if (cancelled) return;
        setForms(f);
        setSchools(s);
        // Default to first form so the spreadsheet & export preview work immediately
        if (f.length > 0) {
          setFilters((prev) => ({ ...prev, form_id: String(f[0].id) }));
        }
      })
      .catch(() => {
        // ignore
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load either the export preview grid (when a form is chosen) or the metadata list
  useEffect(() => {
    let cancelled = false;
    const formId = filters.form_id ? Number(filters.form_id) : undefined;
    const schoolId = filters.school_id ? Number(filters.school_id) : undefined;
    const status = filters.status || undefined;
    const from = filters.from || undefined;
    const to = filters.to || undefined;

    if (formId) {
      // Use the export preview endpoint as the spreadsheet source so the grid
      // exactly matches what's exportable.
      api
        .exportPreview({ form_id: formId, school_id: schoolId, status })
        .then((p) => {
          if (!cancelled) setPreview(p);
        })
        .catch(() => {
          if (!cancelled) setPreview(null);
        });
    } else {
      setPreview(null);
      api
        .listSubmissions({ school_id: schoolId, status, from, to })
        .then((s) => {
          if (!cancelled) setSubmissions(s);
        })
        .catch(() => {
          if (!cancelled) setSubmissions([]);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [filters.form_id, filters.school_id, filters.status, filters.from, filters.to]);

  const selectedForm = useMemo(
    () => forms.find((f) => String(f.id) === filters.form_id),
    [forms, filters.form_id]
  );

  const setFilter = (key: keyof Filters, value: string) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  const clearFilters = () =>
    setFilters((prev) => ({
      ...prev,
      school_id: "",
      status: "",
      from: "",
      to: "",
    }));

  const schoolName = (id: number | null) =>
    schools.find((s) => s.id === id)?.name || "—";

  return (
    <div>
      <PageHead
        title="Submissions"
        subtitle="All form submissions across every school. Filter, then export the exact columns you need."
        actions={
          <>
            <button className="secondary-button" onClick={() => navigate("/admin/forms")}>
              + New Form
            </button>
            <button className="primary-button" onClick={() => setExportOpen(true)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M12 3v12M7 10l5 5 5-5M5 21h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Export
            </button>
          </>
        }
      />

      {/* Filter toolbar */}
      <div className="filter-bar">
        <div className="filter-group">
          <label>School</label>
          <select
            value={filters.school_id}
            onChange={(e) => setFilter("school_id", e.target.value)}
          >
            <option value="">All schools</option>
            {schools.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <label>Form</label>
          <select
            value={filters.form_id}
            onChange={(e) => setFilter("form_id", e.target.value)}
          >
            <option value="">All forms</option>
            {forms.map((f) => (
              <option key={f.id} value={f.id}>
                {f.title}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <label>Status</label>
          <select
            value={filters.status}
            onChange={(e) => setFilter("status", e.target.value)}
          >
            <option value="">All statuses</option>
            <option value="submitted">Submitted</option>
            <option value="in_review">In Review</option>
            <option value="flagged">Flagged</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>
        <div className="filter-group">
          <label>Date from</label>
          <input type="date" value={filters.from} onChange={(e) => setFilter("from", e.target.value)} />
        </div>
        <div className="filter-group">
          <label>Date to</label>
          <input type="date" value={filters.to} onChange={(e) => setFilter("to", e.target.value)} />
        </div>
        <div className="filter-spacer" />
        <button className="clear" onClick={clearFilters}>
          Clear
        </button>
      </div>

      {loading ? (
        <div className="loading-state">
          <div className="spinner" /> Loading submissions...
        </div>
      ) : preview ? (
        <SpreadsheetGrid
          columns={preview.columns}
          rows={preview.rows}
          schoolName={schoolName}
          selectedForm={selectedForm?.title || ""}
        />
      ) : (
        <MetaGrid rows={submissions} schoolName={schoolName} />
      )}

      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        formId={filters.form_id}
        forms={forms}
        schoolId={filters.school_id}
        status={filters.status}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spreadsheet grid for the selected form (uses export/preview columns + rows)
// ---------------------------------------------------------------------------
function SpreadsheetGrid({
  columns,
  rows,
  schoolName,
  selectedForm,
}: {
  columns: ExportPreview["columns"];
  rows: Record<string, unknown>[];
  schoolName: (id: number | null) => string;
  selectedForm: string;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (publicId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(publicId)) next.delete(publicId);
      else next.add(publicId);
      return next;
    });

  const toggleAll = () => {
    if (selected.size === rows.length) setSelected(new Set());
    else setSelected(new Set(rows.map((r) => String(r.submission_public_id))));
  };

  if (!rows.length) {
    return <div className="empty-state">No submissions for the selected filters.</div>;
  }

  return (
    <div className="grid-wrap">
      <table className="grid">
        <thead>
          <tr>
            <th className="col-check">
              <input
                type="checkbox"
                className="row-check"
                checked={selected.size === rows.length && rows.length > 0}
                onChange={toggleAll}
              />
            </th>
            <th>School</th>
            {columns.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
            <th>Status</th>
            <th>Submitted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r.submission_public_id)}>
              <td className="col-check">
                <input
                  type="checkbox"
                  className="row-check"
                  checked={selected.has(String(r.submission_public_id))}
                  onChange={() => toggle(String(r.submission_public_id))}
                />
              </td>
              <td>{schoolName(Number(r.school_id ?? null))}</td>
              {columns.map((c) => (
                <td key={c.key}>{formatCell(r[c.key])}</td>
              ))}
              <td>
                <StatusBadge status={String(r.status || "submitted")} />
              </td>
              <td className="cell-mono">{formatDate(r.submitted_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid-footer">
        <span>
          {rows.length} result{rows.length !== 1 ? "s" : ""}
        </span>
        <span className="muted-note">
          {selected.size} selected · {selectedForm}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metadata-only grid (used when "All forms" is selected — no column preview)
// ---------------------------------------------------------------------------
function MetaGrid({
  rows,
  schoolName,
}: {
  rows: SubmissionRow[];
  schoolName: (id: number | null) => string;
}) {
  if (!rows.length) {
    return <div className="empty-state">No submissions for the selected filters.</div>;
  }
  return (
    <div className="grid-wrap">
      <table className="grid">
        <thead>
          <tr>
            <th>Submission ID</th>
            <th>Form</th>
            <th>School</th>
            <th>Status</th>
            <th>Submitted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.public_id}>
              <td className="cell-mono">{s.public_id}</td>
              <td className="cell-strong">{s.form_name}</td>
              <td>{schoolName(s.school_id)}</td>
              <td>
                <StatusBadge status={s.status} />
              </td>
              <td className="cell-mono">{formatDate(s.submitted_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatCell(v: unknown): ReactNode {
  if (v === null || v === undefined || v === "") return <span style={{ color: "var(--text-muted)" }}>—</span>;
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function formatDate(v: unknown): string {
  if (!v) return "—";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
