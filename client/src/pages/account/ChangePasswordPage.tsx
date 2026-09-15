import { useState, type CSSProperties, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound } from "lucide-react";
import { PageHead } from "../../components/layout";
import { useAuth } from "../../context/AuthContext";
import { api, ApiError } from "../../lib/api";

// Minimum length mirrored from the server schema (changePasswordSchema) and from
// the registration form, so the browser blocks a too-short password before the
// round-trip while the server still enforces it for real.
const MIN_LENGTH = 8;

// Where ProtectedRoute sends a user who must replace an administrator-issued
// temporary password. A distinct path rather than a flag on /account/password so
// the forced variant can render WITHOUT the app shell: while the flag is set the
// user has no business seeing the navigation, and a shell-less page removes the
// "can I just click somewhere else and ignore this?" question entirely — there is
// nowhere else to click. See docs/plans/password-recovery.md.
export const FORCED_PASSWORD_PATH = "/account/password/required";

const noticeBase: CSSProperties = {
  padding: "10px 12px",
  borderRadius: "var(--radius)",
  fontSize: 13,
  marginBottom: 16,
};
const successNotice: CSSProperties = {
  ...noticeBase,
  background: "rgb(226,246,232)",
  color: "rgb(23,108,58)",
};
const errorNotice: CSSProperties = {
  ...noticeBase,
  background: "rgb(255,232,234)",
  color: "rgb(186,48,64)",
};

// Self-service password change for every role. Reached from the account menu on
// the user's name in the banner (see components/layout.tsx).
//
// `forced` renders the same form for a user whose password an administrator has
// just reset: no Cancel (there is nowhere to cancel TO — the app stays gated
// until the password changes), a different heading, and the first field labelled
// for what the user actually holds, which is a temporary password. The current
// password is still required even here: the server refuses to set a password from
// a bearer token alone, and the user has the temporary password in hand — they
// signed in with it moments ago.
export default function ChangePasswordPage({ forced = false }: { forced?: boolean }) {
  const { user, setUser, logout } = useAuth();
  const navigate = useNavigate();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);

  // Goes back to this user's landing page, using the same role rule as
  // HomeRedirect: admins land on /admin, everyone else on /staff. Also what the
  // "Continue" button uses after a forced change succeeds.
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
      // Adopt the server's returned user rather than assuming the flag cleared.
      // In the forced flow this is the single thing that un-gates the app: the
      // moment `must_change_password` goes false, ProtectedRoute stops redirecting
      // here. Assuming it instead of reading it would mean either a permanently
      // stuck screen or a reset that never takes effect.
      if (res.user) setUser(res.user);
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

  const body = (
    <>
      <PageHead
        title={forced ? "Set a new password" : "Change password"}
        subtitle={
          forced
            ? "An administrator reset your password. Choose a new one to continue."
            : "Update the password you use to sign in to School Forms."
        }
      />

      <div className="card" style={{ maxWidth: 480, width: "100%" }}>
        <div className="card-body">
          {success && (
            <div role="status" style={successNotice}>
              {success}
            </div>
          )}

          {error && (
            <div role="alert" style={errorNotice}>
              {error}
            </div>
          )}

          {/* Once a forced change succeeds the flag is cleared, so the form has
              nothing left to do. Showing it again with empty fields would invite
              a second, pointless change. */}
          {forced && success ? (
            <div>
              <p style={{ marginTop: 0, fontSize: 13, color: "var(--muted, #5b6470)" }}>
                You can now use School Forms with your new password.
              </p>
              <button type="button" className="primary-button" onClick={goBack}>
                Continue to School Forms
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="filter-group" style={{ minWidth: 0 }}>
                <label htmlFor="current-password">
                  {forced ? "Temporary Password" : "Current Password"}
                </label>
                <input
                  id="current-password"
                  type="password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  autoComplete="current-password"
                  required
                />
                {forced && (
                  <span className="muted-note" style={{ marginLeft: 0 }}>
                    The password an administrator gave you.
                  </span>
                )}
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

              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
                <button type="submit" className="primary-button" disabled={busy}>
                  <KeyRound size={16} />
                  {busy ? "Updating..." : "Update password"}
                </button>
                {forced ? (
                  // Sign out rather than Cancel. A forced user who cannot or will
                  // not set a new password must not be trapped on a dead-end page
                  // — signing out is harmless (they would be forced again on the
                  // next sign-in) and it is the honest escape hatch.
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={logout}
                    disabled={busy}
                  >
                    Sign out
                  </button>
                ) : (
                  <button type="button" className="secondary-button" onClick={goBack} disabled={busy}>
                    Cancel
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      </div>
    </>
  );

  if (!forced) return body;

  // Full-screen takeover: no AppShell, so no sidebar and no account menu.
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "var(--bg, #f6f7f9)",
      }}
    >
      <div style={{ width: "100%", maxWidth: 480 }}>{body}</div>
    </div>
  );
}
