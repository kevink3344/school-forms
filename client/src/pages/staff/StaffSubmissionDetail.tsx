import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import type { SubmissionDetail, SubmissionStatus, Comment, SubmissionValueRow } from "../../types";
import { useAuth } from "../../context/AuthContext";
import { StatusBadge } from "../../components/layout";

const STATUSES: SubmissionStatus[] = ["submitted", "in_review", "flagged", "resolved"];

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

  // Always-editable staff-only fields (the form's staff_only form_fields)
  const [staffDraft, setStaffDraft] = useState<Record<number, string | number | boolean | string[] | null>>({});
  const [savingStaff, setSavingStaff] = useState(false);

  const load = () => {
    if (!publicId) return;
    setLoading(true);
    api
      .getSubmission(publicId)
      .then((d) => {
        setDetail(d);
        setDraft(valuesToDraft(d.values));
        setStaffDraft(valuesToDraft(d.values));
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
      // Persist every parent field (including optional ones that had no stored
      // value yet), so newly-filled fields are saved.
      const answers = detail.parentFields.map((f) => {
        const existing = detail.values.find((v) => v.field_id === f.id);
        return {
          field_id: f.id,
          value: draft[f.id] ?? existing?.value ?? null,
        };
      });
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

  // Persist the always-editable staff-only fields (form's staff_only form_fields).
  const handleSaveStaff = async () => {
    if (!publicId || !detail) return;
    setSavingStaff(true);
    setError("");
    try {
      const answers = detail.staffOnlyFields.map((f) => ({
        field_id: f.id,
        value: staffDraft[f.id] ?? null,
      }));
      await api.updateSubmissionValues(publicId, answers, { staffOnly: true });
      const refreshed = await api.getSubmission(publicId);
      setDetail(refreshed);
      setStaffDraft(valuesToDraft(refreshed.values));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save staff-only fields");
    } finally {
      setSavingStaff(false);
    }
  };

  const setStaffDraftValue = (fieldId: number, value: string | number | boolean | string[] | null) => {
    setStaffDraft((prev) => ({ ...prev, [fieldId]: value }));
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

  const parentFields = detail.parentFields;

  // Build a value lookup across the submission's stored values.
  const valuesByField = new Map<number, SubmissionValueRow>();
  for (const v of detail.values) valuesByField.set(v.field_id, v);

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
                <div className="field-list" style={{ gridTemplateColumns: "1fr", gap: "8px 0" }}>
                  <div className="field">
                    <span className="f-label">Submission ID</span>
                    <span className="f-value">
                      {detail.public_id}
                    </span>
                  </div>
                  <div className="field">
                    <span className="f-label">Submission Time</span>
                    <span className="f-value">
                      {new Date(detail.submitted_at).toLocaleString()}
                    </span>
                  </div>
                </div>

                <div className="divider" />
                <div className="field-list">
                  {parentFields.map((f) => {
                    const existing = valuesByField.get(f.id);
                    const value = editing ? (draft[f.id] ?? existing?.value ?? null) : (existing?.value ?? null);
                    return (
                      <Field
                        key={f.id}
                        v={{
                          id: existing?.id ?? f.id,
                          submission_id: detail.id,
                          field_id: f.id,
                          value,
                          field_label: f.label,
                          field_type: f.type,
                          staff_only: false,
                          options: f.options,
                        }}
                        editing={editing}
                        value={value}
                        onChange={(val) => setDraftValue(f.id, val)}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          </form>
        </section>
      </div>

      {/* Staff-only fields — always editable (the form's staff_only form fields) */}
      <div style={{ marginTop: 18 }}>
        <div className="card">
          <div className="card-head">
            <h3>Staff-only fields</h3>
            <span className="sub">Fill in the values for this submission</span>
            <span className="lock-tag" style={{ marginLeft: "auto" }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <rect x="4" y="11" width="16" height="10" rx="1" stroke="currentColor" strokeWidth="1.8" />
                <path d="M8 11V7a4 4 0 018 0v4" stroke="currentColor" strokeWidth="1.8" />
              </svg>
              Staff only
            </span>
          </div>
          <div className="card-body">
            {detail.staffOnlyFields.length === 0 ? (
              <div className="muted-note">This form has no staff-only fields defined.</div>
            ) : (
              <div className="field-list">
                {detail.staffOnlyFields.map((f) => {
                  const existing = detail.values.find((v) => v.field_id === f.id);
                  return (
                    <Field
                      key={f.id}
                      v={{
                        id: existing?.id ?? f.id,
                        submission_id: detail.id,
                        field_id: f.id,
                        value: staffDraft[f.id] ?? existing?.value ?? null,
                        field_label: f.label,
                        field_type: f.type,
                        staff_only: true,
                        options: f.options,
                      }}
                      editing={true}
                      value={staffDraft[f.id] ?? existing?.value ?? null}
                      onChange={(val) => setStaffDraftValue(f.id, val)}
                    />
                  );
                })}
              </div>
            )}

            {detail.staffOnlyFields.length > 0 && (
              <div className="field-actions" style={{ marginTop: 14 }}>
                <button
                  type="button"
                  className="primary-button"
                  onClick={handleSaveStaff}
                  disabled={savingStaff}
                >
                  {savingStaff ? "Saving..." : "Save staff fields"}
                </button>
              </div>
            )}

            {detail.staff_fields_updated_by_name && detail.staff_fields_updated_at && (
              <div className="muted-note" style={{ marginTop: 12 }}>
                Last saved by <strong>{detail.staff_fields_updated_by_name}</strong> on{" "}
                {new Date(detail.staff_fields_updated_at).toLocaleString()}
              </div>
            )}
          </div>
        </div>
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

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

function toStr(v: string | number | boolean | string[] | null): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function formatValue(v: unknown): string {
  // Unanswered optional fields (e.g. "Course choice #3 (optional)") should render
  // as blank rather than a placeholder, per the product requirement.
  if (v === null || v === undefined || v === "") return "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}
