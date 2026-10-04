import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Lock, Archive, Plus, X } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import type { AdhocField, SubmissionDetail, SubmissionStatus, SubmissionValueRow } from "../../types";
import { useAuth } from "../../context/AuthContext";
import { useDocumentsEnabled } from "../../lib/useDocumentsEnabled";
import { PdfViewerDrawer } from "../../components/PdfViewer";
// The label/value renderer and all of the value helpers are shared with the
// admin Submissions grid (which renders the same staff-only fields inline), so
// there is exactly one type -> control mapping in the app.
import { FieldValue, valuesToDraft } from "../../components/FieldValue";

const STATUSES: SubmissionStatus[] = ["submitted", "in_review", "flagged", "completed"];

// The labels that identify a form's "which school?" field — kept in step with the
// server's SCHOOL_FIELD_LABELS (server/src/db/dialect/shared.ts). Used to place
// the "Matched with <school> by <admin>" note under the school ANSWER, which is
// the parent's own words and is never rewritten
// (docs/plans/school-name-reconciliation.md §17).
const SCHOOL_FIELD_LABELS = ["school", "school name"];
function isSchoolFieldLabel(label: string): boolean {
  return SCHOOL_FIELD_LABELS.includes(label.trim().toLowerCase());
}

// Inline styles for the delete confirmation, matching the dispatch on the admin
// dashboard and the form-delete dialog on the Forms page.
const BODY_TEXT: CSSProperties = { margin: 0, fontSize: "0.875rem", lineHeight: 1.5 };
const BODY_HINT: CSSProperties = { margin: "10px 0 0", fontSize: "0.8125rem", color: "var(--text-muted)" };
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

  // Promote a captured question to a REAL form field (docs/plans/
  // google-form-undefined-fields.md §11). It writes the form's definition AND
  // rewrites the same question on the form's other submissions, so it gets the
  // same treatment as permanent delete: its own confirm step and its own error
  // slot, so a failure renders inside the dialog that asked the question rather
  // than behind it. `promoteNotice` is the success message, and it carries the
  // migrated count — the number that makes the action worth taking after the fact.
  const [promoteTarget, setPromoteTarget] = useState<AdhocField | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState("");
  const [promoteNotice, setPromoteNotice] = useState("");

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

  // Promote one captured question into the form's definition. The server also
  // migrates the SAME question title on the form's other submissions and answers
  // with the count — which is the number worth reporting, because it is the whole
  // reason to define the field after the fact rather than upfront.
  //
  // No optimistic path: the captured row disappears and a real value appears,
  // which is two changes to two arrays in the payload. The response carries the
  // re-read submission, so the page is rebuilt from the server's answer rather
  // than from a guess about what moved.
  const handlePromote = async () => {
    if (!publicId || !promoteTarget) return;
    setPromoting(true);
    setPromoteError("");
    try {
      const result = await api.promoteAdhocField(publicId, promoteTarget.id);
      setDetail(result.submission);
      setDraft(valuesToDraft(result.submission.values));
      setStaffDraft(valuesToDraft(result.submission.values));
      const n = result.migrated_submissions;
      setPromoteNotice(
        `"${result.field.label}" is now a form field. ${n} submission${n === 1 ? "" : "s"} ` +
          `migrated. Future responses with this question title will be stored in it automatically.`
      );
      setPromoteTarget(null);
    } catch (err) {
      setPromoteError(err instanceof ApiError ? err.message : "Could not promote the field");
    } finally {
      setPromoting(false);
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
            <span className="cell-mono" style={{ fontSize: "0.75rem" }}>
              {detail.public_id}
            </span>
          </p>
        </div>
        <div className="head-actions">
          <label
            htmlFor="submission-status"
            style={{ fontSize: "0.9375rem", fontWeight: 600, color: "var(--text-muted)" }}
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
                    // The school ANSWER keeps the parent's own words. When an admin
                    // has matched that exact spelling to an app school, say so
                    // underneath instead of rewriting the answer.
                    const match = detail.school_match;
                    const showMatchNote =
                      match != null &&
                      isSchoolFieldLabel(f.label) &&
                      typeof value === "string" &&
                      value.trim().toLowerCase() === match.declared_name.trim().toLowerCase();
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
                        note={
                          showMatchNote && match ? (
                            <span className="field-note">
                              Matched with <strong>{match.school_name}</strong>
                              {match.matched_by_name ? ` by ${match.matched_by_name}` : ""}.
                            </span>
                          ) : null
                        }
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          </form>
        </section>
      </div>

      {/* Captured fields (docs/plans/google-form-undefined-fields.md §7).

          A question a Google Form asked that was never defined in this form's
          designer is stored as a per-submission text field, so the answer lands
          instead of being rejected. Nothing else in the app renders these —
          grids and reports build their columns from the form definition — so
          without this card the captured data would be invisible.

          Read-only on purpose: these rows are the parent's own words preserved
          verbatim, not a staff working area (the form's own staff-only fields,
          below, are that). `created_by === null` is what marks a row as captured
          rather than authored here, which is why the note can name its source
          honestly instead of implying a colleague typed it. */}
      {detail.adhocFields.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div className="card">
            <div className="card-head">
              <h3>Additional fields</h3>
              <span className="sub">Extra questions captured from the Google Form</span>
              <span className="lock-tag" style={{ marginLeft: "auto" }}>
                <Lock size={12} />
                Staff only
              </span>
            </div>
            <div className="card-body">
              {promoteNotice && (
                <div className="alert-success" role="status">
                  {promoteNotice}
                </div>
              )}
              <div className="field-list">
                {detail.adhocFields.map((f) => (
                  // A row rather than bare FieldValues: promoting is per-question,
                  // so the control has to belong to exactly one row. The flex
                  // wrapper is inline because there is no `.adhoc-row` in the
                  // stylesheet and this needs no more than that.
                  <div
                    key={f.id}
                    style={{ display: "flex", alignItems: "flex-start", gap: 12 }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <FieldValue
                        v={{
                          field_id: f.id,
                          field_label: f.label,
                          field_type: f.type,
                          options: f.options,
                        }}
                        editing={false}
                        value={f.value}
                        onChange={() => {}}
                      />
                    </div>
                    {/* Admin-only: this writes the form's DEFINITION, which every
                        other route guards with `admin`. The server enforces it too,
                        so hiding the button is a courtesy, not the control. */}
                    {isAdmin && (
                      <button
                        type="button"
                        className="secondary-button"
                        style={{ flexShrink: 0 }}
                        onClick={() => {
                          setPromoteError("");
                          setPromoteNotice("");
                          setPromoteTarget(f);
                        }}
                        title="Add this question to the form as a real field, so future responses are stored in it"
                      >
                        <Plus size={14} />
                        Promote
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {detail.adhocFields.some((f) => f.created_by === null) && (
                <div className="muted-note" style={{ marginTop: 12 }}>
                  Captured from the Google Form — these questions have no matching field in this
                  form&rsquo;s design, so their answers are kept here on this submission.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

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

      {/* Promote confirmation. Adding a field to a SHARED form and rewriting other
          people's submissions is not an action to take on one click, so the card's
          button only ARMS this; the dialog states both effects before either
          happens. Nothing in this app used `window.confirm`, and a native prompt
          could not name the field or the form it is about to change. */}
      {promoteTarget && detail && (
        <div
          className="modal-overlay open"
          onClick={() => !promoting && setPromoteTarget(null)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Make this a real form field?</h2>
              <button
                className="icon-button close"
                onClick={() => setPromoteTarget(null)}
                disabled={promoting}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <p style={BODY_TEXT}>
                A field named <strong>{promoteTarget.label}</strong> will be added to{" "}
                <strong>{detail.form_name}</strong>, and this answer will be moved into it.
              </p>
              <p style={BODY_HINT}>
                Every other submission of this form with the same question title is migrated too,
                and the captured copies are removed so the answer is not shown twice. Future
                responses carrying this title will be stored in the field automatically — the Google
                Form itself needs no change.
              </p>
              {promoteError && (
                <div className="alert-error" style={{ marginTop: 12 }}>
                  {promoteError}
                </div>
              )}
            </div>
            <div className="modal-foot">
              <span className="spacer" />
              <button
                className="secondary-button"
                onClick={() => setPromoteTarget(null)}
                disabled={promoting}
              >
                Cancel
              </button>
              <button className="primary-button" onClick={handlePromote} disabled={promoting}>
                {promoting ? "Promoting..." : "Promote to form field"}
              </button>
            </div>
          </div>
        </div>
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
