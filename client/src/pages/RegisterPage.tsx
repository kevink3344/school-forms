import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api, ApiError } from "../lib/api";
import type { School } from "../types";

// Fixed org slug options shown on registration (defaults to Academics).
const ORG_OPTIONS = [
  { slug: "academics", label: "Academics" },
  { slug: "technology-services", label: "Technology Services" },
];

export default function RegisterPage() {
  const { registerStaff } = useAuth();
  const navigate = useNavigate();
  const [schools, setSchools] = useState<School[]>([]);
  const [schoolId, setSchoolId] = useState("");
  const [slug, setSlug] = useState("academics");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listSchools()
      .then((s) => {
        if (!cancelled) setSchools(s);
      })
      .catch(() => {
        // ignore; user can't register if list fails
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (!schoolId) {
      setError("Please choose your school.");
      return;
    }
    setBusy(true);
    try {
      const u = await registerStaff({
        email,
        password,
        display_name: name,
        school_id: Number(schoolId),
        slug,
      });
      navigate("/staff", { replace: true });
      void u;
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError("Registration failed. Please try again.");
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
        style={{ width: 440, padding: 32, boxShadow: "var(--shadow-card)" }}
      >
        <div style={{ marginBottom: 8 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>Staff Registration</h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
            Create a staff account for your school
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
            <label htmlFor="organization">Organization</label>
            <select
              id="organization"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              required
            >
              {ORG_OPTIONS.map((o) => (
                <option key={o.slug} value={o.slug}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-group" style={{ minWidth: 0 }}>
            <label htmlFor="school">School *</label>
            <select
              id="school"
              value={schoolId}
              onChange={(e) => setSchoolId(e.target.value)}
              required
            >
              <option value="">Select your school...</option>
              {schools.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-group" style={{ minWidth: 0 }}>
            <label htmlFor="name">Full Name</label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

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
              minLength={8}
              required
            />
          </div>

          <button
            type="submit"
            className="primary-button"
            disabled={busy}
            style={{ justifyContent: "center" }}
          >
            {busy ? "Registering..." : "Create Account"}
          </button>
        </form>

        <p style={{ marginTop: 18, fontSize: 13, color: "var(--text-muted)" }}>
          Already registered?{" "}
          <Link to="/login" style={{ color: "var(--accent)", fontWeight: 600 }}>
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
