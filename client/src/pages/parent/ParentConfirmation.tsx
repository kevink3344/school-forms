import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { StatusBadge } from "../../components/layout";

export default function ParentConfirmation() {
  const { publicId, slug } = useParams<{ publicId: string; slug: string }>();
  const navigate = useNavigate();
  const [info, setInfo] = useState<{ status: string; submitted_at: string; form_name: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!publicId) return;
    api
      .getSubmissionPublic(publicId, slug || undefined)
      .then((d) => setInfo({ status: d.status, submitted_at: d.submitted_at, form_name: d.form_name }))
      .catch(() => setError("We could not confirm this submission."))
      .finally(() => setLoading(false));
  }, [publicId, slug]);

  return (
    <div className="app-shell">
      <header className="banner">
        <div className="logo">
          <div className="logo-badge">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M12 4L3 9l9 5 9-5-9-5z" fill="#fff" />
              <path d="M3 13l9 5 9-5" stroke="#fff" strokeWidth="1.6" fill="none" />
            </svg>
          </div>
          School Forms
        </div>
      </header>

      <main className="main" style={{ maxWidth: 640, margin: "0 auto", padding: "28px 24px" }}>
        <div className="card">
          <div className="card-body" style={{ textAlign: "center", padding: "32px 28px" }}>
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: "50%",
                background: "rgb(230,255,240)",
                color: "rgb(30,140,82)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: "0 auto 18px",
              }}
            >
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>

            <h1 style={{ margin: "0 0 8px", fontSize: 22 }}>Thank you, your form was submitted.</h1>
            <p className="muted-note" style={{ margin: "0 0 20px", fontSize: 14 }}>
              Your submission has been received. Keep this Submission ID safe — it's your only reference.
            </p>

            {loading ? (
              <div className="loading-state">
                <div className="spinner" /> Checking submission...
              </div>
            ) : error ? (
              <p style={{ color: "rgb(186,48,64)", margin: 0 }}>{error}</p>
            ) : info ? (
              <div style={{ margin: "0 auto", maxWidth: 420, textAlign: "left" }}>
                <div className="field-list" style={{ gridTemplateColumns: "1fr", gap: "10px 0" }}>
                  <div className="field">
                    <span className="f-label">Submission ID</span>
                    <span className="f-value cell-mono" style={{ fontSize: 13 }}>
                      {publicId}
                    </span>
                  </div>
                  <div className="field">
                    <span className="f-label">Form</span>
                    <span className="f-value">{info.form_name}</span>
                  </div>
                  <div className="field">
                    <span className="f-label">Status</span>
                    <span className="f-value"><StatusBadge status={info.status} /></span>
                  </div>
                  <div className="field">
                    <span className="f-label">Submitted</span>
                    <span className="f-value cell-mono" style={{ fontSize: 13 }}>
                      {new Date(info.submitted_at).toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>
            ) : null}

            <div style={{ marginTop: 24, display: "flex", justifyContent: "center", gap: 10 }}>
              <button className="primary-button" onClick={() => navigate(slug ? `/org/${slug}/submit` : "/submit")}>
                Submit another
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
