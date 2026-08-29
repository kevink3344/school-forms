import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import type { Form, School, SubmissionRow } from "../../types";
import { PageHead, StatusBadge } from "../../components/layout";
import ExportModal from "../../components/ExportModal";
import { useAuth } from "../../context/AuthContext";

interface Filters {
  school_id: string;
  form_id: string;
  status: string;
  from: string;
  to: string;
}

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [forms, setForms] = useState<Form[]>([]);
  const [schools, setSchools] = useState<School[]>([]);
  const [submissions, setSubmissions] = useState<SubmissionRow[]>([]);
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

  // Load submissions, respecting all filters. Uses the same list endpoint as the
  // staff queue so the grid is identical (student/form, id, status, submitted).
  useEffect(() => {
    let cancelled = false;
    api
      .listSubmissions({
        school_id: filters.school_id ? Number(filters.school_id) : undefined,
        form_id: filters.form_id ? Number(filters.form_id) : undefined,
        status: filters.status || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
      })
      .then((s) => {
        if (!cancelled) setSubmissions(s);
      })
      .catch(() => {
        if (!cancelled) setSubmissions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [filters.school_id, filters.form_id, filters.status, filters.from, filters.to]);

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

  return (
    <div>
      <PageHead
        title="Submissions"
        subtitle={
          <>
            All form submissions across every school. Filter, then export the exact columns you need.
            {user?.organization_slug ? (
              <span className="badge badge-blue" style={{ marginLeft: 10, fontSize: 11, verticalAlign: "middle" }}>
                {user.organization_slug}
              </span>
            ) : null}
          </>
        }
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
      ) : (
        <SubmissionsGrid
          rows={submissions}
          onOpen={(publicId) => navigate(`/admin/submissions/${publicId}`)}
        />
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
// Submissions grid — shares the same layout/CSS as the staff "My School
// Submissions" table: Student/School, Submission ID, Status, Submitted, Actions.
// ---------------------------------------------------------------------------
function SubmissionsGrid({
  rows,
  onOpen,
}: {
  rows: SubmissionRow[];
  onOpen: (publicId: string) => void;
}) {
  if (!rows.length) {
    return <div className="empty-state">No submissions for the selected filters.</div>;
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>Submissions</h3>
        <span className="sub" style={{ marginLeft: "auto" }}>
          {rows.length} result{rows.length !== 1 ? "s" : ""}
        </span>
      </div>
      <table className="grid" style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th>Student / School</th>
            <th>Submission ID</th>
            <th>Status</th>
            <th>Submitted</th>
            <th style={{ width: 120 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.public_id}>
              <td className="cell-strong" style={{ whiteSpace: "nowrap" }} data-label="Student / School">
                <a
                  className="link-name"
                  href={`/admin/submissions/${s.public_id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpen(s.public_id);
                  }}
                >
                  {s.student_name || "Unnamed submission"}
                </a>
                <span className="cell-mono" style={{ marginLeft: 8, whiteSpace: "nowrap" }}>
                  {s.school_name ?? "—"}
                </span>
              </td>
              <td className="cell-mono" data-label="Submission ID">{shortId(s.public_id)}</td>
              <td data-label="Status">
                <StatusBadge status={s.status} />
              </td>
              <td className="cell-mono" data-label="Submitted">{formatDate(s.submitted_at)}</td>
              <td>
                <button className="badge-button" onClick={() => onOpen(s.public_id)}>
                  Review
                </button>
              </td>
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
function shortId(id: string): string {
  if (id.length <= 10) return id;
  return `${id.slice(0, 8)}…`;
}

function formatDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
