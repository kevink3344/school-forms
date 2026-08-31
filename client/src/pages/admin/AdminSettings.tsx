import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { parseDocumentRoles, ROLES } from "../../lib/settings";
import type { AdminUser, LoginMode, OrganizationWithMembers, Role, School } from "../../types";
import { PageHead } from "../../components/layout";
import { useAuth } from "../../context/AuthContext";

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

// A toggle switch component built from a styled checkbox.
function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="track">
        <span className="thumb" />
      </span>
    </label>
  );
}

function roleBadge(role: Role): { cls: string; label: string } {
  return role === "admin" ?
    { cls: "badge-orange", label: "Admin" } :
    { cls: "badge-blue", label: "Staff" };
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
        <svg
          className={`collapse-chevron${open ? " open" : ""}`}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
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

  // Slack test panel state — subject, body, and a busy flag.
  const [slackSubject, setSlackSubject] = useState("Test notification");
  const [slackBody, setSlackBody] = useState(
    "This is a test message from School Forms. Slack *markdown* is supported."
  );
  const [slackBusy, setSlackBusy] = useState(false);

  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

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
      const [mode, info, msg, docs] = await Promise.all([
        api.getPublicSetting("login_mode"),
        api.getInfo(),
        api.getPublicSetting("maintenance_message"),
        api.getPublicSetting("documents_link"),
      ]);
      setLoginMode((mode.value as LoginMode) || "select");
      setLoginModeOverride(info.loginModeOverride);
      if (msg.value) setMaintenanceMessage(msg.value);
      setDocRoles(parseDocumentRoles(docs.value));
    } catch {
      // keep defaults
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setForm(EMPTY);
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
      school_id: u.school_id === null ? "" : String(u.school_id),
      organization_id: u.organization_id === null ? "" : String(u.organization_id),
      active: u.active,
    });
    setModalOpen(true);
    setSaveError("");
  };

  const closeModal = () => {
    if (saving) return;
    setModalOpen(false);
    setSaveError("");
    setForm(EMPTY);
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
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: "center", padding: 24 }}>
                    Loading…
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: "center", padding: 24 }}>
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
                    {role === "admin" ? "Administrator" : "Staff member"}
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

      {/* Create / edit organization — right slide-out drawer */}
      <div className={`drawer-overlay ${orgOpen ? "open" : ""}`} onClick={closeOrg}>
        <div className="drawer" onClick={(e) => e.stopPropagation()}>
          <div className="drawer-head">
            <h2>{orgForm.id === null ? "Add Organization" : "Edit Organization"}</h2>
            <button className="icon-button close" onClick={closeOrg} title="Close">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
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

      {/* Create / edit user — right slide-out drawer */}
      <div className={`drawer-overlay ${modalOpen ? "open" : ""}`} onClick={closeModal}>
        <div className="drawer" onClick={(e) => e.stopPropagation()}>
          <div className="drawer-head">
            <h2>{form.id === null ? "Add User" : "Edit User"}</h2>
            <button className="icon-button close" onClick={closeModal} title="Close">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div className="drawer-body">
            {saveError && (
              <div className="alert-error" role="alert" style={{ marginBottom: 12 }}>
                {saveError}
              </div>
            )}
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
                  <option value="admin">Admin</option>
                </select>
              </Field>
              <Field label="Organization">
                <select
                  className="edit-select"
                  value={form.organization_id}
                  onChange={(e) => setForm((f) => ({ ...f, organization_id: e.target.value }))}
                >
                  <option value="">
                    {user?.organization_slug ? `— ${user.organization_slug} —` : "— Default (Academics) —"}
                  </option>
                  {orgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
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
            </div>
          </div>
          <div className="drawer-foot">
            <span className="muted-note">{form.id === null ? "New account" : "Editing account"}</span>
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
        </div>
      </div>
    </div>
  );
}
