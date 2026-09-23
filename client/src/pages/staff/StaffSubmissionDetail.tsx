import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Lock, Archive, X } from "lucide-react";
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

// Inline styles for the delete confirmation, matching the dispatch on the admin
// dashboard and the form-delete dialog on the Forms page.
const BODY_TEXT: CSSProperties = { margin: 0, fontSize: 14, lineHeight: 1.5 };
const BODY_HINT: CSSProperties = { margin: "10px 0 0", fontSize: 13, color: "var(--text-muted)" };
// Inline rather than a class, deliberately: `.secondary-button:hover` re-colours
// the label to the brand accent, and an inline `color` is what survives that
// hover — a danger control that turns "safe blue" when you reach for it is worse
// than no colour coding at all. Same value as `.icon-btn.danger:hover`.
const DANGER = "var(--danger, #b93040)";
const DANGER_LINE = "var(--danger-line, #eec6cb)";

export default function StaffSubmissionDetail() {
  const { publicId } = useParams<{ publicId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  // Admins land here via /admin/submissions/:publicId; back should return there.
  // Staff use /staff/:publicId; back returns to the staff queue.
  const isAdmin = user?.role === "admin";
  // Archive and restore are available to every role that can reach this page.
  // The server guard takes exactly this list, and it is written out rather than
  // dropped (i.e. always true) so that a future role able to VIEW a submission —
  // a parent, a read-only auditor — does not silently gain a write path here.
  const canArchive =
    user?.role === "admin" || user?.role === "staff" || user?.role === "cdm_contact";
  // Permanent delete stays admin-only: it is the one submission action with no
  // way back, so unlike the toggle above it is worth the asymmetry with the
  // server (which is the authority — this only decides whether to render it).
  const canDelete = user?.role === "admin";
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

  // Archive/restore is a POST whose outcome depends on the row's state ON THE
  // SERVER, which this viewer may be looking at a stale copy of — so its error
  // is kept in its own slot. `.error` above is the LOAD error, and the page
  // renders it as a full replacement ("Submission not found"), so putting a 409
  // there would blank the very page the message is about.
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState("");

  // Permanent delete has its own confirm step and its own error slot, for the
  // same reason: a 409 here says the row was restored elsewhere while this page
  // still showed it as archived, and that message has to render INSIDE the
  // dialog that asked the question rather than on the page behind it.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

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

  // Archive or restore this submission. Both endpoints accept staff, school
  // contacts and admins — the same people who can see the queue — because an
  // archive only one role could reverse meant whoever put a row away could not
  // get it back. The reach is unchanged either way: the row is resolved by public
  // id (organization-scoped) and then gated on the actor's school.
  //
  // The button's LABEL is read from the row this viewer loaded, so it can be
  // stale — two people on the same submission both see "Archive". The server
  // resolves the race in the WHERE clause and answers 409 to the loser, which is
  // why a 409 reloads rather than just showing a message: the label is provably
  // wrong at that point, and re-reading is what makes the page agree with it.
  const handleArchiveToggle = async () => {
    if (!publicId || !detail) return;
    const archivingNow = !detail.archived_at;
    setArchiving(true);
    setArchiveError("");
    try {
      const updated = archivingNow
        ? await api.archiveSubmission(publicId)
        : await api.restoreSubmission(publicId);
      setDetail(updated);
      setDraft(valuesToDraft(updated.values));
      setStaffDraft(valuesToDraft(updated.values));
    } catch (err) {
      setArchiveError(
        err instanceof ApiError ? err.message : "Could not update the archive state"
      );
      if (err instanceof ApiError && err.status === 409) load();
    } finally {
      setArchiving(false);
    }
  };

  // Permanent delete. Admin-only, and the server enforces archive-first with a
  // 409 — this handler never assumes the dialog's premise still holds, because
  // the row may have been restored from another tab since the page loaded. That
  // is also why a 409 reloads: the page is showing a state the server disagrees
  // with, and it should not keep offering the button.
  const handleDelete = async () => {
    if (!publicId) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await api.deleteSubmission(publicId);
      // The page has lost its subject. Leaving it here would render either a
      // stale copy (if the load failed) or "Submission not found"; the list, which
      // re-reads on mount, is the only view that can still be right.
      navigate(isAdmin ? "/admin" : "/staff");
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Could not delete the submission");
      if (err instanceof ApiError && err.status === 409) load();
    } finally {
      setDeleting(false);
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
          {canArchive && (
            <button
              className="secondary-button"
              onClick={handleArchiveToggle}
              disabled={archiving}
            >
              {archiving
                ? detail.archived_at
                  ? "Restoring..."
                  : "Archiving..."
                : detail.archived_at
                  ? "Restore"
                  : "Archive"}
            </button>
          )}
          {/* Offered only once the row IS archived, which is the one condition the
              server also insists on. A disabled button on the active state would
              have to explain itself in a tooltip nobody hovers, and it would make
              "delete" look like a normal first move rather than the last one. */}
          {canDelete && detail.archived_at && (
            <button
              className="secondary-button"
              onClick={() => {
                setDeleteError("");
                setConfirmDelete(true);
              }}
              style={{ color: DANGER, borderColor: DANGER_LINE }}
              title="Delete this archived submission permanently"
            >
              Delete permanently
            </button>
          )}
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

      {/* Archived notice. Its own class — NOT `.banner`, which is this app's top
          navigation bar. An archived submission still opens here on purpose (the
          row was hidden, not deleted), so an arrival from a bookmark, a Webhook
          Log link or browser Back must explain itself rather than look broken.
          The lists named below are the ones that actually filter archived rows;
          the form's submission count deliberately does NOT, because the form
          delete guard has to agree with the count printed beside it.
          This block explains; it does not act. The Restore control exists once,
          in the head actions above, where it is the very button that read
          "Archive" a moment earlier — a second Restore here would be the same
          word, the same handler and the same state, two lines apart. Delete lives
          there for the same reason. */}
      {detail.archived_at && (
        <div className="archived-notice">
          <span className="an-icon" aria-hidden="true">
            <Archive size={16} />
          </span>
          <span className="an-text">
            <strong>Archived.</strong> This submission is hidden from the submissions
            list, the staff queue, exports and reports, the documents list and the login
            summary. It still appears in this form&rsquo;s submission count — archiving
            ends the row&rsquo;s life in the views, not in the database.{" "}
            {/* The claim is scoped to THIS action, and its second half is shown
                only to the person who can act on it. "Nothing was deleted" is a
                true statement about archiving; leaving it to stand alone in front
                of an admin who has a Delete button two lines up would read as a
                promise the app does not make. And telling a staff member about a
                button they are not offered is worse than saying nothing. */}
            {canDelete
              ? " Archiving deletes nothing; deleting permanently is a separate, " +
                "irreversible step, and it has to be taken from this page."
              : " Nothing was deleted."}
            {detail.archived_by_name || detail.archived_at ? (
              <>
                {" "}
                Archived
                {detail.archived_by_name ? ` by ${detail.archived_by_name}` : ""} on{" "}
                {new Date(detail.archived_at).toLocaleString()}.
              </>
            ) : null}
          </span>
        </div>
      )}

      {archiveError && <div className="alert-error">{archiveError}</div>}

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
              // `field-list--roomy` gives these textareas a taller default box and
              // `expandable` adds the Expand button. Both are scoped to THIS list:
              // the parent-answer list above holds the parent's own words and is
              // not the list being filled in on this page.
              <div className="field-list field-list--roomy">
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
                      expandable
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

      {/* Permanent-delete confirmation. The page's head button only ARMS this; the
          dialog is what names the submission and states what is left behind, so
          the press that cannot be undone is never the first press. Nothing in this
          app used `window.confirm`, and using one here would be the only prompt in
          the product that could not name its subject. */}
      {confirmDelete && detail && (
        <div
          className="modal-overlay open"
          onClick={() => !deleting && setConfirmDelete(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Delete submission permanently?</h2>
              <button
                className="icon-button close"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <p style={BODY_TEXT}>
                <strong>{detail.student_name || "This submission"}</strong> and every answer it holds
                will be removed from this database. This cannot be undone — there is no archive to
                restore it from, and no copy of the answers is kept.
              </p>
              <p style={BODY_HINT}>
                Its answers, any ad-hoc fields added to it, and its generated-document record all go
                with it. The generated Google Doc file itself is <strong>not</strong> deleted — it
                stays in the organization&rsquo;s Drive folder, and this app simply loses its link to
                it.
              </p>
              {deleteError && (
                <div className="alert-error" style={{ marginTop: 12 }}>
                  {deleteError}
                </div>
              )}
            </div>
            <div className="modal-foot">
              <span className="spacer" />
              <button
                className="secondary-button"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                onClick={handleDelete}
                disabled={deleting}
                style={{ background: DANGER, borderColor: DANGER }}
              >
                {deleting ? "Deleting..." : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
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
