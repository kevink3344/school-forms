import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import type { AdminUser, Role, School } from "../../types";
import { PageHead } from "../../components/layout";

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
// Create / Edit modal
// ---------------------------------------------------------------------------
interface FormState {
  id: number | null; // null → create
  display_name: string;
  email: string;
  password: string; // only used on create
  role: Role;
  school_id: string; // "" = no school
}

const EMPTY: FormState = {
  id: null,
  display_name: "",
  email: "",
  password: "",
  role: "staff",
  school_id: "",
};

export default function AdminSettings() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [schools, setSchools] = useState<School[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [u, s] = await Promise.all([api.listUsers(), api.listSchools()]);
      setUsers(u);
      setSchools(s);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load users");
    } finally {
      setLoading(false);
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
        });
        setMessage("User created.");
      } else {
        await api.updateUser(form.id, {
          display_name: form.display_name,
          email: form.email,
          role: form.role,
          school_id: form.school_id ? Number(form.school_id) : null,
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

  const toggleActive = async (u: AdminUser, active: boolean) => {
    setError("");
    try {
      const updated = await api.updateUser(u.id, { active });
      setUsers((prev) => prev.map((x) => (x.id === updated.id ? { ...x, active: updated.active } : x)));
      setMessage(`${u.display_name || u.email} is now ${active ? "active" : "inactive"}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update user");
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

      <div className="card">
        <div className="card-head">
          <h3>Users</h3>
          <span className="sub">
            {users.length} user{users.length === 1 ? "" : "s"} · {users.filter((u) => u.active).length} active
          </span>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <table className="grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>School</th>
                <th>Status</th>
                <th style={{ textAlign: "right" }}>Actions</th>
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
                    <tr key={u.id}>
                      <td className="cell-strong">{u.display_name}</td>
                      <td>{u.email}</td>
                      <td>
                        <span className={`badge ${badge.cls}`}>{badge.label}</span>
                      </td>
                      <td>{u.school_name ?? "—"}</td>
                      <td>
                        <span className={`badge ${u.active ? "badge-green" : "badge-gray"}`}>
                          {u.active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                          <button
                            className="badge-button"
                            onClick={() => openEdit(u)}
                            title="Edit user"
                          >
                            Edit
                          </button>
                          <Toggle
                            checked={u.active}
                            disabled={false}
                            onChange={(v) => void toggleActive(u, v)}
                          />
                          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                            {u.active ? "on" : "off"}
                          </span>
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create / edit modal */}
      <div className={`modal-overlay ${modalOpen ? "open" : ""}`} onClick={closeModal}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head">
            <h2>{form.id === null ? "Add User" : "Edit User"}</h2>
            <button className="icon-button close" onClick={closeModal} title="Close">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div className="modal-body">
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
            </div>
          </div>
          <div className="modal-foot">
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
