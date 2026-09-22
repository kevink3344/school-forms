import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import { ChevronDown, Check, Copy, KeyRound, Webhook, X } from "lucide-react";
import { parseDocumentRoles, parseMenuItems, defaultMenuItems, MENU_ITEMS, MENU_ITEM_LABELS, ROLES, type MenuItemKey } from "../../lib/settings";
import type { AdminUser, LoginMode, OrganizationWithMembers, ResetPasswordResult, Role, School, WebhookEventSummary } from "../../types";
import { PageHead } from "../../components/layout";
import { Toggle } from "../../components/Toggle";
import { useAuth } from "../../context/AuthContext";
import SchoolsPanel from "./SchoolsPanel";

// login mode options displayed in the Settings → Login Mode panel.
const LOGIN_MODES: { value: LoginMode; label: string; desc: string; tone: string }[] = [
  { value: "select", label: "Select User (Test)", desc: "Pick a user from the directory — no email/password needed.", tone: "blue" },
  { value: "password", label: "Password (Production)", desc: "Requires email + password for every sign-in.", tone: "green" },
  { value: "maintenance", label: "System Maintenance", desc: "Blocks sign-in and shows a maintenance message.", tone: "amber" },
];

const MAINTENANCE_DEFAULT =
  "We are performing scheduled maintenance. Please try again shortly.";

// ---------------------------------------------------------------------------
// Small inline form control (matches the .filter-group / .edit-input styling)
// ---------------------------------------------------------------------------
function Field({
  label,
  children,
  full,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <label className="cf" style={full ? { gridColumn: "1 / -1" } : undefined}>
      <span>{label}</span>
      {children}
    </label>
  );
}

// A toggle switch component built from a styled checkbox — now shared (see
// components/Toggle.tsx) so the filter toolbars do not grow a second copy.

function roleBadge(role: Role): { cls: string; label: string } {
  if (role === "admin") return { cls: "badge-orange", label: "Admin" };
  if (role === "cdm_contact") return { cls: "badge-teal", label: "School Contact" };
  return { cls: "badge-blue", label: "Staff" };
}

// ---------------------------------------------------------------------------
// Collapsible card section (Settings) — clickable header toggles the body
// ---------------------------------------------------------------------------
function CollapsibleSection({
  title,
  subtitle,
  children,
  defaultOpen = false,
  bodyStyle,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  bodyStyle?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card">
      <button
        type="button"
        className="collapse-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="collapse-title-wrap">
          <span className="collapse-title">{title}</span>
          <span className="sub">{subtitle}</span>
        </span>
        <ChevronDown className={`collapse-chevron${open ? " open" : ""}`} size={16} />
      </button>
      {open && (
        <div className="collapse-body" style={bodyStyle}>
          {children}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / Edit modal
// ---------------------------------------------------------------------------
interface FormState {
  id: number | null; // null → create
  display_name: string;
  email: string;
  password: string; // only used on create
  role: Role;
  school_id: string; // "" = no school
  organization_id: string; // "" = default to current admin's org
  active: boolean;
  show_on_test_screen: boolean;
}

const EMPTY: FormState = {
  id: null,
  display_name: "",
  email: "",
  password: "",
  role: "staff",
  school_id: "",
  organization_id: "",
  active: true,
  // Off by default, matching the server: a new account is never listed on the
  // select-mode ("Test") login screen until an admin opts it in.
  show_on_test_screen: false,
};

// ---------------------------------------------------------------------------
// Create / edit Organization (right slide-out drawer)
// ---------------------------------------------------------------------------
interface OrgFormState {
  id: number | null; // null → create
  name: string;
  slug: string; // "" = auto-derive from name on create
  description: string;
  active: boolean;
}

const EMPTY_ORG: OrgFormState = {
  id: null,
  name: "",
  slug: "",
  description: "",
  active: true,
};

export default function AdminSettings() {
  const { user } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [schools, setSchools] = useState<School[]>([]);
  const [orgs, setOrgs] = useState<OrganizationWithMembers[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  // Login Mode panel state.
  const [loginMode, setLoginMode] = useState<LoginMode>("select");
  const [loginModeOverride, setLoginModeOverride] = useState<LoginMode | null>(null);
  const [maintenanceMessage, setMaintenanceMessage] = useState(MAINTENANCE_DEFAULT);
  const [loginModeBusy, setLoginModeBusy] = useState(false);

  // Documents link panel state. A JSON role array stored in app_settings.
  const [docRoles, setDocRoles] = useState<Role[]>(ROLES);
  const [docBusy, setDocBusy] = useState(false);

  // Menu visibility per item, from the `menu_items` setting.
  const [menuItems, setMenuItems] = useState<Record<MenuItemKey, Role[]>>(defaultMenuItems);
  const [menuBusy, setMenuBusy] = useState(false);

  // Slack test panel state — subject, body, and a busy flag.
  const [slackSubject, setSlackSubject] = useState("Test notification");
  const [slackBody, setSlackBody] = useState(
    "This is a test message from School Forms. Slack *markdown* is supported."
  );
  const [slackBusy, setSlackBusy] = useState(false);

  // Webhook Log section state — the trailing 7-day intake counters. Null until
  // loaded, and left null on failure: the button below must still render, since
  // the log is the place you go when something is wrong.
  const [webhookSummary, setWebhookSummary] = useState<WebhookEventSummary | null>(null);

  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  // Admin password reset, rendered INSIDE the user drawer rather than as a second
  // overlay — the drawer already owns the account, and stacking two modals makes
  // "which Cancel am I clicking?" ambiguous.
  //   "idle"    → the normal create/edit form
  //   "confirm" → the "this signs them out" warning
  //   "done"    → the temporary password, shown exactly once
  // The result lives in state only: the server stores a bcrypt hash, so there is
  // no endpoint that could hand this value back a second time.
  const [resetStep, setResetStep] = useState<"idle" | "confirm" | "done">("idle");
  const [resetResult, setResetResult] = useState<ResetPasswordResult | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState("");
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");

  // Organization drawer state.
  const [orgOpen, setOrgOpen] = useState<boolean>(false);
  const [orgForm, setOrgForm] = useState<OrgFormState>(EMPTY_ORG);
  const [orgSaving, setOrgSaving] = useState(false);
  const [orgSaveError, setOrgSaveError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [u, s, o] = await Promise.all([api.listUsers(), api.listSchools(), api.listOrganizations()]);
      setUsers(u);
      setSchools(s);
      setOrgs(o);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load users");
    } finally {
      setLoading(false);
    }

    // Load the Login Mode + maintenance settings (separate try so a settings
    // failure never blocks the users/orgs panels).
    try {
      const [mode, info, msg, docs, menu] = await Promise.all([
        api.getPublicSetting("login_mode"),
        api.getInfo(),
        api.getPublicSetting("maintenance_message"),
        api.getPublicSetting("documents_link"),
        api.getPublicSetting("menu_items"),
      ]);
      setLoginMode((mode.value as LoginMode) || "select");
      setLoginModeOverride(info.loginModeOverride);
      if (msg.value) setMaintenanceMessage(msg.value);
      setDocRoles(parseDocumentRoles(docs.value));
      setMenuItems(parseMenuItems(menu.value));
    } catch {
      // keep defaults
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Intake counters for the Webhook Log section. Deliberately its own try/catch:
  // a webhook-stats failure must not blank out the account and organization
  // panels, and the link to the log stays usable regardless.
  useEffect(() => {
    let cancelled = false;
    api
      .getWebhookEventSummary({ days: 7 })
      .then((s) => {
        if (!cancelled) setWebhookSummary(s);
      })
      .catch(() => {
        /* leave the counters out; the button still works */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openCreate = () => {
    setForm(EMPTY);
    // Always enter the drawer in its normal state, so a half-finished reset in a
    // previous session can never reappear over another account.
    setResetStep("idle");
    setResetResult(null);
    setResetError("");
    setModalOpen(true);
    setSaveError("");
  };

  const openEdit = (u: AdminUser) => {
    setForm({
      id: u.id,
      display_name: u.display_name,
      email: u.email,
      password: "",
      role: u.role,
      // `== null` rather than `=== null`: a key that is merely ABSENT would become
      // the string "undefined", which is truthy, so `Number("undefined")` reaches
      // the API as NaN and comes back as a flat "Validation failed" naming no
      // field. Catching both nullish shapes keeps that from being reachable.
      school_id: u.school_id == null ? "" : String(u.school_id),
      organization_id: u.organization_id == null ? "" : String(u.organization_id),
      active: u.active,
      show_on_test_screen: u.show_on_test_screen,
    });
    setResetStep("idle");
    setResetResult(null);
    setResetError("");
    setModalOpen(true);
    setSaveError("");
  };

  // The signed-in admin's own tenant, which is the ONLY tenant this form can act
  // on: `GET /api/users` returns only users inside it and `PUT /api/users/:id`
  // pins `organization_id` to the caller's own org regardless of what is sent.
  // Derived from the auth context (not from the user being edited) because that is
  // the value the server will actually write.
  const ownOrgId = user?.organization_id != null ? String(user.organization_id) : "";
  const ownOrgName =
    orgs.find((o) => o.id === user?.organization_id)?.name ??
    user?.organization_slug ??
    "Your organization";

  const closeModal = () => {
    if (saving || resetBusy) return;
    setModalOpen(false);
    setSaveError("");
    setForm(EMPTY);
    setResetStep("idle");
    setResetResult(null);
    setResetError("");
  };

  // Issue a temporary password for the user currently open in the drawer.
  // Deliberately NOT optimistic and deliberately not "undo"-able: the old password
  // stops working immediately, so the confirm step (resetStep === "confirm") is
  // what stands between an admin and locking a colleague out by mis-click.
  const handleReset = async () => {
    if (form.id === null) return;
    setResetBusy(true);
    setResetError("");
    try {
      const res = await api.resetUserPassword(form.id);
      setResetResult(res);
      setCopied("no");
      setResetStep("done");
      // Refresh so the grid shows the "Must change" badge the reset just set.
      await load();
    } catch (err) {
      setResetError(err instanceof ApiError ? err.message : "Could not reset the password");
    } finally {
      setResetBusy(false);
    }
  };

  const copyTemporaryPassword = async () => {
    const value = resetResult?.temporary_password;
    if (!value) return;
    try {
      // Only available in a secure context (https or localhost). If it is missing
      // the admin still has to be able to read the password off the screen, so a
      // failure is a message rather than an error.
      await navigator.clipboard.writeText(value);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError("");
    try {
      if (form.id === null) {
        await api.createUser({
          email: form.email,
          password: form.password,
          display_name: form.display_name,
          role: form.role,
          school_id: form.school_id ? Number(form.school_id) : null,
          organization_id: form.organization_id ? Number(form.organization_id) : null,
          show_on_test_screen: form.show_on_test_screen,
        });
        setMessage("User created.");
      } else {
        await api.updateUser(form.id, {
          display_name: form.display_name,
          email: form.email,
          role: form.role,
          school_id: form.school_id ? Number(form.school_id) : null,
          organization_id: form.organization_id ? Number(form.organization_id) : null,
          active: form.active,
          show_on_test_screen: form.show_on_test_screen,
        });
        setMessage("User updated.");
      }
      await load();
      closeModal();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not save user");
    } finally {
      setSaving(false);
    }
  };

  // Set a login mode. Optimistic update with rollback on failure.
  const setLoginModeValue = async (mode: LoginMode) => {
    if (loginModeOverride) return; // locked by env override
    setError("");
    setLoginModeBusy(true);
    const prev = loginMode;
    setLoginMode(mode);
    try {
      await api.updateSetting("login_mode", mode);
      setMessage(`Login mode set to "${mode}".`);
    } catch (err) {
      setLoginMode(prev);
      setError(err instanceof ApiError ? err.message : "Could not update login mode");
    } finally {
      setLoginModeBusy(false);
    }
  };

  const saveMaintenanceMessage = async () => {
    if (loginModeOverride) return;
    setError("");
    setLoginModeBusy(true);
    try {
      await api.updateSetting("maintenance_message", maintenanceMessage.trim());
      setMessage("Maintenance message saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save maintenance message");
    } finally {
      setLoginModeBusy(false);
    }
  };

  // Toggle a role's access to the Documents link. Optimistic with rollback.
  const toggleDocRole = async (role: Role) => {
    setError("");
    setDocBusy(true);
    const prev = docRoles;
    const next = prev.includes(role)
      ? prev.filter((r) => r !== role)
      : [...prev, role];
    setDocRoles(next);
    try {
      await api.updateSetting("documents_link", JSON.stringify(next));
      setMessage(`Documents link ${next.includes(role) ? "enabled" : "hidden"} for ${role}.`);
    } catch (err) {
      setDocRoles(prev);
      setError(err instanceof ApiError ? err.message : "Could not update Documents visibility");
    } finally {
      setDocBusy(false);
    }
  };

  // Toggle a role's visibility of a sidebar menu item. Optimistic with rollback.
  const toggleMenuItemRole = async (item: MenuItemKey, role: Role) => {
    setError("");
    setMenuBusy(true);
    const prev = menuItems;
    const current = prev[item];
    const nextRoles = current.includes(role)
      ? current.filter((r) => r !== role)
      : [...current, role];
    const next = { ...prev, [item]: nextRoles };
    setMenuItems(next);
    try {
      await api.updateSetting("menu_items", JSON.stringify(next));
      setMessage(
        `${MENU_ITEM_LABELS[item]} ${nextRoles.includes(role) ? "shown" : "hidden"} for ${role}.`
      );
    } catch (err) {
      setMenuItems(prev);
      setError(err instanceof ApiError ? err.message : "Could not update menu visibility");
    } finally {
      setMenuBusy(false);
    }
  };

  // Send a test message to the configured Slack webhook (admin only).
  const sendSlackTest = async () => {
    setError("");
    setSlackBusy(true);
    try {
      const r = await api.sendSlackTest(slackSubject.trim(), slackBody.trim());
      setMessage(r.message || "Test message sent to Slack.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send Slack test message");
    } finally {
      setSlackBusy(false);
    }
  };

  // -------------------------------------------------------------------------
  // Organizations drawer handlers
  // -------------------------------------------------------------------------
  const openOrgCreate = () => {
    setOrgForm(EMPTY_ORG);
    setOrgOpen(true);
    setOrgSaveError("");
  };

  const openOrgEdit = (o: OrganizationWithMembers) => {
    setOrgForm({
      id: o.id,
      name: o.name,
      slug: o.slug,
      description: o.description ?? "",
      active: o.active,
    });
    setOrgOpen(true);
    setOrgSaveError("");
  };

  const closeOrg = () => {
    if (orgSaving) return;
    setOrgOpen(false);
    setOrgSaveError("");
    setOrgForm(EMPTY_ORG);
  };

  const handleOrgSave = async () => {
    setOrgSaving(true);
    setOrgSaveError("");
    try {
      if (orgForm.id === null) {
        await api.createOrganization({
          name: orgForm.name.trim(),
          slug: orgForm.slug.trim() || undefined,
          description: orgForm.description.trim() || null,
          active: orgForm.active,
        });
        setMessage("Organization created.");
      } else {
        await api.updateOrganization(orgForm.id, {
          name: orgForm.name.trim(),
          slug: orgForm.slug.trim() || undefined,
          description: orgForm.description.trim() || null,
          active: orgForm.active,
        });
        setMessage("Organization updated.");
      }
      await load();
      closeOrg();
    } catch (err) {
      setOrgSaveError(err instanceof ApiError ? err.message : "Could not save organization");
    } finally {
      setOrgSaving(false);
    }
  };

  // Toggle an organization active/inactive. Optimistic with rollback.
  const toggleOrgActive = async (o: OrganizationWithMembers) => {
    setError("");
    const next = !o.active;
    const prev = orgs;
    setOrgs(prev.map((x) => (x.id === o.id ? { ...x, active: next } : x)));
    try {
      await api.updateOrganization(o.id, { active: next });
      setMessage(`Organization "${o.name}" ${next ? "activated" : "deactivated"}.`);
    } catch (err) {
      setOrgs(prev);
      setError(err instanceof ApiError ? err.message : "Could not update organization");
    }
  };

  return (
    <div>
      <PageHead
        title="Settings"
        subtitle="Manage accounts, roles, and access."
        actions={
          <button className="primary-button" onClick={openCreate}>
            + Add User
          </button>
        }
      />

      {error && (
        <div className="alert-error" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="alert-success" role="status">
          {message}
        </div>
      )}

      <CollapsibleSection
        title="Users"
        subtitle={`${users.length} user${users.length === 1 ? "" : "s"} · ${users.filter((u) => u.active).length} active`}
        bodyStyle={{ padding: 0 }}
      >
        <div className="grid-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>School</th>
                <th>Status</th>
                <th>Test screen</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", padding: 24 }}>
                    Loading…
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", padding: 24 }}>
                    No users yet. Click <strong>Add User</strong> to create one.
                  </td>
                </tr>
              ) : (
                users.map((u) => {
                  const badge = roleBadge(u.role);
                  return (
                    <tr key={u.id} className="grid-row" onClick={() => openEdit(u)} title="Edit user">
                      <td className="cell-strong" data-label="Name">{u.display_name}</td>
                      <td data-label="Email">{u.email}</td>
                      <td data-label="Role">
                        <span className={`badge ${badge.cls}`}>{badge.label}</span>
                      </td>
                      <td data-label="School">{u.school_name ?? "—"}</td>
                      <td data-label="Status">
                        <span className={`badge ${u.active ? "badge-green" : "badge-gray"}`}>
                          {u.active ? "Active" : "Inactive"}
                        </span>
                        {/* Surfaced here rather than in a new column: an admin who
                            reset a password needs to see that the user has not
                            replaced it yet, and the row is where they look. */}
                        {u.must_change_password && (
                          <span
                            className="badge badge-amber"
                            style={{ marginLeft: 6 }}
                            title="A temporary password was issued; the user must choose a new one at next sign-in"
                          >
                            Must change
                          </span>
                        )}
                      </td>
                      <td data-label="Test screen">
                        <span
                          className={`badge ${u.show_on_test_screen ? "badge-blue" : "badge-gray"}`}
                          title={
                            u.show_on_test_screen
                              ? "Listed in the Select User (Test) login dropdown"
                              : "Not listed in the Select User (Test) login dropdown"
                          }
                        >
                          {u.show_on_test_screen ? "Shown" : "Hidden"}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </CollapsibleSection>

      {/* Login Mode panel */}
      <CollapsibleSection
        title="Login Mode"
        subtitle="Control how users sign in to School Forms"
      >
          {loginModeOverride && (
            <div
              style={{
                background: "rgb(255,247,229)",
                color: "rgb(146,90,10)",
                padding: "10px 14px",
                borderRadius: "var(--radius)",
                fontSize: 13,
                marginBottom: 16,
              }}
            >
              Login mode is locked to <strong>{loginModeOverride}</strong> by the{" "}
              <code>LOGIN_MODE</code> environment variable and cannot be changed here.
            </div>
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 14,
            }}
          >
            {LOGIN_MODES.map((m) => {
              const active = loginMode === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  disabled={!!loginModeOverride || loginModeBusy}
                  onClick={() => void setLoginModeValue(m.value)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: 4,
                    padding: 14,
                    borderRadius: "var(--radius)",
                    border: `1.5px solid ${active ? "var(--accent)" : "var(--border)"}`,
                    background: active ? "rgb(238,246,255)" : "var(--app-bg)",
                    cursor: !!loginModeOverride ? "not-allowed" : "pointer",
                    textAlign: "left",
                    fontFamily: "inherit",
                      }}
                >
                  <span
                    className={`badge ${active ? "badge-blue" : `badge-${m.tone}`}`}
                    style={{ alignSelf: "flex-start" }}
                  >
                    {active ? "ACTIVE" : m.label}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
                    {m.label}
                  </span>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{m.desc}</span>
                </button>
              );
            })}
          </div>

          <div style={{ marginTop: 18 }}>
            <div className="filter-group" style={{ minWidth: 0 }}>
              <label htmlFor="maintenance-message">Maintenance message</label>
              <textarea
                id="maintenance-message"
                value={maintenanceMessage}
                onChange={(e) => setMaintenanceMessage(e.target.value)}
                rows={3}
                disabled={!!loginModeOverride || loginModeBusy}
              />
            </div>
            <button
              type="button"
              className="primary-button"
              disabled={!!loginModeOverride || loginModeBusy || !maintenanceMessage.trim()}
              onClick={() => void saveMaintenanceMessage()}
              style={{ marginTop: 10 }}
            >
              Save Maintenance Message
            </button>
          </div>
      </CollapsibleSection>

      {/* Documents link panel — which roles see the Documents sidebar link */}
      <CollapsibleSection
        title="Documents Link"
        subtitle="Show or hide the Documents sidebar link, enabled by role"
      >
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 14px" }}>
          Toggle which roles see <strong>Documents</strong> in the sidebar. Toggling a role
          off hides the link for those users immediately; the API also refuses their
          requests. At least one role should remain enabled for the page to be used.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {ROLES.map((role) => {
            const has = docRoles.includes(role);
            const badge = roleBadge(role);
            return (
              <div
                key={role}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "12px 14px",
                  borderRadius: "var(--radius)",
                  border: "1px solid var(--border)",
                  background: "var(--app-bg)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className={`badge ${badge.cls}`}>{badge.label}</span>
                  <span style={{ fontSize: 13, color: "var(--text)" }}>
                    {role === "admin"
                      ? "Administrator"
                      : role === "cdm_contact"
                        ? "School Contact"
                        : "Staff member"}
                    {has ? " — can see Documents" : " — cannot see Documents"}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {has ? "Visible" : "Hidden"}
                  </span>
                  <Toggle
                    checked={has}
                    disabled={docBusy}
                    onChange={() => void toggleDocRole(role)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </CollapsibleSection>

      {/* Menu Settings — show/hide sidebar items, by role */}
      <CollapsibleSection
        title="Menu Settings"
        subtitle="Show or hide sidebar menu items, enabled by role"
      >
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 14px" }}>
          Choose which sidebar items each role can see. Hiding an item removes it from
          the menu for that role; it does not delete any data or change permissions on
          the underlying pages.
        </p>
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 14px" }}>
          <strong>Documents</strong> is not listed here. It is controlled by the
          Documents Link panel above, which also decides whether the documents API
          accepts a request.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {MENU_ITEMS.map((item) => (
            <div key={item}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--text-muted)",
                  marginBottom: 8,
                }}
              >
                {MENU_ITEM_LABELS[item]}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {ROLES.map((role) => {
                  const has = menuItems[item].includes(role);
                  const badge = roleBadge(role);
                  return (
                    <div
                      key={role}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        padding: "12px 14px",
                        borderRadius: "var(--radius)",
                        border: "1px solid var(--border)",
                        background: "var(--app-bg)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span className={`badge ${badge.cls}`}>{badge.label}</span>
                        <span style={{ fontSize: 13, color: "var(--text)" }}>
                          {has ? "Sees this menu item" : "Menu item hidden"}
                        </span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                          {has ? "Visible" : "Hidden"}
                        </span>
                        <Toggle
                          checked={has}
                          disabled={menuBusy}
                          onChange={() => void toggleMenuItemRole(item, role)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </CollapsibleSection>

      {/* Slack test panel — send a test message to verify the admin alert webhook */}
      <CollapsibleSection
        title="Slack Notifications"
        subtitle="Send a test message to verify the admin alert webhook"
      >
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 14px" }}>
          Admin alerts (new submissions, generated documents) are delivered to{" "}
          <strong>Slack</strong> through a webhook. Use this panel to verify the webhook
          is working and preview how a message looks. The subject and body support Slack
          formatting: <code>*bold*</code>, <code>_italic_</code>, <code>`code`</code>,{" "}
          <code>&gt;quote</code>, and <code>&lt;https://example.com|link&gt;</code>.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="filter-group" style={{ minWidth: 0 }}>
            <label htmlFor="slack-subject">Subject</label>
            <input
              id="slack-subject"
              className="edit-input"
              value={slackSubject}
              onChange={(e) => setSlackSubject(e.target.value)}
              placeholder="Test notification"
            />
          </div>
          <div className="filter-group" style={{ minWidth: 0 }}>
            <label htmlFor="slack-body">Body</label>
            <textarea
              id="slack-body"
              className="edit-input"
              value={slackBody}
              onChange={(e) => setSlackBody(e.target.value)}
              rows={4}
              placeholder="Message body — Slack markdown supported"
            />
          </div>
          <button
            type="button"
            className="primary-button"
            disabled={slackBusy || !slackSubject.trim()}
            onClick={() => void sendSlackTest()}
            style={{ alignSelf: "flex-start" }}
          >
            {slackBusy ? "Sending…" : "Send Test Message"}
          </button>
        </div>
      </CollapsibleSection>

      {/* Webhook Log — the log itself stays on its own page because its filters
          are URL-driven: the dashboard, the post-publish banner, and the form
          designer all link into it with query params. Settings therefore links
          out to it rather than embedding it, which takes it off the sidebar
          without breaking any of those deep links. */}
      <CollapsibleSection
        title="Webhook Log"
        subtitle="Every response Google Forms has posted to this app, including the rejected ones"
      >
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 14px" }}>
          A response that is rejected — because its form was unpublished, its secret was
          wrong, or its body was invalid — is recorded in the log instead of disappearing.
          The log is read-only apart from <strong>Replay</strong>, which re-sends a rejected
          attempt against its form's current state. It is always available to admins and
          cannot be switched off.
        </p>
        {webhookSummary && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              marginBottom: 14,
              fontSize: 13,
            }}
          >
            <span>
              <strong>Last {webhookSummary.days} days</strong>
            </span>
            <span className="badge badge-green">{webhookSummary.window.succeeded} delivered</span>
            {webhookSummary.window.failed > 0 && (
              <span className="badge badge-red">{webhookSummary.window.failed} failed</span>
            )}
            {webhookSummary.unattributed > 0 && (
              <span
                className="badge badge-slate"
                title="Attempts that could not be attributed to a form"
              >
                {webhookSummary.unattributed} unattributed
              </span>
            )}
          </div>
        )}
        <Link
          to="/admin/webhooks"
          className="primary-button"
          style={{ textDecoration: "none" }}
        >
          <Webhook size={16} />
          Open Webhook Log
        </Link>
      </CollapsibleSection>

      {/* Organizations panel */}
      <CollapsibleSection
        title="Organizations"
        subtitle="Tenant boundaries — schools are shared across all organizations"
        bodyStyle={{ padding: 0 }}
      >
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
          <button className="primary-button" onClick={openOrgCreate}>
            + Add Organization
          </button>
        </div>
        <table className="grid">
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Members</th>
              <th>Status</th>
            </tr>
          </thead>
            <tbody>
              {orgs.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: "center", padding: 24 }}>
                    No organizations.
                  </td>
                </tr>
              ) : (
                orgs.map((o) => (
                  <tr key={o.id}>
                    <td className="cell-strong" data-label="Name" onClick={() => openOrgEdit(o)} style={{ cursor: "pointer" }}>{o.name}</td>
                    <td className="cell-mono" data-label="Slug" onClick={() => openOrgEdit(o)} style={{ cursor: "pointer" }}>{o.slug}</td>
                    <td data-label="Members">{o.member_count} user{o.member_count === 1 ? "" : "s"}</td>
                    <td data-label="Status">
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Toggle
                          checked={o.active}
                          disabled={o.id === user?.organization_id}
                          onChange={() => void toggleOrgActive(o)}
                        />
                        <span className={`badge ${o.active ? "badge-green" : "badge-gray"}`}>
                          {o.active ? "Active" : "Inactive"}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
      </CollapsibleSection>

      {/* Schools panel — the district school list. This used to be its own page
          at /admin/schools; it now lives here so all data administration is in
          one place. It renders its own toolbar, table, and pager, so the body
          padding is removed to keep it flush with the section. */}
      <CollapsibleSection
        title="Schools"
        subtitle="Loaded from the district data source. Import is manual."
        bodyStyle={{ padding: 0 }}
      >
        <SchoolsPanel />
      </CollapsibleSection>

      {/* Create / edit organization — right slide-out drawer */}
      <div className={`drawer-overlay ${orgOpen ? "open" : ""}`} onClick={closeOrg}>
        <div className="drawer" onClick={(e) => e.stopPropagation()}>
          <div className="drawer-head">
            <h2>{orgForm.id === null ? "Add Organization" : "Edit Organization"}</h2>
            <button className="icon-button close" onClick={closeOrg} title="Close">
              <X size={18} />
            </button>
          </div>
          <div className="drawer-body">
            {orgSaveError && (
              <div className="alert-error" role="alert" style={{ marginBottom: 12 }}>
                {orgSaveError}
              </div>
            )}
            <div className="form-grid">
              <Field label="Name" full>
                <input
                  className="edit-input"
                  value={orgForm.name}
                  onChange={(e) => setOrgForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Academics"
                />
              </Field>
              <Field label="Slug" full>
                <input
                  className="edit-input"
                  value={orgForm.slug}
                  onChange={(e) => setOrgForm((f) => ({ ...f, slug: e.target.value }))}
                  placeholder="academics (auto-derived from name if left blank)"
                />
              </Field>
              <Field label="Description" full>
                <textarea
                  className="edit-input"
                  value={orgForm.description}
                  onChange={(e) => setOrgForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="Details about this organization"
                  rows={4}
                />
              </Field>
              <Field label="Active" full>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Toggle
                    checked={orgForm.active}
                    disabled={orgForm.id === user?.organization_id}
                    onChange={(v) => setOrgForm((f) => ({ ...f, active: v }))}
                  />
                  <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                    {orgForm.active ? "Active" : "Inactive"}
                    {orgForm.id === user?.organization_id ? " (your organization)" : ""}
                    {!orgForm.active && " — users of this org can no longer sign in"}
                  </span>
                </div>
              </Field>
            </div>
          </div>
          <div className="drawer-foot">
            <span className="muted-note">{orgForm.id === null ? "New organization" : "Editing organization"}</span>
            <button className="secondary-button" onClick={closeOrg} disabled={orgSaving}>
              Cancel
            </button>
            <button
              className="primary-button"
              onClick={() => void handleOrgSave()}
              disabled={orgSaving || !orgForm.name.trim()}
            >
              {orgSaving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>

      {/* Create / edit user — right slide-out drawer. Also hosts the password\n          reset flow (see resetStep), which takes over the body and footer. */}
      <div className={`drawer-overlay ${modalOpen ? "open" : ""}`} onClick={closeModal}>
        <div className="drawer" onClick={(e) => e.stopPropagation()}>
          <div className="drawer-head">
            <h2>
              {resetStep === "idle"
                ? form.id === null
                  ? "Add User"
                  : "Edit User"
                : resetStep === "confirm"
                  ? "Reset Password"
                  : "Temporary Password"}
            </h2>
            <button className="icon-button close" onClick={closeModal} title="Close">
              <X size={18} />
            </button>
          </div>
          <div className="drawer-body">
            {(resetStep === "idle" ? saveError : resetError) && (
              <div className="alert-error" role="alert" style={{ marginBottom: 12 }}>
                {resetStep === "idle" ? saveError : resetError}
              </div>
            )}

            {resetStep === "confirm" ? (
              <div>
                <p style={{ marginTop: 0 }}>
                  Issue a temporary password for <strong>{form.display_name}</strong> (
                  {form.email})?
                </p>
                <div className="alert-error" role="alert">
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    <li>Their current password stops working immediately.</li>
                    <li>
                      A session that is already open keeps working until the page is reloaded —
                      access tokens are not revoked server-side.
                    </li>
                    <li>
                      The next time they open the app they must choose a new password, and they
                      cannot do anything else until they do.
                    </li>
                    <li>The temporary password is shown once and cannot be retrieved later.</li>
                  </ul>
                </div>
                <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
                  Pass it to {form.display_name} over a channel you trust — a phone call or
                  in person, not the same email that carries the account.
                </p>
              </div>
            ) : resetStep === "done" && resetResult ? (
              <div>
                <p style={{ marginTop: 0 }}>
                  A temporary password has been issued for <strong>{resetResult.display_name}</strong>.
                </p>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    margin: "0 0 12px",
                    padding: "12px 14px",
                    background: "var(--panel-bg, #f6f7f9)",
                    border: "1px solid var(--border, #d8dce2)",
                    borderRadius: "var(--radius)",
                  }}
                >
                  <code
                    style={{
                      flex: 1,
                      fontSize: 15,
                      letterSpacing: "0.06em",
                      wordBreak: "break-all",
                      userSelect: "all",
                    }}
                  >
                    {resetResult.temporary_password}
                  </code>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void copyTemporaryPassword()}
                  >
                    {copied === "yes" ? <Check size={16} /> : <Copy size={16} />}
                    {copied === "yes" ? "Copied" : "Copy"}
                  </button>
                </div>

                {copied === "failed" && (
                  <div className="alert-error" role="alert" style={{ marginBottom: 12 }}>
                    Could not copy automatically — select the password above and copy it
                    manually.
                  </div>
                )}

                <div className="alert-error" role="alert">
                  This is the only time it will be shown. There is no way to display it again;
                  if it is lost, reset the password once more to get a new one.
                </div>
              </div>
            ) : (
              <>
                <div className="form-grid">
              <Field label="Display name">
                <input
                  className="edit-input"
                  value={form.display_name}
                  onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))}
                  placeholder="Jane Doe"
                />
              </Field>
              <Field label="Email">
                <input
                  className="edit-input"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="jane@school.org"
                />
              </Field>
              {form.id === null && (
                <Field label="Password">
                  <input
                    className="edit-input"
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                    placeholder="min 8 characters"
                  />
                </Field>
              )}
              <Field label="Role">
                <select
                  className="edit-select"
                  value={form.role}
                  onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as Role }))}
                >
                  <option value="staff">Staff</option>
                  <option value="cdm_contact">School Contact</option>
                  <option value="admin">Admin</option>
                </select>
              </Field>
              {/* The tenant is SHOWN, not chosen.

                  This control used to list every organization while its own
                  placeholder and label implied "your organization", and
                  `handleSave` submits the field on every save — including a save
                  whose only intent was toggling Active. But the server discards
                  it: `PUT /api/users/:id` always writes the caller's org, and
                  `GET /api/users` only ever returns users inside it. So the
                  dropdown offered a choice that could not take effect, and the
                  one thing it COULD do was disagree with the caller's org — which
                  is what produced "You can only assign users within your own
                  organization" while activating a user in the admin's OWN
                  organization. (The Users grid renders no organization column, so
                  the disagreement was never visible anywhere in the UI.)

                  The boundary itself is the server's to enforce; this just stops
                  the form promising a capability it does not have. */}
              <Field label="Organization">
                <select
                  className="edit-select"
                  value={ownOrgId}
                  onChange={() => undefined}
                  disabled
                  title="You can only manage users in your own organization."
                >
                  <option value={ownOrgId}>{ownOrgName}</option>
                </select>
                <span className="field-note">Fixed — users stay in your organization.</span>
              </Field>
              <Field label="School" full>
                <select
                  className="edit-select"
                  value={form.school_id}
                  onChange={(e) => setForm((f) => ({ ...f, school_id: e.target.value }))}
                >
                  <option value="">— No school —</option>
                  {schools.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>

              {form.id !== null && (
                <Field label="Active">
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Toggle
                      checked={form.active}
                      disabled={form.id === user?.id}
                      onChange={(v) => setForm((f) => ({ ...f, active: v }))}
                    />
                    <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                      {form.active ? "Active" : "Inactive"}
                      {form.id === user?.id ? " (you)" : ""}
                    </span>
                  </div>
                </Field>
              )}

              {/* Curates the Select User (Test) login dropdown. Off unless an
                  admin deliberately opts the account in. */}
              <Field label="Show user on Test screen" full>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Toggle
                    checked={form.show_on_test_screen}
                    onChange={(v) => setForm((f) => ({ ...f, show_on_test_screen: v }))}
                  />
                  <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                    {form.show_on_test_screen
                      ? "Listed in the Select User (Test) dropdown"
                      : "Not listed in the Select User (Test) dropdown"}
                  </span>
                </div>
              </Field>
            </div>
              </>
            )}
          </div>
          {resetStep === "confirm" ? (
            <div className="drawer-foot">
              <span className="muted-note">This affects {form.display_name}&apos;s sign-in</span>
              <button
                className="secondary-button"
                onClick={() => setResetStep("idle")}
                disabled={resetBusy}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                onClick={() => void handleReset()}
                disabled={resetBusy}
              >
                {resetBusy ? "Resetting…" : "Reset password"}
              </button>
            </div>
          ) : resetStep === "done" ? (
            <div className="drawer-foot">
              <span className="muted-note">
                Signing in as {resetResult?.display_name} now requires this password
              </span>
              <button className="primary-button" onClick={closeModal}>
                Done
              </button>
            </div>
          ) : (
            <div className="drawer-foot">
              <span className="muted-note">{form.id === null ? "New account" : "Editing account"}</span>
              {/* Only for an existing account — a create has no password to replace.
                  Hidden (not merely disabled) for the signed-in admin's own row:
                  the API refuses self-reset with a 400 pointing at Change Password,
                  so offering it here would look like a broken button. Disabled
                  Toggle above follows the same "you" convention. */}
              {form.id !== null && form.id !== user?.id && (
                <button
                  className="secondary-button"
                  onClick={() => {
                    setResetError("");
                    setResetStep("confirm");
                  }}
                  disabled={saving}
                  title="Issue a temporary password this user must change at next sign-in"
                >
                  <KeyRound size={16} /> Reset password
                </button>
              )}
              <button className="secondary-button" onClick={closeModal} disabled={saving}>
                Cancel
              </button>
              <button
                className="primary-button"
                onClick={() => void handleSave()}
                disabled={saving || !form.display_name || !form.email || (form.id === null && form.password.length < 8)}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
