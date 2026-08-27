import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api, ApiError } from "../lib/api";
import type { LoginMode, LoginUser } from "../types";

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

  // Select-mode state.
  const [orgSlug, setOrgSlug] = useState("academics");
  const [users, setUsers] = useState<LoginUser[]>([]);
  const [userId, setUserId] = useState("");

  // Password-mode state.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Admin local override (only when ?admin=1). Higher priority than the env
  // override so the preview always wins while testing.
  const [adminMode, setAdminMode] = useState<LoginMode | null>(null);

  // Load the effective login mode, env override, and maintenance message.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [mode, info] = await Promise.all([
          api.getPublicSetting("login_mode"),
          api.getInfo(),
        ]);
        if (!cancelled) {
          setLoginMode((mode.value as LoginMode) || "select");
          setLoginModeOverride(info.loginModeOverride);
        }
      } catch {
        if (!cancelled) setLoginMode("select");
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
  }, []);

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

  // ----- Loading state -----
  if (effectiveMode === null) {
    return (
      <Centered>
        <div className="card" style={{ width: 400, padding: 32 }}>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
            Loading…
          </p>
        </div>
      </Centered>
    );
  }

  return (
    <Centered>
      <div className="card" style={{ width: 400, padding: 32, boxShadow: "var(--shadow-card)" }}>
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
                    {u.display_name} · {u.email} · {u.role}
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
    </Centered>
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
      }}
    >
      {children}
    </div>
  );
}
