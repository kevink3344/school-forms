import { useState, useEffect, type ReactNode } from "react";
import { NavLink, Navigate, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import type { Role } from "../types";

// ---------------------------------------------------------------------------
// Status badge color mapping
// ---------------------------------------------------------------------------
export function statusBadge(status: string): { cls: string; label: string } {
  switch (status) {
    case "submitted":
      return { cls: "badge-blue", label: "Submitted" };
    case "in_review":
      return { cls: "badge-amber", label: "In Review" };
    case "flagged":
      return { cls: "badge-red", label: "Flagged" };
    case "resolved":
      return { cls: "badge-green", label: "Resolved" };
    default:
      return { cls: "badge-slate", label: status };
  }
}

export function formStatusBadge(status: string): { cls: string; label: string } {
  switch (status) {
    case "published":
      return { cls: "badge-green", label: "Published" };
    case "draft":
      return { cls: "badge-slate", label: "Draft" };
    case "archived":
      return { cls: "badge-gray", label: "Archived" };
    default:
      return { cls: "badge-slate", label: status };
  }
}

function initials(name: string): string {
  if (!name) return "?";
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

// ---------------------------------------------------------------------------
// Page header
// ---------------------------------------------------------------------------
export function PageHead({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="title-block">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="head-actions">{actions}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------
export function StatusBadge({ status }: { status: string }) {
  const b = statusBadge(status);
  return <span className={`badge ${b.cls}`}>{b.label}</span>;
}

export function FormStatusBadge({ status }: { status: string }) {
  const b = formStatusBadge(status);
  return <span className={`badge ${b.cls}`}>{b.label}</span>;
}

// ---------------------------------------------------------------------------
// App shell (banner + sidebar + main)
// ---------------------------------------------------------------------------
export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Desktop icon-only collapse.
  const [collapsed, setCollapsed] = useState(false);
  // Mobile off-canvas drawer state.
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  const handleToggle = () => {
    if (window.innerWidth < 768) setMobileOpen((o) => !o);
    else setCollapsed((c) => !c);
  };

  const handleLogout = async () => {
    setMobileOpen(false);
    await logout();
    navigate("/login");
  };

  return (
    <div className="app-shell">
      <header className="banner">
        <button
          className="icon-button banner-toggle"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={handleToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="M9 3v18" />
              <path d="m14 9 3 3-3 3" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          )}
        </button>
        <div className="logo">
          <div className="logo-badge">SF</div>
          <span className="logo-text">School Forms</span>
        </div>
        <div className="actions">
          {user && (
            <div className="user-chip">
              <div className="avatar">{initials(user.display_name || user.email)}</div>
              <div className="u-meta">
                <div className="u-name">{user.display_name || user.email}</div>
                {user.school_name && <div className="u-school">{user.school_name}</div>}
              </div>
            </div>
          )}
          <button className="icon-button" title="Log out" onClick={handleLogout}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </header>

      <div className="body-flex">
        {/* Mobile drawer overlay */}
        <div
          className={`sidebar-overlay${mobileOpen ? " open" : ""}`}
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />

        <nav className={`sidebar${collapsed ? " collapsed" : ""}${mobileOpen ? " mobile-open" : ""}`}>
          <div className="nav-label">{collapsed ? "" : "Menu"}</div>
          {user?.role === "admin" && (
            <>
              <NavLink to="/admin" className="sidebar-link" end title={collapsed ? "Dashboard" : undefined} onClick={() => setMobileOpen(false)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="7" height="9" />
                  <rect x="14" y="3" width="7" height="5" />
                  <rect x="14" y="12" width="7" height="9" />
                  <rect x="3" y="16" width="7" height="5" />
                </svg>
                <span className="s-label">Dashboard</span>
              </NavLink>
              <NavLink to="/admin/documents" className="sidebar-link" title={collapsed ? "Documents" : undefined} onClick={() => setMobileOpen(false)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
                <span className="s-label">Documents</span>
              </NavLink>
              <NavLink to="/admin/forms" className="sidebar-link" title={collapsed ? "Forms" : undefined} onClick={() => setMobileOpen(false)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
                <span className="s-label">Forms</span>
              </NavLink>
              <NavLink to="/admin/schools" className="sidebar-link" title={collapsed ? "Schools" : undefined} onClick={() => setMobileOpen(false)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 21h18" />
                  <path d="M5 21V7l7-4 7 4v14" />
                  <path d="M9 21v-6h6v6" />
                </svg>
                <span className="s-label">Schools</span>
              </NavLink>
              <NavLink to="/admin/settings" className="sidebar-link" title={collapsed ? "Settings" : undefined} onClick={() => setMobileOpen(false)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
                <span className="s-label">Settings</span>
              </NavLink>
            </>
          )}
          {user?.role === "staff" && (
            <>
              <NavLink to="/staff" className="sidebar-link" end title={collapsed ? "Submissions" : undefined} onClick={() => setMobileOpen(false)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <span className="s-label">Submissions</span>
              </NavLink>
              <NavLink to="/staff/documents" className="sidebar-link" title={collapsed ? "Documents" : undefined} onClick={() => setMobileOpen(false)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
                <span className="s-label">Documents</span>
              </NavLink>
            </>
          )}
        </nav>
        <main className="main">{children}</main>
      </div>
    </div>
  );
}

// Protected route wrapper
export function ProtectedRoute({
  roles,
  children,
}: {
  roles?: Role[];
  children: ReactNode;
}) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="loading-state">
        <div className="spinner" /> Loading...
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
