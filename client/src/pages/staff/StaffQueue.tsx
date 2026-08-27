import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import type { SubmissionRow } from "../../types";
import { PageHead, StatusBadge } from "../../components/layout";

export default function StaffQueue() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<SubmissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");

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

  const counts = {
    submitted: rows.filter((r) => r.status === "submitted").length,
    in_review: rows.filter((r) => r.status === "in_review").length,
    flagged: rows.filter((r) => r.status === "flagged").length,
    resolved: rows.filter((r) => r.status === "resolved").length,
  };

  return (
    <div>
      <PageHead
        title="My School's Submissions"
        subtitle="Submissions from your school, ready for you to review and comment."
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
        ) : (
          <table className="grid" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th>Form</th>
                <th>Submission ID</th>
                <th>Status</th>
                <th>Submitted</th>
                <th style={{ width: 120 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.public_id}>
                  <td className="cell-strong">{s.form_name}</td>
                  <td className="cell-mono">{shortId(s.public_id)}</td>
                  <td>
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="cell-mono">{formatDate(s.submitted_at)}</td>
                  <td>
                    <button
                      className="badge-button"
                      onClick={() => navigate(`/staff/${s.public_id}`)}
                    >
                      Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
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
