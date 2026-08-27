import { useEffect, useState, type FormEvent } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import type { SubmissionDetail, SubmissionStatus, Comment } from "../../types";
import { useAuth } from "../../context/AuthContext";
import { StatusBadge } from "../../components/layout";

const STATUSES: SubmissionStatus[] = ["submitted", "in_review", "flagged", "resolved"];

export default function StaffSubmissionDetail() {
  const { publicId } = useParams<{ publicId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [detail, setDetail] = useState<SubmissionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [commentText, setCommentText] = useState("");
  const [posting, setPosting] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);

  const load = () => {
    if (!publicId) return;
    setLoading(true);
    api
      .getSubmission(publicId)
      .then((d) => setDetail(d))
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
        <button className="badge-button" onClick={() => navigate("/staff")}>
          Back to queue
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
          <h1>{detail.form_name} Submission</h1>
          <p>
            <span className="cell-mono" style={{ fontSize: 12 }}>
              {detail.public_id}
            </span>
          </p>
        </div>
        <div className="head-actions">
          <StatusBadge status={detail.status} />
          <button className="secondary-button" onClick={() => navigate("/staff")}>
            Back to queue
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
          <div className="card">
            <div className="card-head">
              <h3>Submission Answers</h3>
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
                  <div className="field" key={v.field_id}>
                    <span className="f-label">{v.field_label}</span>
                    <span className={`f-value ${isEmpty(v.value) ? "empty" : ""}`}>
                      {formatValue(v.value)}
                    </span>
                  </div>
                ))}
              </div>

              {staffFields.length > 0 && (
                <>
                  <div
                    className="staff-only-box"
                    style={{ marginTop: 16, border: "1px dashed var(--accent)", background: "#eff7fe", borderRadius: "var(--radius)", padding: "14px 16px" }}
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
                        <div className="field" key={v.field_id}>
                          <span className="f-label">{v.field_label}</span>
                          <span className="f-value">{formatValue(v.value)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </section>

        {/* Comments side panel */}
        <aside style={{ position: "sticky", top: 20 }}>
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
        </aside>
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<SubmissionStatus, string> = {
  submitted: "Submitted",
  in_review: "In Review",
  flagged: "Flagged",
  resolved: "Resolved",
};

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "Not provided";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}
