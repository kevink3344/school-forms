import { useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import type { DocumentRow } from "../../types";
import { PageHead } from "../../components/layout";
import { useAuth } from "../../context/AuthContext";

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
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<DocumentRow | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [panelError, setPanelError] = useState("");

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

  const openPanel = (row: DocumentRow) => {
    setSelected(row);
    setPanelError("");
  };

  const closePanel = () => {
    setSelected(null);
    setPanelError("");
  };

  // Regenerate a document from the submission's CURRENT values. The backend
  // creates a fresh Pending row synchronously and returns the newest document
  // for the submission, so we refresh both the list and the open panel.
  const handleRegenerate = async () => {
    if (!selected) return;
    setRegenerating(true);
    setPanelError("");
    try {
      const refreshed = await api.regenerateDocument(selected.id);
      // Refresh the list to include the new row.
      load();
      setSelected((prev) => (prev ? refreshed : null));
    } catch (err) {
      setPanelError(err instanceof ApiError ? err.message : "Could not regenerate document");
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div>
      <PageHead
        title="Generated Documents"
        subtitle={
          isAdmin
            ? "Google Docs generated from your organization's submissions."
            : "Google Docs generated from your school's submissions."
        }
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
                  <tr
                    key={d.id}
                    className={selected?.id === d.id ? "grid-row selected" : "grid-row"}
                    onClick={() => openPanel(d)}
                  >
                    <td className="cell-mono" data-label="Date">{formatDate(d.created_at)}</td>
                    <td className="cell-strong" data-label="Student Name">
                      {d.student_name || "Unnamed submission"}
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

      {/* Right slide-out document detail panel */}
      {selected && (
        <div className="drawer-overlay open" onClick={closePanel}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <h2>Document Details</h2>
              <button className="icon-button close" onClick={closePanel}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <div className="drawer-body">
              <div className="field-list" style={{ gridTemplateColumns: "1fr", gap: "10px 0" }}>
                <div className="field">
                  <span className="f-label">Submission ID</span>
                  <span className="cell-mono">{selected.public_id}</span>
                </div>
                <div className="field">
                  <span className="f-label">Student Name</span>
                  <span>{selected.student_name || "Unnamed submission"}</span>
                </div>
                <div className="field">
                  <span className="f-label">School Name</span>
                  <span>{selected.school_name ?? "—"}</span>
                </div>
                <div className="field">
                  <span className="f-label">Course Title</span>
                  <span>{selected.course_title ?? "—"}</span>
                </div>
                <div className="field">
                  <span className="f-label">Phase I Result</span>
                  <span>{selected.phase1_result ?? "—"}</span>
                </div>
                <div className="field">
                  <span className="f-label">Generated</span>
                  <span>{formatDate(selected.created_at)}</span>
                </div>
                <div className="field">
                  <span className="f-label">Status</span>
                  <span className={`badge ${docStatusBadge(selected.status).cls}`}>
                    {docStatusBadge(selected.status).label}
                  </span>
                </div>
                {selected.document_id ? (
                  <div className="field">
                    <span className="f-label">Document</span>
                    <a
                      className="link-name"
                      href={`https://docs.google.com/document/d/${selected.document_id}/edit`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open in Google Docs ↗
                    </a>
                  </div>
                ) : null}
                {selected.error ? (
                  <div className="field">
                    <span className="f-label">Error</span>
                    <span style={{ color: "var(--danger, #ba3040)" }}>{selected.error}</span>
                  </div>
                ) : null}
              </div>

              {panelError && (
                <div
                  style={{
                    background: "rgb(255,232,234)",
                    color: "rgb(186,48,64)",
                    padding: "10px 12px",
                    borderRadius: "var(--radius)",
                    fontSize: 13,
                    marginTop: 14,
                  }}
                >
                  {panelError}
                </div>
              )}
            </div>

            <div className="drawer-foot">
              <span className="file-note" style={{ marginTop: 0 }}>
                Regenerate re-reads the submission&apos;s current values.
              </span>
              <div className="spacer" />
              <button className="secondary-button" onClick={closePanel}>
                Close
              </button>
              <button
                className="primary-button"
                onClick={handleRegenerate}
                disabled={regenerating || selected.status === "Pending"}
              >
                {regenerating ? "Regenerating..." : "Regenerate"}
              </button>
            </div>
          </div>
        </div>
      )}
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
