import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import type { SubmissionDetail, SubmissionStatus, Comment, SubmissionValueRow, AdhocField, FieldType } from "../../types";
import { useAuth } from "../../context/AuthContext";
import { StatusBadge } from "../../components/layout";

const STATUSES: SubmissionStatus[] = ["submitted", "in_review", "flagged", "resolved"];

const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "textarea", label: "Paragraph" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "select", label: "Dropdown" },
  { value: "radio", label: "Radio" },
  { value: "checkbox", label: "Checkbox" },
  { value: "email", label: "Email" },
];

const OPTIONS_FIELD_TYPES: FieldType[] = ["select", "radio", "checkbox"];

export default function StaffSubmissionDetail() {
  const { publicId } = useParams<{ publicId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  // Admins land here via /admin/submissions/:publicId; back should return there.
  // Staff use /staff/:publicId; back returns to the staff queue.
  const isAdmin = user?.role === "admin";

  const [detail, setDetail] = useState<SubmissionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [commentText, setCommentText] = useState("");
  const [posting, setPosting] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);

  // Edit state
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<number, string | number | boolean | string[] | null>>({});
  const [saving, setSaving] = useState(false);

  // Ad-hoc field state
  const [adhocDrafts, setAdhocDrafts] = useState<Record<number, string | number | boolean | string[] | null>>({});
  const [adhocEditingId, setAdhocEditingId] = useState<number | null>(null);
  const [showComposer, setShowComposer] = useState(false);
  const [cfg, setCfg] = useState<{
    label: string;
    type: FieldType;
    options: string;
    value: string | number | boolean | string[] | null;
  }>({
    label: "",
    type: "text",
    options: "",
    value: "",
  });
  const [adhocBusy, setAdhocBusy] = useState(false);

  const load = () => {
    if (!publicId) return;
    setLoading(true);
    api
      .getSubmission(publicId)
      .then((d) => {
        setDetail(d);
        setDraft(valuesToDraft(d.values));
        setAdhocDrafts(adhocValuesToDraft(d.adhocFields));
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load submission"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicId]);

  const handleStatus = async (status: SubmissionStatus) => {
    if (!publicId || !detail || status === detail.status) return;
    setSavingStatus(true);
    setError("");
    try {
      await api.updateSubmissionStatus(publicId, status);
      setDetail((prev) => (prev ? { ...prev, status } : prev));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update status");
    } finally {
      setSavingStatus(false);
    }
  };

  const handleComment = async (e: FormEvent) => {
    e.preventDefault();
    if (!publicId || !commentText.trim()) return;
    setPosting(true);
    setError("");
    try {
      await api.addComment(publicId, commentText.trim());
      setCommentText("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add comment");
    } finally {
      setPosting(false);
    }
  };

  const startEdit = () => {
    if (!detail) return;
    setDraft(valuesToDraft(detail.values));
    setError("");
    setEditing(true);
  };

  const cancelEdit = () => {
    if (!detail) return;
    setDraft(valuesToDraft(detail.values));
    setEditing(false);
    setError("");
  };

  const setDraftValue = (fieldId: number, value: string | number | boolean | string[] | null) => {
    setDraft((prev) => ({ ...prev, [fieldId]: value }));
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!publicId || !detail) return;
    setSaving(true);
    setError("");
    try {
      const answers = detail.values.map((v) => ({
        field_id: v.field_id,
        value: draft[v.field_id] ?? v.value,
      }));
      const updated = await api.updateSubmissionValues(publicId, answers);
      setDetail(updated);
      setDraft(valuesToDraft(updated.values));
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save changes");
    } finally {
      setSaving(false);
    }
  };

  // ---- Ad-hoc staff-only field handlers ----
  const setAdhocDraftValue = (fieldId: number, value: string | number | boolean | string[] | null) => {
    setAdhocDrafts((prev) => ({ ...prev, [fieldId]: value }));
  };

  const startAdhocEdit = (f: AdhocField) => {
    const type = f.type as FieldType;
    setCfg({
      label: f.label,
      type,
      options: Array.isArray(f.options) ? f.options.join("\n") : "",
      value: f.value,
    });
    setAdhocEditingId(f.id);
    setShowComposer(true);
  };

  const cancelComposer = () => {
    setShowComposer(false);
    setAdhocEditingId(null);
    setCfg({ label: "", type: "text", options: "", value: "" });
  };

  const handleAdhocSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!publicId || !detail) return;
    if (!cfg.label.trim()) {
      setError("A field label is required.");
      return;
    }
    const options = OPTIONS_FIELD_TYPES.includes(cfg.type)
      ? cfg.options.split("\n").map((s) => s.trim()).filter((s) => s.length > 0)
      : null;
    // Parse value based on type.
    let value: string | number | boolean | string[] | null = cfg.value;
    if (cfg.type === "number" && cfg.value !== "" && typeof cfg.value === "string") value = Number(cfg.value);

    setAdhocBusy(true);
    setError("");
    try {
      const fieldId = adhocEditingId;
      if (fieldId) {
        await api.updateAdhocField(publicId, fieldId, {
          label: cfg.label,
          type: cfg.type,
          options,
          value,
        });
      } else {
        await api.createAdhocField(publicId, {
          label: cfg.label,
          type: cfg.type,
          options,
          value,
        });
      }
      const refreshed = await api.getSubmission(publicId);
      setDetail(refreshed);
      setAdhocDrafts(adhocValuesToDraft(refreshed.adhocFields));
      setShowComposer(false);
      setAdhocEditingId(null);
      setCfg({ label: "", type: "text", options: "", value: "" });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save staff field");
    } finally {
      setAdhocBusy(false);
    }
  };

  const handleAdhocDelete = async (f: AdhocField) => {
    if (!publicId) return;
    if (!window.confirm(`Delete the staff field "${f.label}"? This cannot be undone.`)) return;
    setAdhocBusy(true);
    setError("");
    try {
      await api.deleteAdhocField(publicId, f.id);
      const refreshed = await api.getSubmission(publicId);
      setDetail(refreshed);
      setAdhocDrafts(adhocValuesToDraft(refreshed.adhocFields));
      if (adhocEditingId === f.id) {
        setShowComposer(false);
        setAdhocEditingId(null);
        setCfg({ label: "", type: "text", options: "", value: "" });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete staff field");
    } finally {
      setAdhocBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="loading-state">
        <div className="spinner" /> Loading submission...
      </div>
    );
  }

  if (!detail || error) {
    return (
      <div className="empty-state">
        {error || "Submission not found."}{" "}
        <button
          className="badge-button"
          onClick={() => navigate(isAdmin ? "/admin" : "/staff")}
        >
          Back to {isAdmin ? "dashboard" : "queue"}
        </button>
      </div>
    );
  }

  const parentFields = detail.values.filter((v) => !v.staff_only);
  const staffFields = detail.values.filter((v) => v.staff_only);

  return (
    <div>
      <div className="page-head">
        <div className="title-block">
          <h1>
            {detail.form_name} Submission — {detail.student_name || "Unnamed"}
          </h1>
          <p>
            <span className="cell-mono" style={{ fontSize: 12 }}>
              {detail.public_id}
            </span>
          </p>
        </div>
        <div className="head-actions">
          <StatusBadge status={detail.status} />
          {!editing && (
            <button className="secondary-button" onClick={startEdit}>
              Edit
            </button>
          )}
          <button
            className="secondary-button"
            onClick={() => navigate(isAdmin ? "/admin" : "/staff")}
          >
            Back to {isAdmin ? "dashboard" : "queue"}
          </button>
        </div>
      </div>

      <div className="detail-layout">
        <section>
          {/* Status track */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">
              <h3>Status</h3>
            </div>
            <div className="card-body">
              <div className="status-track">
                {STATUSES.map((s) => (
                  <button
                    key={s}
                    className="badge-button"
                    disabled={savingStatus || s === detail.status}
                    onClick={() => handleStatus(s)}
                    style={
                      s === detail.status
                        ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }
                        : {}
                    }
                  >
                    {STATUS_LABEL[s]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Answers */}
          <form onSubmit={handleSave}>
            <div className="card">
              <div className="card-head">
                <h3>Submission Answers</h3>
                {editing && (
                  <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                    <button type="button" className="secondary-button" onClick={cancelEdit} disabled={saving}>
                      Cancel
                    </button>
                    <button type="submit" className="primary-button" disabled={saving}>
                      {saving ? "Saving..." : "Save changes"}
                    </button>
                  </div>
                )}
              </div>
              <div className="card-body">
                <div className="section-label">Submission</div>
                <div className="field-list" style={{ gridTemplateColumns: "1fr", gap: "8px 0" }}>
                  <div className="field">
                    <span className="f-label">Submission ID</span>
                    <span className="f-value cell-mono" style={{ fontSize: 12 }}>
                      {detail.public_id}
                    </span>
                  </div>
                  <div className="field">
                    <span className="f-label">Submission Time</span>
                    <span className="f-value cell-mono" style={{ fontSize: 12 }}>
                      {new Date(detail.submitted_at).toLocaleString()}
                    </span>
                  </div>
                </div>

                <div className="divider" />
                <div className="field-list">
                  {parentFields.map((v) => (
                    <Field
                      key={v.field_id}
                      v={v}
                      editing={editing}
                      value={editing ? (draft[v.field_id] ?? v.value) : v.value}
                      onChange={(val) => setDraftValue(v.field_id, val)}
                    />
                  ))}
                </div>

                {staffFields.length > 0 && (
                  <>
                    <div
                      className="staff-only-box"
                      style={{
                        marginTop: 16,
                        border: "1px dashed var(--accent)",
                        background: "#eff7fe",
                        borderRadius: "var(--radius)",
                        padding: "14px 16px",
                      }}
                    >
                      <div className="so-head">
                        <span className="lock-badge">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                            <rect x="4" y="11" width="16" height="10" rx="1" stroke="currentColor" strokeWidth="1.8" />
                            <path d="M8 11V7a4 4 0 018 0v4" stroke="currentColor" strokeWidth="1.8" />
                          </svg>
                          Staff only
                        </span>
                      </div>
                      <div className="field-list">
                        {staffFields.map((v) => (
                          <Field
                            key={v.field_id}
                            v={v}
                            editing={editing}
                            value={editing ? (draft[v.field_id] ?? v.value) : v.value}
                            onChange={(val) => setDraftValue(v.field_id, val)}
                          />
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </form>

          {/* Ad-hoc staff-only fields */}
          <div className="staff-only-box" style={{ marginTop: 16 }}>
            <div className="so-head">
              <span className="lock-badge">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <rect x="4" y="11" width="16" height="10" rx="1" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M8 11V7a4 4 0 018 0v4" stroke="currentColor" strokeWidth="1.8" />
                </svg>
                Staff-only fields
              </span>
              <button
                type="button"
                className="badge-button"
                onClick={() => {
                  setShowComposer((s) => !s);
                  setAdhocEditingId(null);
                }}
                disabled={adhocBusy}
              >
                + Add field
              </button>
            </div>
            <div className="field-list" style={{ marginTop: 10 }}>
              {detail.adhocFields.length === 0 && !showComposer && (
                <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
                  No staff-only fields yet. Add one to capture extra info for this submission.
                </div>
              )}
              {detail.adhocFields.map((f) => (
                <div className="adhoc-field" key={f.id}>
                  <div className="af-head">
                    <span className="af-label">{f.label}</span>
                    <div className="af-actions">
                      <button type="button" className="icon-btn" title="Edit" onClick={() => startAdhocEdit(f)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                          <path d="M4 20h4l10-10-4-4L4 16v4z" stroke="currentColor" strokeWidth="1.8" />
                        </svg>
                      </button>
                      <button type="button" className="icon-btn danger" title="Delete" onClick={() => handleAdhocDelete(f)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                          <path d="M4 7h16M9 7V5h6v2M6 7l1 12h10l1-12" stroke="currentColor" strokeWidth="1.8" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <Field
                    v={{
                      id: f.id,
                      submission_id: f.submission_id,
                      field_id: f.id,
                      field_label: f.label,
                      field_type: f.type,
                      options: f.options,
                      staff_only: true,
                      value: f.value,
                    }}
                    editing={false}
                    value={adhocDrafts[f.id] ?? f.value}
                    onChange={(val) => setAdhocDraftValue(f.id, val)}
                  />
                </div>
              ))}
            </div>

            {showComposer && (
              <form className="adhoc-composer" onSubmit={handleAdhocSubmit}>
                <div className="composer-grid">
                  <div className="full">
                    <label className="cf">
                      Label
                      <input
                        className="edit-input"
                        value={cfg.label}
                        onChange={(e) => setCfg((c) => ({ ...c, label: e.target.value }))}
                        placeholder="e.g. Additional notes"
                        required
                      />
                    </label>
                  </div>
                  <div>
                    <label className="cf">
                      Type
                      <select
                        className="edit-select"
                        value={cfg.type}
                        onChange={(e) => setCfg((c) => ({ ...c, type: e.target.value as FieldType }))}
                      >
                        {FIELD_TYPES.map((ft) => (
                          <option key={ft.value} value={ft.value}>
                            {ft.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {OPTIONS_FIELD_TYPES.includes(cfg.type) && (
                    <div className="full">
                      <label className="cf">
                        Options (one per line)
                        <textarea
                          className="edit-textarea"
                          value={cfg.options}
                          onChange={(e) => setCfg((c) => ({ ...c, options: e.target.value }))}
                          rows={3}
                        />
                      </label>
                      {cfg.options
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean).length > 0 && (
                        <label className="cf">
                          Value
                          {renderEditor(
                            cfg.type,
                            cfg.options.split("\n").map((s) => s.trim()).filter(Boolean),
                            cfg.value,
                            (val) => setCfg((c) => ({ ...c, value: val })),
                            "adhoc-composer-value"
                          )}
                        </label>
                      )}
                    </div>
                  )}
                  {!OPTIONS_FIELD_TYPES.includes(cfg.type) && (
                    <div className="full">
                      <label className="cf">
                        Value
                        {cfg.type === "textarea" ? (
                          <textarea
                            className="edit-textarea"
                            value={toStr(cfg.value)}
                            onChange={(e) => setCfg((c) => ({ ...c, value: e.target.value }))}
                            rows={3}
                          />
                        ) : (
                          <input
                            className="edit-input"
                            type={cfg.type === "number" ? "number" : cfg.type === "date" ? "date" : cfg.type === "email" ? "email" : "text"}
                            value={toStr(cfg.value)}
                            onChange={(e) => setCfg((c) => ({ ...c, value: e.target.value }))}
                          />
                        )}
                      </label>
                    </div>
                  )}
                </div>
                <div className="field-actions">
                  <button type="submit" className="primary-button" disabled={adhocBusy}>
                    {adhocBusy ? "Saving..." : adhocEditingId ? "Save changes" : "Add field"}
                  </button>
                  <button type="button" className="secondary-button" onClick={cancelComposer} disabled={adhocBusy}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </section>

        {/* Right panel: submission metadata */}
        <aside style={{ position: "sticky", top: 20 }}>
          <div className="card">
            <div className="card-head">
              <h3>Submission detail</h3>
              <span className="badge badge-orange" style={{ marginLeft: "auto" }}>
                {detail.form_name}
              </span>
            </div>
            <div className="card-body">
              <div className="section-label">Submission</div>
              <div className="field-list" style={{ gridTemplateColumns: "1fr", gap: "8px 0" }}>
                <div className="field">
                  <span className="f-label">Submission ID</span>
                  <span className="f-value cell-mono" style={{ fontSize: 12 }}>
                    {detail.public_id}
                  </span>
                </div>
                <div className="field">
                  <span className="f-label">Submission Time</span>
                  <span className="f-value cell-mono" style={{ fontSize: 12 }}>
                    {new Date(detail.submitted_at).toLocaleString()}
                  </span>
                </div>
              </div>

              <div className="divider" />
              <div className="section-label">Key fields</div>
              <div className="field-list" style={{ gridTemplateColumns: "1fr", gap: "10px 0" }}>
                {parentFields.slice(0, 5).map((v) => (
                  <div className="field" key={v.field_id}>
                    <span className="f-label">{v.field_label}</span>
                    <span className="f-value">{formatValue(v.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* Comment thread (full width at the bottom) */}
      <div style={{ marginTop: 18 }}>
        <div className="card">
          <div className="card-head">
            <h3>Staff comments</h3>
            <span className="lock-tag" style={{ marginLeft: "auto" }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <rect x="4" y="11" width="16" height="10" rx="1" stroke="currentColor" strokeWidth="1.8" />
                <path d="M8 11V7a4 4 0 018 0v4" stroke="currentColor" strokeWidth="1.8" />
              </svg>
              Staff only
            </span>
          </div>
          <div className="card-body">
            <div className="comment-thread">
              {detail.comments.length === 0 ? (
                <div className="muted-note">No staff comments yet.</div>
              ) : (
                detail.comments.map((c: Comment) => (
                  <div
                    className={`comment ${c.staff_name === user?.display_name ? "comment-mine" : ""}`}
                    key={c.id}
                  >
                    <div className="c-head">
                      <span className="lock-tag">Internal</span>
                      <span className="c-name">{c.staff_name || "Staff"}</span>
                      <span className="c-time">
                        {new Date(c.created_at).toLocaleString([], {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <div className="c-body">{c.body}</div>
                  </div>
                ))
              )}
            </div>

            <form className="new-comment" onSubmit={handleComment} style={{ marginTop: 12 }}>
              <textarea
                placeholder="Add a staff-only comment..."
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
              />
              <div className="row">
                <span className="lock-tag">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                    <rect x="4" y="11" width="16" height="10" rx="1" stroke="currentColor" strokeWidth="1.8" />
                    <path d="M8 11V7a4 4 0 018 0v4" stroke="currentColor" strokeWidth="1.8" />
                  </svg>
                  Only staff can see this
                </span>
                <div className="spacer" />
                <button type="submit" className="primary-button" disabled={posting || !commentText.trim()}>
                  {posting ? "Posting..." : "Post comment"}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editable field renderer
// ---------------------------------------------------------------------------
function Field({
  v,
  editing,
  value,
  onChange,
}: {
  v: SubmissionValueRow;
  editing: boolean;
  value: string | number | boolean | string[] | null;
  onChange: (val: string | number | boolean | string[] | null) => void;
}) {
  const { field_type: type, field_label: label, options } = v;

  if (!editing) {
    return (
      <div className="field">
        <span className="f-label">{label}</span>
        <span className={`f-value ${isEmpty(value) ? "empty" : ""}`}>{formatValue(value)}</span>
      </div>
    );
  }

  return (
    <div className="field">
      <span className="f-label">{label}</span>
      {renderEditor(type, options, value, onChange, `radio-${v.field_id}`)}
    </div>
  );
}

function renderEditor(
  type: string,
  options: string[] | null,
  value: string | number | boolean | string[] | null,
  onChange: (val: string | number | boolean | string[] | null) => void,
  radioName: string
): ReactNode {
  switch (type) {
    case "textarea":
      return (
        <textarea
          className="edit-textarea"
          value={toStr(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "number":
      return (
        <input
          className="edit-input"
          type="number"
          value={toStr(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        />
      );
    case "date":
      return (
        <input
          className="edit-input"
          type="date"
          value={toStr(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        />
      );
    case "email":
      return (
        <input
          className="edit-input"
          type="email"
          value={toStr(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "select":
      return (
        <select className="edit-select" value={toStr(value)} onChange={(e) => onChange(e.target.value)}>
          <option value="">— Select —</option>
          {(options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case "radio":
      return (
        <div className="f-value inline">
          {(options ?? []).map((o) => (
            <label key={o} style={{ display: "inline-flex", alignItems: "center", gap: 5, marginRight: 10 }}>
              <input
                type="radio"
                name={radioName}
                checked={toStr(value) === o}
                onChange={() => onChange(o)}
              />
              {o}
            </label>
          ))}
        </div>
      );
    case "checkbox":
      return (
        <div className="f-value inline">
          {(options ?? []).map((o) => {
            const arr = Array.isArray(value) ? value : [];
            const checked = arr.includes(o);
            return (
              <label key={o} style={{ display: "inline-flex", alignItems: "center", gap: 5, marginRight: 10 }}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    const next = e.target.checked ? [...arr, o] : arr.filter((x) => x !== o);
                    onChange(next);
                  }}
                />
                {o}
              </label>
            );
          })}
        </div>
      );
    default:
      return (
        <input
          className="edit-input"
          type="text"
          value={toStr(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

const STATUS_LABEL: Record<SubmissionStatus, string> = {
  submitted: "Submitted",
  in_review: "In Review",
  flagged: "Flagged",
  resolved: "Resolved",
};

function valuesToDraft(values: SubmissionValueRow[]): Record<number, string | number | boolean | string[] | null> {
  const d: Record<number, string | number | boolean | string[] | null> = {};
  for (const v of values) d[v.field_id] = v.value;
  return d;
}

function adhocValuesToDraft(fields: AdhocField[]): Record<number, string | number | boolean | string[] | null> {
  const d: Record<number, string | number | boolean | string[] | null> = {};
  for (const f of fields) d[f.id] = f.value;
  return d;
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

function toStr(v: string | number | boolean | string[] | null): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "Not provided";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}
