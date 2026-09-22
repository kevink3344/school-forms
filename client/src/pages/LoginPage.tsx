import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api, ApiError } from "../lib/api";
import type { LoginMode, LoginStats, LoginUser } from "../types";

// Organization options shown in the select-mode dropdown (matches RegisterPage).
const ORG_OPTIONS = [
  { slug: "academics", label: "Academics" },
  { slug: "technology-services", label: "Technology Services" },
];

const MODE_LABELS: Record<LoginMode, string> = {
  select: "Select User (Test)",
  password: "Password (Production)",
  maintenance: "System Maintenance",
};

const MAINTENANCE_DEFAULT =
  "We are performing scheduled maintenance. Please try again shortly.";

const LOGIN_MODES: readonly LoginMode[] = ["select", "password", "maintenance"];

// Normalise whatever the settings endpoint sends into a known mode. The stored
// value is a free-text column, so "Password" or " password " must still resolve
// rather than missing every render branch and leaving a card with no form in it.
function parseLoginMode(raw: unknown): LoginMode | null {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (LOGIN_MODES as readonly string[]).includes(v) ? (v as LoginMode) : null;
}

// Describe a failed bootstrap read. Deliberately never names a mode: the whole
// point is that a failure must not be reported as one.
function describeSettingsFailure(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      return "Too many requests from this address — the server is rate-limiting sign-in lookups.";
    }
    return `The server could not report the sign-in mode (HTTP ${err.status}).`;
  }
  return "Could not reach the server to determine the sign-in mode.";
}

export default function LoginPage() {
  const { login, loginSelect, user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Dev/test convenience: ?admin=1 shows a local mode switcher so an admin can
  // preview each login form without changing the persisted setting.
  const adminOverrideEnabled = searchParams.get("admin") === "1";

  // loginMode === null while the settings are loading.
  const [loginMode, setLoginMode] = useState<LoginMode | null>(null);
  const [loginModeOverride, setLoginModeOverride] = useState<LoginMode | null>(null);
  const [maintenanceMessage, setMaintenanceMessage] = useState(MAINTENANCE_DEFAULT);

  // Outcome of the login-mode lookup. On "error" the page renders an error +
  // retry card and NO form — it must not pick a mode on the client's behalf,
  // because the only safe guess (password) may not be what the operator chose
  // and the only legible one (the stored default) is the password-free test
  // screen. See the effect below.
  const [settingsState, setSettingsState] = useState<"loading" | "ready" | "error">("loading");
  const [settingsError, setSettingsError] = useState("");
  // Bumped by the retry button to re-run the bootstrap effect.
  const [settingsAttempt, setSettingsAttempt] = useState(0);

  // Select-mode state.
  const [orgSlug, setOrgSlug] = useState("academics");
  const [users, setUsers] = useState<LoginUser[]>([]);
  const [userId, setUserId] = useState("");

  // Password-mode state.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Org-wide login-page stat counts for the brand panel (users/schools/submissions).
  const [stats, setStats] = useState<LoginStats | null>(null);

  // Admin local override (only when ?admin=1). Higher priority than the env
  // override so the preview always wins while testing.
  const [adminMode, setAdminMode] = useState<LoginMode | null>(null);

  // Load the effective login mode, env override, and maintenance message.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setSettingsState("loading");
      setSettingsError("");
      try {
        // Promise.all: EITHER read failing means the mode is unknown, so the
        // pair is treated as one lookup.
        const [mode, info] = await Promise.all([
          api.getPublicSetting("login_mode"),
          api.getInfo(),
        ]);
        if (cancelled) return;
        const parsed = parseLoginMode(mode.value);
        if (!parsed) {
          // A value outside the three known modes is not a mode. Guessing here
          // is how a production site ends up rendering the test screen.
          setLoginMode(null);
          setLoginModeOverride(null);
          setSettingsError(
            `The server reported an unrecognised sign-in mode (${JSON.stringify(mode.value)}).`
          );
          setSettingsState("error");
          return;
        }
        setLoginMode(parsed);
        setLoginModeOverride(info.loginModeOverride);
        setSettingsState("ready");
      } catch (err) {
        if (cancelled) return;
        // Deliberately NOT falling back to a mode. This catch previously set
        // "select", so a rate-limited lookup silently turned the login page
        // into the password-free test form on a "password"-mode site.
        setLoginMode(null);
        setLoginModeOverride(null);
        setSettingsError(describeSettingsFailure(err));
        setSettingsState("error");
        return;
      }
      try {
        const m = await api.getPublicSetting("maintenance_message");
        if (!cancelled && m.value) setMaintenanceMessage(m.value);
      } catch {
        // keep default
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [settingsAttempt]);

  // Effective mode: admin local preview > env override > DB setting.
  const effectiveMode: LoginMode | null =
    adminMode ?? loginModeOverride ?? loginMode;

  // Load select-mode users whenever the org changes (and select mode is active).
  useEffect(() => {
    if (effectiveMode !== "select") return;
    let cancelled = false;
    setError("");
    api
      .getLoginUsers(orgSlug)
      .then((u) => {
        if (!cancelled) {
          setUsers(u);
          setUserId("");
        }
      })
      .catch(() => {
        if (!cancelled) setUsers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [orgSlug, effectiveMode]);

  // Load org-wide stat counts for the brand panel. Re-fetch whenever the
  // selected org changes (org-wide scope, not global). Show "—" while loading.
  useEffect(() => {
    let cancelled = false;
    api
      .getLoginStats(orgSlug)
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {
        if (!cancelled) setStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, [orgSlug]);

  // Already signed in → go home.
  if (user) {
    return <Navigate to={user.role === "admin" ? "/admin" : "/staff"} replace />;
  }

  const handleSelectSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (!userId) {
      setError("Please select a test user from the directory.");
      return;
    }
    setBusy(true);
    try {
      const u = await loginSelect(Number(userId));
      navigate(u.role === "admin" ? "/admin" : "/staff", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError("Sign in failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const handlePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const u = await login(email, password);
      navigate(u.role === "admin" ? "/admin" : "/staff", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError("Login failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  // ----- Bootstrap failed -----
  // An error card, not a form. `?admin=1` is the one exception: it is an
  // explicit, per-URL opt-in to previewing a chosen mode, so it cannot arrive by
  // accident — but nothing else may infer a mode from a failure.
  if (settingsState === "error" && !adminMode) {
    return (
      <Centered>
        <div className="card" style={{ width: "100%", maxWidth: 460, padding: 32 }}>
          <p
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "var(--text-muted)",
              margin: "0 0 4px",
            }}
          >
            Authentication
          </p>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Sign-in unavailable</h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "8px 0 0" }}>
            {settingsError}
          </p>
          {/* Says out loud what the page is doing, because silently showing the
              test form is exactly what this replaced. */}
          <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "10px 0 0" }}>
            No sign-in form is shown until the mode is known, so a failed lookup can never
            present the wrong one.
          </p>
          <div style={{ display: "flex", gap: 10, marginTop: 20, flexWrap: "wrap" }}>
            <button
              type="button"
              className="primary-button"
              onClick={() => setSettingsAttempt((n) => n + 1)}
              style={{ justifyContent: "center" }}
            >
              Try again
            </button>
          </div>
        </div>
      </Centered>
    );
  }

  // ----- Loading state -----
  if (effectiveMode === null) {
    return (
      <Centered>
        <div className="card" style={{ width: "100%", maxWidth: 400, padding: 32 }}>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
            Loading…
          </p>
        </div>
      </Centered>
    );
  }

  return (
    <div className="login-split">
      <div className="login-card">
        <BrandPanel stats={stats} />
        <div className="login-auth">
          <div className="card" style={{ width: "100%", maxWidth: 400, padding: 32 }}>
          <div style={{ marginBottom: 6 }}>
            <p
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--text-muted)",
                margin: "0 0 4px",
              }}
            >
              Authentication
            </p>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Sign In</h1>
            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "6px 0 0" }}>
              {effectiveMode === "select" &&
                "Select a test user from the directory and create a session without entering email or password."}
              {effectiveMode === "password" &&
                "Sign in with your email and password to access School Forms."}
              {effectiveMode === "maintenance" &&
                "System maintenance is currently in progress."}
            </p>
          </div>

          {error && (
            <div
              style={{
                background: "rgb(255,232,234)",
                color: "rgb(186,48,64)",
                padding: "10px 12px",
                borderRadius: "var(--radius)",
                fontSize: 13,
                marginBottom: 16,
                marginTop: 12,
              }}
            >
              {error}
            </div>
          )}

          {effectiveMode === "select" && (
            <form onSubmit={handleSelectSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="filter-group" style={{ minWidth: 0 }}>
                <label htmlFor="select-org">Organization</label>
                <select
                  id="select-org"
                  value={orgSlug}
                  onChange={(e) => setOrgSlug(e.target.value)}
                >
                  {ORG_OPTIONS.map((o) => (
                    <option key={o.slug} value={o.slug}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="filter-group" style={{ minWidth: 0 }}>
                <label htmlFor="select-user">Test User</label>
                <select
                  id="select-user"
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                  required
                >
                  <option value="" disabled>
                    {users.length ? "Select a user…" : "No users available"}
                  </option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.display_name} · {u.email} · {u.role === "cdm_contact" ? "School Contact" : u.role}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="submit"
                className="primary-button"
                disabled={busy || !userId}
                style={{ justifyContent: "center" }}
              >
                {busy ? "Signing in…" : "Sign In"}
              </button>
            </form>
          )}

          {effectiveMode === "password" && (
            <form onSubmit={handlePasswordSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="filter-group" style={{ minWidth: 0 }}>
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="filter-group" style={{ minWidth: 0 }}>
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <button
                type="submit"
                className="primary-button"
                disabled={busy}
                style={{ justifyContent: "center" }}
              >
                {busy ? "Signing in…" : "Sign In"}
              </button>
            </form>
          )}

          {effectiveMode === "maintenance" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div
                style={{
                  background: "rgb(255,247,229)",
                  color: "rgb(146,90,10)",
                  padding: "12px 14px",
                  borderRadius: "var(--radius)",
                  fontSize: 13,
                }}
              >
                {maintenanceMessage}
              </div>
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 18 }}>
            {effectiveMode === "password" ? (
              <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                Staff?{" "}
                <Link to="/register" style={{ color: "var(--accent)", fontWeight: 600 }}>
                  Create an account
                </Link>
              </p>
            ) : (
              <span />
            )}
            {adminOverrideEnabled && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(Object.keys(MODE_LABELS) as LoginMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setAdminMode(m)}
                    className="badge-button"
                    style={{
                      ...(adminMode === m || (adminMode === null && effectiveMode === m)
                        ? { background: "var(--accent)", color: "#fff" }
                        : {}),
                      fontSize: 10,
                    }}
                  >
                    {MODE_LABELS[m]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

// Left brand panel: logo, eyebrow, title, tagline, and three static stat boxes.
// `stats` is null while loading or on error, so the boxes show "—" for the number.
function BrandPanel({ stats }: { stats: LoginStats | null }) {
  const n = (v: number | undefined) => (v === undefined || v === null ? "—" : v);
  return (
    <div className="login-brand">
      <img src="/wcpss-logo.svg" alt="Wake County Public School System" className="brand-logo" />
      <p className="brand-eyebrow">Enterprise Staff Support</p>
      <h1>Google Submissions</h1>
      <p className="brand-tagline">
        Choose a test user and sign in instantly. The correct organization and team
        context will be applied automatically.
      </p>
      <div className="brand-stats">
        <div className="brand-stat">
          <div className="stat-num">{n(stats?.users)}</div>
          <div className="stat-label">Users</div>
        </div>
        <div className="brand-stat">
          <div className="stat-num">{n(stats?.schools)}</div>
          <div className="stat-label">Schools</div>
        </div>
        <div className="brand-stat">
          <div className="stat-num">{n(stats?.submissions)}</div>
          <div className="stat-label">Submissions</div>
        </div>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--app-bg)",
        padding: 16,
        boxSizing: "border-box",
      }}
    >
      {children}
    </div>
  );
}
