import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import type { DocumentRow } from "../../types";
import { PageHead } from "../../components/layout";

// Document status → badge color (Pending / Completed / Failed).
function docStatusBadge(status: string): { cls: string; label: string } {
  switch (status) {
    case "Completed":
      return { cls: "badge-green", label: "Completed" };
    case "Failed":
      return { cls: "badge-red", label: "Failed" };
    case "Pending":
      return { cls: "badge-amber", label: "Pending" };
    default:
      return { cls: "badge-slate", label: status };
  }
}

export default function StaffDocuments() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api
      .listDocuments()
      .then((d) => setRows(d))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const openSubmission = (publicId: string) => navigate(`/staff/${publicId}`);

  return (
    <div>
      <PageHead
        title="Generated Documents"
        subtitle="Google Docs generated from your school's submissions."
        actions={
          <button className="primary-button" onClick={load}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Refresh
          </button>
        }
      />

      <div className="card">
        <div className="card-head">
          <h3>Documents</h3>
          <span className="sub" style={{ marginLeft: "auto" }}>
            {rows.length} result{rows.length !== 1 ? "s" : ""}
          </span>
        </div>

        {loading ? (
          <div className="loading-state">
            <div className="spinner" /> Loading...
          </div>
        ) : rows.length === 0 ? (
          <div className="empty-state">No generated documents yet.</div>
        ) : (
          <table className="grid" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ width: 170 }}>Date</th>
                <th>Student Name</th>
                <th>School Name</th>
                <th>Course Title</th>
                <th>Phase I Result</th>
                <th>Document</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const b = docStatusBadge(d.status);
                const docId = d.document_id;
                return (
                  <tr key={d.id}>
                    <td className="cell-mono" data-label="Date">{formatDate(d.created_at)}</td>
                    <td className="cell-strong" data-label="Student Name">
                      <a
                        className="link-name"
                        href={`/staff/${d.public_id}`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          openSubmission(d.public_id);
                        }}
                      >
                        {d.student_name || "Unnamed submission"}
                      </a>
                    </td>
                    <td data-label="School Name">{d.school_name ?? "—"}</td>
                    <td data-label="Course Title">{d.course_title ?? "—"}</td>
                    <td data-label="Phase I Result">{d.phase1_result ?? "—"}</td>
                    <td data-label="Document">
                      {docId ? (
                        <a
                          className="link-name"
                          href={`https://docs.google.com/document/d/${docId}/edit`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Open
                        </a>
                      ) : (
                        <span className="cell-mono">—</span>
                      )}
                    </td>
                    <td data-label="Status">
                      <span className={`badge ${b.cls}`}>{b.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
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
