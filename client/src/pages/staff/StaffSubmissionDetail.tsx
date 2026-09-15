import { useEffect, useState, type FormEvent } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Lock } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import type { SubmissionDetail, SubmissionStatus, SubmissionValueRow } from "../../types";
import { useAuth } from "../../context/AuthContext";
import { useDocumentsEnabled } from "../../lib/useDocumentsEnabled";
import { PdfViewerDrawer } from "../../components/PdfViewer";
// The label/value renderer and all of the value helpers are shared with the
// admin Submissions grid (which renders the same staff-only fields inline), so
// there is exactly one type -> control mapping in the app.
import { FieldValue, valuesToDraft } from "../../components/FieldValue";

const STATUSES: SubmissionStatus[] = ["submitted", "in_review", "flagged", "completed"];

export default function StaffSubmissionDetail() {
  const { publicId } = useParams<{ publicId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  // Admins land here via /admin/submissions/:publicId; back should return there.
  // Staff use /staff/:publicId; back returns to the staff queue.
  const isAdmin = user?.role === "admin";
  // The generated-document line below (document link, status badge, View PDF) is
  // part of the Documents feature, so it follows the `documents_link` setting
  // rather than a hardcoded role — a role with Documents turned off (e.g. the
  // School Contact) doesn't see it, and an admin who enables Documents for a
  // role gets it back without a code change.
  const showDocuments = useDocumentsEnabled(user?.role);

  const [detail, setDetail] = useState<SubmissionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingStatus, setSavingStatus] = useState(false);

  // Edit state
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<number, string | number | boolean | string[] | null>>({});
  const [saving, setSaving] = useState(false);

  // Always-editable staff-only fields (the form's staff_only form_fields)
  const [staffDraft, setStaffDraft] = useState<Record<number, string | number | boolean | string[] | null>>({});
  const [savingStaff, setSavingStaff] = useState(false);

  // Right slide-out PDF preview for a generated document.
  const [previewDoc, setPreviewDoc] = useState<SubmissionDetail["documents"][number] | null>(null);
  const [previewRefreshKey, setPreviewRefreshKey] = useState(0);

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

  // While a generated document is still in progress, poll quietly so the UI
  // advances to the final message (generated / failed) as soon as generation
  // completes — without interrupting any in-progress edits.
  const anyPendingDocument = detail?.documents?.some((d) => d.status === "Pending") ?? false;
  useEffect(() => {
    if (!anyPendingDocument || !publicId) return;
    const timer = window.setInterval(() => {
      api
        .getSubmission(publicId)
        .then((d) => setDetail(d))
        .catch(() => {
          // Keep polling; a transient error shouldn't strand the spinner.
        });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [anyPendingDocument, publicId]);

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

  // Re-run generation for a Failed document. Fire-and-forget on the server, so
  // we optimistically set the row to Pending and re-fetch to see the outcome.
  const handleRetryDocument = async (id: number) => {
    if (!publicId) return;
    setError("");
    try {
      const refreshed = await api.retryDocument(id);
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              documents: prev.documents.map((d) => (d.id === id ? refreshed : d)),
            }
          : prev
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not retry document generation");
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
          <label
            htmlFor="submission-status"
            style={{ fontSize: 15, fontWeight: 600, color: "var(--text-muted)" }}
          >
            Select Status
          </label>
          <select
            id="submission-status"
            className="edit-select status-select"
            value={detail.status}
            disabled={savingStatus}
            onChange={(e) => handleStatus(e.target.value as SubmissionStatus)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
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
                  <div className="field">
                    <span className="f-label">School Year</span>
                    <span className="f-value">
                      {detail.school_year || "—"}
                    </span>
                  </div>
                </div>

                <div className="divider" />
                <div className="field-list">
                  {parentFields.map((f) => {
                    const existing = valuesByField.get(f.id);
                    const value = editing ? (draft[f.id] ?? existing?.value ?? null) : (existing?.value ?? null);
                    return (
                      <FieldValue
                        key={f.id}
                        v={{
                          field_id: f.id,
                          field_label: f.label,
                          field_type: f.type,
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
              <Lock size={12} />
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
                    <FieldValue
                      key={f.id}
                      v={{
                        field_id: f.id,
                        field_label: f.label,
                        field_type: f.type,
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

            {showDocuments && detail.documents && detail.documents.length > 0 && (
              <div style={{ marginTop: 12 }}>
                {detail.documents.map((doc) => (
                  <div className="muted-note" key={doc.id} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span>
                      {doc.status === "Pending" ? (
                        <>
                          <span className="spinner spinner-sm" aria-hidden="true" />{" "}
                          document generation in progress
                        </>
                      ) : (
                        <>
                          Document{" "}
                          {doc.document_id ? (
                            <a
                              href={`https://docs.google.com/document/d/${doc.document_id}/edit`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="link-name"
                            >
                              generated
                            </a>
                          ) : (
                            <span>[failed]</span>
                          )}{" "}
                          on {new Date(doc.created_at).toLocaleString()}
                        </>
                      )}
                    </span>
                    <span className={`badge ${docStatusBadge(doc.status).cls}`}>
                      {docStatusBadge(doc.status).label}
                    </span>
                    {doc.document_id && doc.status === "Completed" && (
                      <button
                        className="badge-button"
                        onClick={() => {
                          setPreviewDoc(doc);
                          setPreviewRefreshKey(0);
                        }}
                      >
                        View PDF
                      </button>
                    )}
                    {doc.status === "Failed" && (
                      <button className="badge-button" onClick={() => handleRetryDocument(doc.id)}>
                        Retry
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right slide-out PDF preview */}
      {previewDoc && (
        <PdfViewerDrawer
          title="Document Preview"
          documentRowId={previewDoc.id}
          refreshKey={previewRefreshKey}
          onClose={() => setPreviewDoc(null)}
        />
      )}
    </div>
  );
}

const STATUS_LABEL: Record<SubmissionStatus, string> = {
  submitted: "Submitted",
  in_review: "In Review",
  flagged: "Flagged",
  completed: "Completed",
};

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
