import { useRef, useState } from "react";
import { Paperclip, Lock, X, ExternalLink, Upload, AlertTriangle, Link2 } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { useBodyScrollLock } from "../lib/useBodyScrollLock";
import type { SubmissionAttachment, SubmissionLink } from "../types";

// -----------------------------------------------------------------------------
// Staff Attachments card (docs/plans/staff-attachments.md §6.2).
//
// Rendered below the Staff-only fields card on the submission detail page, and
// ONLY when the server says this viewer may use it — the parent decides that from
// `attachments_can_upload` / `attachments_folder_valid` / `attachments_enabled`,
// so this component never re-derives the access rule.
//
// Layout order is the brief verbatim: the "+ Attachment" control first, then the
// list of uploaded files BELOW it.
//
// ★ There is deliberately NO client-side size check. The server imposes none
// either — but the hosting platform cuts any request at 230 seconds, so a very
// large video on a slow link fails. That failure is reported as something the
// user can act on ("try a smaller file") rather than as a generic error.
// -----------------------------------------------------------------------------

const MAX_ATTACHMENTS = 10;

/**
 * The brief's rule for a Link URL: it must begin with `https://`.
 *
 * ★ Mirrors `isHttpsUrl` in `server/src/schemas.ts` — the same prefix check plus
 * the same `new URL()` host check, so the panel cannot accept something the
 * server will refuse (or the reverse). The server is still the authority; this
 * copy exists so the message appears next to the field the user is typing in.
 */
function isHttpsUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!/^https:\/\//i.test(trimmed)) return false;
  if (trimmed.length > 2048) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

const HTTPS_MESSAGE = "Link URL must begin with https://";

/**
 * Open one attachment.
 *
 * ★ Mints the link on click rather than rendering it into the href. The link is
 * a 10-minute, single-file token, so a page left open for an hour still works —
 * and the URL never carries the session credential.
 *
 * ★ The tab is opened AFTER the link arrives, not as a blank tab that is then
 * navigated. A `window.open("", "_blank")` tab is cross-origin-ish enough that
 * assigning `tab.location.href` is blocked in some browsers, which left the tab
 * sitting on about:blank and looked like "nothing happens". Minting first and
 * opening second avoids that entirely; the click handler keeps the user gesture
 * alive across the await, so pop-up blockers still allow it.
 */
async function openAttachment(publicId: string, attachmentId: number) {
  const url = await api.getAttachmentLink(publicId, attachmentId);
  const tab = window.open(url, "_blank");
  // A blocked pop-up returns null. Fall back to the same tab so the file still
  // opens rather than the click silently doing nothing.
  if (!tab) window.location.href = url;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function AttachmentsCard({
  publicId,
  initial,
  initialLinks = [],
  canUpload,
  canDelete,
}: {
  publicId: string;
  initial: SubmissionAttachment[];
  /**
   * Links already on this submission (docs/plans/staff-attachments.md §3.6).
   * Rendered BELOW every attachment, oldest first.
   */
  initialLinks?: SubmissionLink[];
  canUpload: boolean;
  /**
   * Whether this viewer may remove a file at all. Administrators only — the
   * server enforces the same rule, so this only decides whether the ✕ renders.
   */
  canDelete: boolean;
}) {
  const [items, setItems] = useState<SubmissionAttachment[]>(initial);
  const [links, setLinks] = useState<SubmissionLink[]>(initialLinks);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadingName, setUploadingName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // The add-link panel. Kept open on failure so the typed values are not lost.
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkTitle, setLinkTitle] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkError, setLinkError] = useState("");
  const [linkSaving, setLinkSaving] = useState(false);
  // The row ARMED for deletion. The ✕ only sets this; the drawer is what
  // actually deletes, so the press that cannot be undone is never the first
  // press. Nothing in this app uses `window.confirm`, and a native prompt could
  // not name the file it is about to remove.
  //
  // One drawer serves both groups: a file and a link differ only in what the
  // drawer says and which call it makes.
  const [confirmTarget, setConfirmTarget] = useState<
    { kind: "attachment"; row: SubmissionAttachment } | { kind: "link"; row: SubmissionLink } | null
  >(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // The page behind the drawer must not scroll while it is open.
  useBodyScrollLock(confirmTarget !== null);

  const atCap = items.length >= MAX_ATTACHMENTS;

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setError("");
    setNotice("");
    setBusy(true);
    // Sequential, not parallel: the cap is authoritative per file, so a batch
    // stops cleanly at the limit instead of racing ten uploads past it.
    const files = Array.from(fileList);
    let added = 0;
    try {
      for (const file of files) {
        if (items.length + added >= MAX_ATTACHMENTS) {
          setNotice(
            `Only ${MAX_ATTACHMENTS} attachments are allowed per submission — the remaining files were not uploaded.`
          );
          break;
        }
        setUploadingName(file.name);
        setProgress(0);
        try {
          const row = await api.uploadAttachment(publicId, file, (f) => setProgress(f));
          added += 1;
          setItems((prev) => [...prev, row]);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : "The file could not be uploaded.");
          break;
        }
      }
    } finally {
      setProgress(null);
      setUploadingName("");
      setBusy(false);
      // Reset so re-picking the SAME file fires onChange again.
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleDelete = async () => {
    if (!confirmTarget) return;
    setDeleteError("");
    setDeleting(true);
    try {
      if (confirmTarget.kind === "attachment") {
        const next = await api.deleteAttachment(publicId, confirmTarget.row.id);
        setItems(next);
        setNotice(`Removed “${confirmTarget.row.file_name}”.`);
      } else {
        const next = await api.deleteSubmissionLink(publicId, confirmTarget.row.id);
        setLinks(next);
        setNotice(`Removed the link “${confirmTarget.row.title}”.`);
      }
      setConfirmTarget(null);
    } catch (err) {
      // Kept INSIDE the drawer: the message is about the row named there, and
      // closing it would leave the reader looking at a list that still has the
      // row with no explanation.
      setDeleteError(
        err instanceof ApiError
          ? err.message
          : confirmTarget.kind === "attachment"
            ? "The file could not be removed."
            : "The link could not be removed."
      );
    } finally {
      setDeleting(false);
    }
  };

  const closeLinkForm = () => {
    setLinkOpen(false);
    setLinkTitle("");
    setLinkUrl("");
    setLinkError("");
  };

  const handleAddLink = async () => {
    setLinkError("");
    const title = linkTitle.trim();
    const url = linkUrl.trim();
    if (!title) {
      setLinkError("Link Title is required.");
      return;
    }
    // ★ Refused, not rewritten: storing a URL the user did not type is worse
    // than refusing it. The server says the same sentence (schemas.ts).
    if (!isHttpsUrl(url)) {
      setLinkError(HTTPS_MESSAGE);
      return;
    }
    setLinkSaving(true);
    try {
      const row = await api.addSubmissionLink(publicId, { title, url });
      // Appended, so the new link lands BELOW every attachment and every earlier
      // link — the brief's ordering.
      setLinks((prev) => [...prev, row]);
      setNotice(`Added “${row.title}”.`);
      closeLinkForm();
    } catch (err) {
      setLinkError(err instanceof ApiError ? err.message : "The link could not be added.");
    } finally {
      setLinkSaving(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3>Attachments</h3>
        <span className="sub">
          Files are saved to this form&rsquo;s Google Drive folder. Links point to pages elsewhere.
        </span>
        <span className="lock-tag" style={{ marginLeft: "auto" }}>
          <Lock size={12} />
          Staff only
        </span>
      </div>
      <div className="card-body">
        {/* The + Attachment control comes FIRST; the list renders below it. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 14,
          }}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !canUpload || atCap}
            title={
              atCap
                ? `Maximum of ${MAX_ATTACHMENTS} attachments reached`
                : !canUpload
                  ? "Attachments are not available for your role on this form"
                  : "Choose one or more files to attach"
            }
            onClick={() => inputRef.current?.click()}
          >
            <Paperclip size={14} />
            + Attachment
          </button>
          {/* The brief puts "+ Link" NEXT TO "+ Attachment". It is NOT disabled at
              the 10-file cap: links are not files and do not count against it. */}
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !canUpload || linkSaving}
            title={
              !canUpload
                ? "Attachments are not available for your role on this form"
                : "Add a link (title and https:// URL)"
            }
            aria-expanded={linkOpen}
            onClick={() => {
              if (linkOpen) {
                closeLinkForm();
              } else {
                setError("");
                setNotice("");
                setLinkError("");
                setLinkOpen(true);
              }
            }}
          >
            <Link2 size={14} />
            + Link
          </button>
          <span className="muted-note" style={{ marginLeft: "auto" }}>
            {items.length} of {MAX_ATTACHMENTS} attachments
          </span>
        </div>

        {linkOpen && (
          <div
            className="card"
            style={{ marginBottom: 14, padding: "12px 14px", background: "var(--panel-bg)" }}
            role="group"
            aria-label="Add a link"
          >
            <div style={{ fontWeight: 600, fontSize: "0.875rem", marginBottom: 10 }}>Add a link</div>
            <label style={{ display: "block", marginBottom: 8 }}>
              <span className="muted-note" style={{ display: "block", marginLeft: 0, marginBottom: 4 }}>
                Link Title
              </span>
              <input
                type="text"
                value={linkTitle}
                maxLength={200}
                placeholder="e.g. Student handbook"
                disabled={linkSaving}
                onChange={(e) => setLinkTitle(e.target.value)}
                style={{ width: "100%" }}
              />
            </label>
            <label style={{ display: "block", marginBottom: 8 }}>
              <span className="muted-note" style={{ display: "block", marginLeft: 0, marginBottom: 4 }}>
                Link URL
              </span>
              <input
                type="url"
                value={linkUrl}
                maxLength={2048}
                placeholder="https://"
                disabled={linkSaving}
                onChange={(e) => {
                  setLinkUrl(e.target.value);
                  if (linkError) setLinkError("");
                }}
                onBlur={() => {
                  // Only complain once something was typed — an empty field the
                  // user has not reached yet is not an error.
                  if (linkUrl.trim() && !isHttpsUrl(linkUrl)) setLinkError(HTTPS_MESSAGE);
                }}
                aria-invalid={linkError ? true : undefined}
                style={{ width: "100%" }}
              />
            </label>
            {linkError && (
              <div className="alert-error" role="alert" style={{ marginBottom: 8 }}>
                {linkError}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="secondary-button" disabled={linkSaving} onClick={closeLinkForm}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={linkSaving}
                onClick={() => void handleAddLink()}
              >
                {linkSaving ? "Adding…" : "Add link"}
              </button>
            </div>
          </div>
        )}

        {progress !== null && (
          <div style={{ marginBottom: 14 }} role="status" aria-live="polite">
            <div className="muted-note" style={{ marginLeft: 0, marginBottom: 6 }}>
              <Upload size={12} style={{ verticalAlign: "-1px", marginRight: 4 }} />
              Uploading {uploadingName || "file"}… {Math.round(progress * 100)}%
            </div>
            <div
              style={{
                height: 6,
                borderRadius: 999,
                background: "var(--border)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${Math.round(progress * 100)}%`,
                  background: "var(--accent)",
                  transition: "width .2s ease",
                }}
              />
            </div>
          </div>
        )}

        {error && (
          <div className="alert-error" role="alert" style={{ marginBottom: 12 }}>
            {error}
          </div>
        )}
        {notice && (
          <div className="alert-success" role="status" style={{ marginBottom: 12 }}>
            {notice}
          </div>
        )}

        {items.length === 0 && links.length === 0 ? (
          <div className="muted-note" style={{ marginLeft: 0 }}>
            No attachments or links yet.
          </div>
        ) : (
          <div className="field-list">
            {/* ATTACHMENTS FIRST, then LINKS — the brief's ordering: a new link
                displays below any attachments or other links. */}
            {items.map((row) => {
              return (
                <div
                  key={row.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 0",
                    borderBottom: "1px solid var(--border)",
                    flexWrap: "wrap",
                  }}
                >
                  <Paperclip size={14} style={{ flexShrink: 0, color: "var(--text-muted)" }} />
                  <button
                    type="button"
                    className="link-name"
                    style={{
                      flex: "1 1 240px",
                      minWidth: 0,
                      wordBreak: "break-word",
                      background: "none",
                      border: 0,
                      padding: 0,
                      font: "inherit",
                      textAlign: "left",
                      cursor: "pointer",
                      color: "var(--accent)",
                    }}
                    onClick={() => {
                      setError("");
                      void openAttachment(publicId, row.id).catch((e: Error) => setError(e.message));
                    }}
                  >
                    {row.file_name}
                  </button>
                  <span className="muted-note" style={{ marginLeft: 0 }}>
                    {formatBytes(row.size_bytes)}
                    {row.uploaded_by_name ? ` · ${row.uploaded_by_name}` : ""}
                    {row.uploaded_at ? ` · ${new Date(row.uploaded_at).toLocaleString()}` : ""}
                  </span>
                  <button
                    type="button"
                    className="badge-button"
                    onClick={() => {
                      setError("");
                      void openAttachment(publicId, row.id).catch((e: Error) => setError(e.message));
                    }}
                  >
                    <ExternalLink size={12} style={{ verticalAlign: "-1px", marginRight: 4 }} />
                    Open
                  </button>
                  {canDelete && (
                    <button
                      type="button"
                      className="badge-button danger"
                      disabled={busy}
                      onClick={() => {
                        setDeleteError("");
                        setConfirmTarget({ kind: "attachment", row });
                      }}
                      title="Remove this attachment (deletes the file from Google Drive)"
                      aria-label={`Remove ${row.file_name}`}
                    >
                      <X size={12} style={{ verticalAlign: "-1px" }} />
                    </button>
                  )}
                </div>
              );
            })}
            {links.map((row) => (
              <div
                key={`link-${row.id}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 0",
                  borderBottom: "1px solid var(--border)",
                  flexWrap: "wrap",
                }}
              >
                <Link2 size={14} style={{ flexShrink: 0, color: "var(--text-muted)" }} />
                {/* The href is the STORED, server-validated URL — never a value
                    echoed back from an unvalidated source. `noopener noreferrer`
                    so the opened page cannot reach back into this window. */}
                <a
                  href={row.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="link-name"
                  title={row.url}
                  style={{
                    flex: "1 1 240px",
                    minWidth: 0,
                    wordBreak: "break-word",
                    color: "var(--accent)",
                  }}
                >
                  {row.title}
                </a>
                <span
                  className="muted-note"
                  style={{ marginLeft: 0, maxWidth: "26ch", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={row.url}
                >
                  {row.url}
                  {row.created_by_name ? ` · ${row.created_by_name}` : ""}
                  {row.created_at ? ` · ${new Date(row.created_at).toLocaleString()}` : ""}
                </span>
                <a
                  className="badge-button"
                  href={row.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={12} style={{ verticalAlign: "-1px", marginRight: 4 }} />
                  Open
                </a>
                {canDelete && (
                  <button
                    type="button"
                    className="badge-button danger"
                    disabled={busy}
                    onClick={() => {
                      setDeleteError("");
                      setConfirmTarget({ kind: "link", row });
                    }}
                    title="Remove this link from the submission (the web page itself is not affected)"
                    aria-label={`Remove link ${row.title}`}
                  >
                    <X size={12} style={{ verticalAlign: "-1px" }} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Confirmation drawer — slides in from the right, like every other
          destructive confirm in the app. The ✕ above only ARMS this: it names
          the file, states that the Drive copy goes too, and keeps the error
          inside itself so a failure is explained next to the thing it is about. */}
      {confirmTarget && (
        <div
          className="drawer-overlay open"
          onClick={() => !deleting && setConfirmTarget(null)}
        >
          <div
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-label={confirmTarget.kind === "attachment" ? "Remove attachment" : "Remove link"}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-head">
              <h2>
                {confirmTarget.kind === "attachment" ? "Remove this attachment?" : "Remove this link?"}
              </h2>
              <button
                className="icon-button close"
                onClick={() => setConfirmTarget(null)}
                disabled={deleting}
                title="Close"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="drawer-body">
              <div className="alert-error" style={{ marginBottom: 14 }}>
                <AlertTriangle size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
                This cannot be undone.
              </div>
              {confirmTarget.kind === "attachment" ? (
                <>
                  <p style={{ margin: 0, fontSize: "0.875rem", lineHeight: 1.5 }}>
                    <strong>{confirmTarget.row.file_name}</strong> will be deleted from Google Drive
                    and removed from this submission.
                  </p>
                  <p style={{ margin: "10px 0 0", fontSize: "0.8125rem", color: "var(--text-muted)" }}>
                    {formatBytes(confirmTarget.row.size_bytes)}
                    {confirmTarget.row.uploaded_by_name
                      ? ` · uploaded by ${confirmTarget.row.uploaded_by_name}`
                      : ""}
                    {confirmTarget.row.uploaded_at
                      ? ` on ${new Date(confirmTarget.row.uploaded_at).toLocaleString()}`
                      : ""}
                  </p>
                </>
              ) : (
                <>
                  <p style={{ margin: 0, fontSize: "0.875rem", lineHeight: 1.5 }}>
                    <strong>{confirmTarget.row.title}</strong> will be removed from this submission.
                    The web page itself is not affected.
                  </p>
                  <p
                    style={{
                      margin: "10px 0 0",
                      fontSize: "0.8125rem",
                      color: "var(--text-muted)",
                      wordBreak: "break-all",
                    }}
                  >
                    {confirmTarget.row.url}
                    {confirmTarget.row.created_by_name
                      ? ` · added by ${confirmTarget.row.created_by_name}`
                      : ""}
                    {confirmTarget.row.created_at
                      ? ` on ${new Date(confirmTarget.row.created_at).toLocaleString()}`
                      : ""}
                  </p>
                </>
              )}
              {deleteError && (
                <div className="alert-error" role="alert" style={{ marginTop: 14 }}>
                  {deleteError}
                </div>
              )}
            </div>
            <div className="drawer-foot">
              <span className="muted-note">
                {confirmTarget.kind === "attachment" ? "Deleting an attachment" : "Removing a link"}
              </span>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setConfirmTarget(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void handleDelete()}
                disabled={deleting}
                style={{ background: "var(--danger, #b93040)", borderColor: "var(--danger, #b93040)" }}
              >
                {deleting ? "Removing…" : "Yes, remove it"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
