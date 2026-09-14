import { useState, useEffect, type ReactNode } from "react";
import { NavLink, Navigate, useNavigate, useLocation } from "react-router-dom";
import {
  Menu,
  X,
  LogOut,
  LayoutDashboard,
  FileStack,
  FileText,
  School,
  BarChart3,
  Settings,
  MessageSquare,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";
import {
  parseDocumentRoles,
  parseMenuItems,
  defaultMenuItems,
  ROLES,
  type MenuItemKey,
} from "../lib/settings";
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
  // The left menu is an off-canvas drawer at every width and starts closed;
  // the hamburger in the banner opens it.
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Which roles currently see the Documents link. Reads the public
  // `documents_link` setting (JSON role array). Defaults to all roles while it
  // loads, so the link never flashes away behind a slow request; the stored
  // value resolves on the next render.
  const [docRoles, setDocRoles] = useState<Role[]>(ROLES);

  // Menu visibility per item, from the `menu_items` setting. Defaults to
  // "visible to all roles" while loading so items don't flash away.
  const [menuItems, setMenuItems] = useState<Record<MenuItemKey, Role[]>>(defaultMenuItems);

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
    api
      .getPublicSetting("menu_items")
      .then((s) => {
        if (!cancelled) setMenuItems(parseMenuItems(s.value));
      })
      .catch(() => {
        // keep the default (all items visible) if the read fails
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // True if the current user's role is enabled for Documents.
  const showDocuments = user ? docRoles.includes(user.role) : false;

  // Whether a given menu item is visible to the current user's role.
  const menuVisible = (item: MenuItemKey): boolean =>
    user ? menuItems[item].includes(user.role) : false;

  // Close the drawer whenever the route changes.
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  // Lock body scroll while the drawer is open.
  useEffect(() => {
    document.body.style.overflow = sidebarOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [sidebarOpen]);

  // Esc closes the drawer.
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  const handleLogout = async () => {
    setSidebarOpen(false);
    await logout();
    navigate("/login");
  };

  return (
    <div className="app-shell">
      <header className="banner">
        <button
          className="icon-button banner-toggle"
          title={sidebarOpen ? "Close menu" : "Open menu"}
          aria-label={sidebarOpen ? "Close menu" : "Open menu"}
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen((o) => !o)}
        >
          {sidebarOpen ? (
            <X size={18} />
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
        {/* Backdrop behind the open drawer */}
        <div
          className={`sidebar-overlay${sidebarOpen ? " open" : ""}`}
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />

        <nav className={`sidebar${sidebarOpen ? " open" : ""}`}>
          <div className="nav-label">Menu</div>
          {user?.role === "admin" && (
            <>
              <NavLink to="/admin" className="sidebar-link" end onClick={() => setSidebarOpen(false)}>
                <LayoutDashboard size={18} />
                <span className="s-label">Dashboard</span>
              </NavLink>
              {showDocuments && menuVisible("documents") && (
                <NavLink to="/admin/documents" className="sidebar-link" onClick={() => setSidebarOpen(false)}>
                  <FileStack size={18} />
                  <span className="s-label">Documents</span>
                </NavLink>
              )}
              {menuVisible("forms") && (
                <NavLink to="/admin/forms" className="sidebar-link" onClick={() => setSidebarOpen(false)}>
                  <FileText size={18} />
                  <span className="s-label">Forms</span>
                </NavLink>
              )}
              {menuVisible("schools") && (
                <NavLink to="/admin/schools" className="sidebar-link" onClick={() => setSidebarOpen(false)}>
                  <School size={18} />
                  <span className="s-label">Schools</span>
                </NavLink>
              )}
              {menuVisible("reports") && (
                <NavLink to="/admin/reports" className="sidebar-link" onClick={() => setSidebarOpen(false)}>
                  <BarChart3 size={18} />
                  <span className="s-label">Reports</span>
                </NavLink>
              )}
              <NavLink to="/admin/settings" className="sidebar-link" onClick={() => setSidebarOpen(false)}>
                <Settings size={18} />
                <span className="s-label">Settings</span>
              </NavLink>
            </>
          )}
          {(user?.role === "staff" || user?.role === "cdm_contact") && (
            <>
              <NavLink to="/staff" className="sidebar-link" end onClick={() => setSidebarOpen(false)}>
                <MessageSquare size={18} />
                <span className="s-label">Submissions</span>
              </NavLink>
              {showDocuments && menuVisible("documents") && (
                <NavLink to="/staff/documents" className="sidebar-link" onClick={() => setSidebarOpen(false)}>
                  <FileStack size={18} />
                  <span className="s-label">Documents</span>
                </NavLink>
              )}
              {menuVisible("reports") && (
                <NavLink to="/staff/reports" className="sidebar-link" onClick={() => setSidebarOpen(false)}>
                  <BarChart3 size={18} />
                  <span className="s-label">Reports</span>
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
