import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, X } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import type { Form } from "../../types";
import { PageHead, FormStatusBadge } from "../../components/layout";
import { useAuth } from "../../context/AuthContext";

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
  const [deleteTarget, setDeleteTarget] = useState<Form | null>(null);
  const [deleting, setDeleting] = useState(false);

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

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setError("");
    try {
      await api.deleteForm(deleteTarget.id);
      setDeleteTarget(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete form");
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

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
          <button className="primary-button" onClick={() => setShowNew((v) => !v)}>
            <Plus size={14} />
            New Form
          </button>
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
      ) : forms.length === 0 ? (
        <div className="empty-state">No forms yet. Create your first form to get started.</div>
      ) : (
        <div className="card">
          <table className="grid" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Submissions</th>
                <th>Created</th>
                <th style={{ width: 260 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {forms.map((f) => (
                <tr key={f.id}>
                  <td className="cell-strong" data-label="Title">{f.title}</td>
                  <td data-label="Status">
                    <FormStatusBadge status={f.status} />
                  </td>
                  <td className="cell-mono" data-label="Submissions">{f.submission_count ?? 0}</td>
                  <td className="cell-mono" data-label="Created">{formatDate(f.created_at)}</td>
                  <td>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="badge-button" onClick={() => navigate(`/admin/forms/${f.id}`)}>
                        Edit
                      </button>
                      <button
                        className="badge-button"
                        onClick={() => togglePublish(f)}
                        title={f.status === "published" ? "Unpublish" : "Publish"}
                      >
                        {f.status === "published" ? "Unpublish" : "Publish"}
                      </button>
                      <button
                        className="badge-button"
                        onClick={() => setDeleteTarget(f)}
                        disabled={(f.submission_count ?? 0) > 0}
                        title={
                          (f.submission_count ?? 0) > 0
                            ? `In use — ${f.submission_count} submission${f.submission_count === 1 ? "" : "s"}`
                            : "Delete this form"
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

      {deleteTarget && (
        <div className="modal-overlay open" onClick={() => !deleting && setDeleteTarget(null)}>
          <div className="modal" style={{ width: "min(460px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Delete form</h2>
              <button
                className="icon-button close"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
                Delete <strong>{deleteTarget.title}</strong>? This cannot be undone.
              </p>
              <p style={{ margin: "10px 0 0", fontSize: 13, color: "var(--text-muted)" }}>
                This form has no submissions, so nothing else will be affected.
              </p>
            </div>
            <div className="modal-foot">
              <div className="spacer" />
              <button className="secondary-button" onClick={() => setDeleteTarget(null)} disabled={deleting}>
                Cancel
              </button>
              <button
                className="primary-button"
                onClick={confirmDelete}
                disabled={deleting}
                style={{ background: "var(--danger, #b93040)", borderColor: "var(--danger, #b93040)" }}
              >
                {deleting ? "Deleting..." : "Delete"}
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
