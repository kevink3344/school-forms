import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound } from "lucide-react";
import { PageHead } from "../../components/layout";
import { useAuth } from "../../context/AuthContext";
import { api, ApiError } from "../../lib/api";

// Minimum length mirrored from the server schema (changePasswordSchema) and from
// the registration form, so the browser blocks a too-short password before the
// round-trip while the server still enforces it for real.
const MIN_LENGTH = 8;

// Self-service password change for every role. Reached from the account menu on
// the user's name in the banner (see components/layout.tsx).
export default function ChangePasswordPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);

  // Cancel goes back to this user's landing page, using the same role rule as
  // HomeRedirect: admins land on /admin, everyone else on /staff.
  const goBack = () => navigate(user?.role === "admin" ? "/admin" : "/staff");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    // Checked here rather than in the server schema: the confirmation field only
    // exists to catch a typo, so it has no business travelling to the API.
    if (!current || !next || !confirm) {
      setError("Please fill in all three fields.");
      return;
    }
    if (next.length < MIN_LENGTH) {
      setError(`New password must be at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (next === current) {
      setError("New password must be different from your current password.");
      return;
    }
    if (next !== confirm) {
      setError("The new passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      const res = await api.changePassword(current, next);
      // Stay signed in — the server keeps the current session valid.
      setCurrent("");
      setNext("");
      setConfirm("");
      setSuccess(res.message || "Password updated successfully.");
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError("Could not update your password. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead
        title="Change password"
        subtitle="Update the password you use to sign in to School Forms."
      />

      <div className="card" style={{ maxWidth: 480 }}>
        <div className="card-body">
          {success && (
            <div
              role="status"
              style={{
                background: "rgb(226,246,232)",
                color: "rgb(23,108,58)",
                padding: "10px 12px",
                borderRadius: "var(--radius)",
                fontSize: 13,
                marginBottom: 16,
              }}
            >
              {success}
            </div>
          )}

          {error && (
            <div
              role="alert"
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

          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="filter-group" style={{ minWidth: 0 }}>
              <label htmlFor="current-password">Current Password</label>
              <input
                id="current-password"
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>

            <div className="filter-group" style={{ minWidth: 0 }}>
              <label htmlFor="new-password">New Password</label>
              <input
                id="new-password"
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                minLength={MIN_LENGTH}
                required
              />
              <span className="muted-note" style={{ marginLeft: 0 }}>
                At least {MIN_LENGTH} characters.
              </span>
            </div>

            <div className="filter-group" style={{ minWidth: 0 }}>
              <label htmlFor="confirm-password">Confirm New Password</label>
              <input
                id="confirm-password"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                minLength={MIN_LENGTH}
                required
              />
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
              <button type="submit" className="primary-button" disabled={busy}>
                <KeyRound size={16} />
                {busy ? "Updating..." : "Update password"}
              </button>
              <button type="button" className="secondary-button" onClick={goBack} disabled={busy}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
