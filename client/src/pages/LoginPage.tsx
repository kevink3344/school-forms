import { useState, type FormEvent } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../lib/api";

export default function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // If already logged in, go to their home.
  if (user) {
    navigate(user.role === "admin" ? "/admin" : "/staff", { replace: true });
  }

  const handleSubmit = async (e: FormEvent) => {
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
      <div
        className="card"
        style={{ width: 400, padding: 32, boxShadow: "var(--shadow-card)" }}
      >
        <div style={{ marginBottom: 8 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>School Forms</h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
            Sign in to your account
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
            }}
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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
            {busy ? "Signing in..." : "Sign In"}
          </button>
        </form>

        <p style={{ marginTop: 18, fontSize: 13, color: "var(--text-muted)" }}>
          Staff?{" "}
          <Link to="/register" style={{ color: "var(--accent)", fontWeight: 600 }}>
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}
