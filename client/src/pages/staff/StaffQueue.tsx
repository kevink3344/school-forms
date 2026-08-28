import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import type { Form, SubmissionRow } from "../../types";
import { PageHead, StatusBadge } from "../../components/layout";
import ExportModal from "../../components/ExportModal";

type ViewMode = "table" | "cards";

export default function StaffQueue() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<SubmissionRow[]>([]);
  const [forms, setForms] = useState<Form[]>([]);
  const [exportOpen, setExportOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  // Default to card view on small screens; tablet/desktop defaults to table.
  const [viewMode, setViewMode] = useState<ViewMode>(
    typeof window !== "undefined" && window.innerWidth < 768 ? "cards" : "table"
  );

  const load = (status: string) => {
    setLoading(true);
    api
      .listSubmissions(status ? { status } : {})
      .then((s) => setRows(s))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load(statusFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  // Load forms so the Export drawer can present a form selector (scoped to school).
  useEffect(() => {
    let cancelled = false;
    api
      .listForms()
      .then((f) => {
        if (!cancelled) setForms(f);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const counts = {
    submitted: rows.filter((r) => r.status === "submitted").length,
    in_review: rows.filter((r) => r.status === "in_review").length,
    flagged: rows.filter((r) => r.status === "flagged").length,
    resolved: rows.filter((r) => r.status === "resolved").length,
  };

  const openSubmission = (publicId: string) => navigate(`/staff/${publicId}`);

  return (
    <div>
      <PageHead
        title="My School's Submissions"
        subtitle="Submissions from your school, ready for you to review and comment."
        actions={
          <>
            <button className="primary-button" onClick={() => setExportOpen(true)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M12 3v12M7 10l5 5 5-5M5 21h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Export
            </button>
            <div className="view-toggle">
              <button
                className={viewMode === "table" ? "active" : ""}
                onClick={() => setViewMode("table")}
                title="Table view"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="4" width="18" height="16" rx="1" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                  <line x1="9" y1="4" x2="9" y2="20" />
                </svg>
                Table
              </button>
              <button
                className={viewMode === "cards" ? "active" : ""}
                onClick={() => setViewMode("cards")}
                title="Card view"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="4" width="8" height="7" rx="1" />
                  <rect x="13" y="4" width="8" height="7" rx="1" />
                  <rect x="3" y="13" width="8" height="7" rx="1" />
                  <rect x="13" y="13" width="8" height="7" rx="1" />
                </svg>
                Cards
              </button>
            </div>
          </>
        }
      />

      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        {[
          { value: "", label: "All" },
          { value: "submitted", label: "Submitted" },
          { value: "in_review", label: "In Review" },
          { value: "flagged", label: "Flagged" },
          { value: "resolved", label: "Resolved" },
        ].map((t) => (
          <button
            key={t.value}
            className="badge-button"
            style={
              statusFilter === t.value
                ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }
                : {}
            }
            onClick={() => setStatusFilter(t.value)}
          >
            {t.label}
            {t.value === "submitted" && counts.submitted > 0 && ` (${counts.submitted})`}
          </button>
        ))}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Submissions</h3>
          <span className="sub" style={{ marginLeft: "auto" }}>
            {rows.length} result{rows.length !== 1 ? "s" : ""}
          </span>
        </div>

        {loading ? (
          <div className="loading-state">
            <div className="spinner" /> Loading...
          </div>
        ) : rows.length === 0 ? (
          <div className="empty-state">No submissions for your school yet.</div>
        ) : viewMode === "cards" ? (
          <div className="queue-list" style={{ padding: 16 }}>
            {rows.map((s) => (
              <div className="queue-item" key={s.public_id} onClick={() => openSubmission(s.public_id)}>
                <div className="qi-main">
                  <div className="qi-top">
                    <StatusBadge status={s.status} />
                    <span className="badge badge-slate">{s.form_name}</span>
                  </div>
                  <div className="qi-title">
                    <a
                      href={`/staff/${s.public_id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openSubmission(s.public_id);
                      }}
                    >
                      {s.student_name || "Unnamed submission"}
                    </a>
                  </div>
                  <div className="qi-meta">{s.student_name ? s.form_name : `Form: ${s.form_name}`}</div>
                </div>
                <div className="qi-right">
                  <span className="qi-time">{formatDate(s.submitted_at)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <table className="grid" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th>Student / Form</th>
                <th>Submission ID</th>
                <th>Status</th>
                <th>Submitted</th>
                <th style={{ width: 120 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.public_id}>
                  <td className="cell-strong">
                    <a
                      className="link-name"
                      href={`/staff/${s.public_id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        openSubmission(s.public_id);
                      }}
                    >
                      {s.student_name || "Unnamed submission"}
                    </a>
                    <span className="cell-mono" style={{ marginLeft: 8 }}>
                      {s.form_name}
                    </span>
                  </td>
                  <td className="cell-mono">{shortId(s.public_id)}</td>
                  <td>
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="cell-mono">{formatDate(s.submitted_at)}</td>
                  <td>
                    <button className="badge-button" onClick={() => openSubmission(s.public_id)}>
                      Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        formId={forms[0] ? String(forms[0].id) : ""}
        forms={forms}
        isStaff
      />
    </div>
  );
}

function shortId(id: string): string {
  if (id.length <= 10) return id;
  return `${id.slice(0, 8)}…`;
}

function formatDate(v: string): string {
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
