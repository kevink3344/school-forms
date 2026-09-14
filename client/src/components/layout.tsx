import { useState, useEffect, type ReactNode } from "react";
import { NavLink, Navigate, useNavigate, useLocation } from "react-router-dom";
import {
  PanelLeftOpen,
  Menu,
  LogOut,
  LayoutDashboard,
  FileStack,
  FileText,
  School,
  Settings,
  MessageSquare,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";
import { parseDocumentRoles, ROLES } from "../lib/settings";
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

  // Which roles currently see the Documents link. Reads the public
  // `documents_link` setting (JSON role array). Defaults to all roles while it
  // loads, so the link never flashes away behind a slow request; the stored
  // value resolves on the next render.
  const [docRoles, setDocRoles] = useState<Role[]>(ROLES);

  useEffect(() => {
    let cancelled = false;
    api
      .getPublicSetting("documents_link")
      .then((s) => {
        if (!cancelled) setDocRoles(parseDocumentRoles(s.value));
      })
      .catch(() => {
        // keep the default (all roles) if the read fails
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // True if the current user's role is enabled for Documents.
  const showDocuments = user ? docRoles.includes(user.role) : false;

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
            <PanelLeftOpen size={18} />
          ) : (
            <Menu size={20} />
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
            <LogOut size={18} />
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
                <LayoutDashboard size={18} />
                <span className="s-label">Dashboard</span>
              </NavLink>
              {showDocuments && (
                <NavLink to="/admin/documents" className="sidebar-link" title={collapsed ? "Documents" : undefined} onClick={() => setMobileOpen(false)}>
                  <FileStack size={18} />
                  <span className="s-label">Documents</span>
                </NavLink>
              )}
              <NavLink to="/admin/forms" className="sidebar-link" title={collapsed ? "Forms" : undefined} onClick={() => setMobileOpen(false)}>
                <FileText size={18} />
                <span className="s-label">Forms</span>
              </NavLink>
              <NavLink to="/admin/schools" className="sidebar-link" title={collapsed ? "Schools" : undefined} onClick={() => setMobileOpen(false)}>
                <School size={18} />
                <span className="s-label">Schools</span>
              </NavLink>
              <NavLink to="/admin/settings" className="sidebar-link" title={collapsed ? "Settings" : undefined} onClick={() => setMobileOpen(false)}>
                <Settings size={18} />
                <span className="s-label">Settings</span>
              </NavLink>
            </>
          )}
          {(user?.role === "staff" || user?.role === "cdm_contact") && (
            <>
              <NavLink to="/staff" className="sidebar-link" end title={collapsed ? "Submissions" : undefined} onClick={() => setMobileOpen(false)}>
                <MessageSquare size={18} />
                <span className="s-label">Submissions</span>
              </NavLink>
              {showDocuments && (
                <NavLink to="/staff/documents" className="sidebar-link" title={collapsed ? "Documents" : undefined} onClick={() => setMobileOpen(false)}>
                  <FileStack size={18} />
                  <span className="s-label">Documents</span>
                </NavLink>
              )}
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
