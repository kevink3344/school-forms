import { useEffect, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, X } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import type { Form } from "../../types";
import { PageHead, FormStatusBadge, formStatusBadge } from "../../components/layout";
import { useAuth } from "../../context/AuthContext";

// Delete / archive / restore share one modal: same shape, different copy and a
// different call. Branching on `kind` beats three near-identical modals.
type PendingKind = "delete" | "archive" | "restore";

const BODY_TEXT: CSSProperties = { margin: 0, fontSize: 14, lineHeight: 1.5 };
const BODY_HINT: CSSProperties = { margin: "10px 0 0", fontSize: 13, color: "var(--text-muted)" };

export default function AdminForms() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [forms, setForms] = useState<Form[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [schoolId, setSchoolId] = useState("");
  const [schools, setSchools] = useState<{ id: number; name: string }[]>([]);
  const [creating, setCreating] = useState(false);
  const [showNew, setShowNew] = useState(false);
  // Archived forms are hidden by default so the list stays focused on what is
  // live; the toggle reveals them (with a count) so they can be restored.
  const [showArchived, setShowArchived] = useState(false);
  const [pending, setPending] = useState<{ kind: PendingKind; form: Form } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoading(true);
    api
      .listForms()
      .then((f) => setForms(f))
      .catch(() => setError("Could not load forms"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    api
      .listSchools()
      .then((s) => setSchools(s))
      .catch(() => {});
  }, []);

  const handleCreate = async () => {
    if (!title.trim()) return;
    setCreating(true);
    setError("");
    try {
      const form = await api.createForm({
        title: title.trim(),
        school_id: schoolId ? Number(schoolId) : null,
        fields: [],
      });
      // Navigate into the designer to add fields
      navigate(`/admin/forms/${form.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create form");
      setCreating(false);
    }
  };

  const togglePublish = async (form: Form) => {
    const next = form.status === "published" ? "draft" : "published";
    try {
      await api.updateFormStatus(form.id, next);
      load();
    } catch {
      setError("Could not update status");
    }
  };

  // Delete, archive and restore all end the same way: run the call, surface any
  // server message (e.g. the 409 from deleting a form that has submissions),
  // then reload the list.
  const runPending = async () => {
    if (!pending) return;
    setBusy(true);
    setError("");
    const verb = pending.kind === "delete" ? "delete" : pending.kind;
    try {
      if (pending.kind === "delete") await api.deleteForm(pending.form.id);
      else if (pending.kind === "archive") await api.archiveForm(pending.form.id);
      else await api.restoreForm(pending.form.id);
      setPending(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not ${verb} form`);
      setPending(null);
    } finally {
      setBusy(false);
    }
  };

  const archivedForms = forms.filter((f) => f.status === "archived");
  // Archived rows sort to the bottom when revealed, so the greyed-out entries
  // never push the live ones out of view. `sort` is stable, so forms within each
  // group keep the API's `updated_at DESC` order.
  const visibleForms = (showArchived ? forms : forms.filter((f) => f.status !== "archived"))
    .slice()
    .sort((a, b) => Number(a.status === "archived") - Number(b.status === "archived"));

  const pendingTitle =
    pending?.kind === "delete" ? "Delete form" : pending?.kind === "archive" ? "Archive form" : "Restore form";
  const confirmLabel = pending?.kind === "delete" ? "Delete" : pending?.kind === "archive" ? "Archive" : "Restore";
  const busyLabel =
    pending?.kind === "delete" ? "Deleting..." : pending?.kind === "archive" ? "Archiving..." : "Restoring...";
  const pendingSubmissionCount = pending?.form.submission_count ?? 0;
  const pendingArchivedStatus = pending?.form.pre_archive_status ?? "draft";

  return (
    <div>
      <PageHead
        title="Forms"
        subtitle={
          <>
            Design form templates, set staff-only fields, and publish for parents.
            {user?.organization_slug ? (
              <span className="badge badge-blue" style={{ marginLeft: 10, fontSize: 11, verticalAlign: "middle" }}>
                {user.organization_slug}
              </span>
            ) : null}
          </>
        }
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              className="secondary-button"
              onClick={() => setShowArchived((v) => !v)}
              disabled={archivedForms.length === 0}
              aria-pressed={showArchived}
              title={
                archivedForms.length === 0
                  ? "No archived forms"
                  : showArchived
                    ? "Hide archived forms"
                    : "Show archived forms"
              }
            >
              {showArchived ? "Hide archived" : "Show archived"}
              {archivedForms.length > 0 ? ` (${archivedForms.length})` : ""}
            </button>
            <button className="primary-button" onClick={() => setShowNew((v) => !v)}>
              <Plus size={14} />
              New Form
            </button>
          </div>
        }
      />

      {error && (
        <div
          style={{
            background: "rgb(255,232,234)",
            color: "rgb(186,48,64)",
            padding: "10px 12px",
            borderRadius: "var(--radius)",
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      {showNew && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <h3>Create a new form</h3>
          </div>
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="filter-group" style={{ minWidth: 0 }}>
              <label>Form title</label>
              <input
                type="text"
                value={title}
                placeholder="e.g. Course Designation Form (CDM)"
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="filter-group" style={{ minWidth: 0 }}>
              <label>School (optional)</label>
              <select value={schoolId} onChange={(e) => setSchoolId(e.target.value)}>
                <option value="">All schools</option>
                {schools.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="primary-button" onClick={handleCreate} disabled={creating || !title.trim()}>
                {creating ? "Creating..." : "Create & Design"}
              </button>
              <button className="secondary-button" onClick={() => setShowNew(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="loading-state">
          <div className="spinner" /> Loading forms...
        </div>
      ) : visibleForms.length === 0 ? (
        <div className="empty-state">
          {forms.length === 0
            ? "No forms yet. Create your first form to get started."
            : "No live forms. Every form is archived — use “Show archived” to see them, then Restore the one you need."}
        </div>
      ) : (
        <div className="card">
          <table className="grid" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Submissions</th>
                <th>Created</th>
                <th style={{ width: 340 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleForms.map((f) => (
                <tr key={f.id} style={{ opacity: f.status === "archived" ? 0.6 : undefined }}>
                  <td className="cell-strong" data-label="Title">{f.title}</td>
                  <td data-label="Status">
                    <FormStatusBadge status={f.status} />
                  </td>
                  <td className="cell-mono" data-label="Submissions">{f.submission_count ?? 0}</td>
                  <td className="cell-mono" data-label="Created">{formatDate(f.created_at)}</td>
                  <td>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button className="badge-button" onClick={() => navigate(`/admin/forms/${f.id}`)}>
                        Edit
                      </button>
                      {f.status === "archived" ? (
                        // Restoring is the only sensible action on a retired form;
                        // Publish/Archive would be a no-op or immediately undone.
                        <button
                          className="badge-button"
                          onClick={() => setPending({ kind: "restore", form: f })}
                          title={`Return this form to ${formStatusBadge(f.pre_archive_status ?? "draft").label}`}
                        >
                          Restore
                        </button>
                      ) : (
                        <>
                          <button
                            className="badge-button"
                            onClick={() => togglePublish(f)}
                            title={f.status === "published" ? "Unpublish" : "Publish"}
                          >
                            {f.status === "published" ? "Unpublish" : "Publish"}
                          </button>
                          <button
                            className="badge-button"
                            onClick={() => setPending({ kind: "archive", form: f })}
                            title="Archive this form — it stops accepting submissions, but every submission is kept"
                          >
                            Archive
                          </button>
                        </>
                      )}
                      <button
                        className="badge-button"
                        onClick={() => setPending({ kind: "delete", form: f })}
                        disabled={(f.submission_count ?? 0) > 0}
                        title={
                          (f.submission_count ?? 0) > 0
                            ? `In use — ${f.submission_count} submission${f.submission_count === 1 ? "" : "s"}. Use Archive to retire it without losing data.`
                            : "Delete this form permanently"
                        }
                        style={{ color: (f.submission_count ?? 0) > 0 ? undefined : "var(--danger, #b93040)" }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pending && (
        <div className="modal-overlay open" onClick={() => !busy && setPending(null)}>
          <div className="modal" style={{ width: "min(460px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>{pendingTitle}</h2>
              <button
                className="icon-button close"
                onClick={() => setPending(null)}
                disabled={busy}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              {pending.kind === "delete" && (
                <>
                  <p style={BODY_TEXT}>
                    Delete <strong>{pending.form.title}</strong>? This cannot be undone.
                  </p>
                  <p style={BODY_HINT}>
                    This form has no submissions, so nothing else will be affected.
                  </p>
                </>
              )}

              {pending.kind === "archive" && (
                <>
                  <p style={BODY_TEXT}>
                    Archive <strong>{pending.form.title}</strong>?
                  </p>
                  <p style={BODY_HINT}>
                    It stops accepting submissions and disappears from the dashboard, staff queue and reports
                    selectors.{" "}
                    {pendingSubmissionCount === 0
                      ? "It has no submissions, so nothing else will be affected — and you can restore it at any time."
                      : `Its ${pendingSubmissionCount} submission${pendingSubmissionCount === 1 ? "" : "s"} are kept — you can restore it at any time.`}
                  </p>
                </>
              )}

              {pending.kind === "restore" && (
                <>
                  <p style={BODY_TEXT}>
                    Restore <strong>{pending.form.title}</strong>?
                  </p>
                  <p style={BODY_HINT}>
                    It returns to <strong>{formStatusBadge(pendingArchivedStatus).label}</strong>, the status it
                    held before it was archived.{" "}
                    {pendingArchivedStatus === "published"
                      ? "It was published when archived, so it will be available to parents again."
                      : "It was not published when archived, so it stays hidden from parents."}
                  </p>
                </>
              )}
            </div>
            <div className="modal-foot">
              <div className="spacer" />
              <button className="secondary-button" onClick={() => setPending(null)} disabled={busy}>
                Cancel
              </button>
              <button
                className="primary-button"
                onClick={runPending}
                disabled={busy}
                style={
                  pending.kind === "delete"
                    ? { background: "var(--danger, #b93040)", borderColor: "var(--danger, #b93040)" }
                    : undefined
                }
              >
                {busy ? busyLabel : confirmLabel}
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
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
