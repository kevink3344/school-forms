import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import type { FormField, FieldType, FormWithFields, ViewColumnsConfig } from "../../types";
import { PageHead, formStatusBadge } from "../../components/layout";
import { useAuth } from "../../context/AuthContext";

const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "textarea", label: "Text Area" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "email", label: "Email" },
  { value: "select", label: "Select" },
  { value: "radio", label: "Radio" },
  { value: "checkbox", label: "Checkbox" },
];

// Roles that may access a staff-only field. Extend this array (and the server's
// `ROLES`) to add future roles; the toggle badges render from it automatically.
const ROLES = ["admin", "staff"] as const;

// Most-recently-viewed role set is used to seed a new staff-only field so it
// defaults to being visible to every current role (backward-compatible).
function defaultFieldRoles(): string[] {
  return [...ROLES];
}

export default function AdminFormDesigner() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const formId = Number(id);

  const [form, setForm] = useState<FormWithFields | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Which field tab is active: parent-facing ("form") or staff-only ("staff").
  const [activeTab, setActiveTab] = useState<"form" | "staff">("form");

  // Editor state for the field list
  const [fields, setFields] = useState<FormField[]>([]);

  // View-columns config (which columns the admin Submissions grid shows).
  const [viewColumns, setViewColumns] = useState<ViewColumnsConfig | null>(null);
  const [viewKeys, setViewKeys] = useState<string[]>([]);
  const [savingView, setSavingView] = useState(false);
  const [viewMessage, setViewMessage] = useState("");

  // Editable form-level metadata (title / description)
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  // Per-form Google Drive folder override + live validation. `null` = not yet
  // checked; `true`/`false` reflect a valid/invalid folder id.
  const [docFolderId, setDocFolderId] = useState("");
  const [docFolderValid, setDocFolderValid] = useState<boolean | null>(null);
  const [docFolderName, setDocFolderName] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .getForm(formId)
      .then((f) => {
        if (cancelled) return;
        setForm(f);
        setFields(f.fields || []);
        setTitle(f.title || "");
        setDescription(f.description ?? "");
        setDocFolderId(f.doc_folder_id ?? "");
      })
      .catch(() => setError("Could not load form"))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    // Load the saved view-columns config alongside the form.
    Promise.all([api.getFormViewColumns(formId)])
      .then(([vc]) => {
        if (cancelled) return;
        setViewColumns(vc);
        setViewKeys(vc.viewKeys);
      })
      .catch(() => {
        if (cancelled) return;
        setViewColumns(null);
        setViewKeys([]);
      });

    return () => {
      cancelled = true;
    };
  }, [formId]);

  // Debounced live validation of the Drive Folder ID. Once the admin stops
  // typing, ask the server to confirm the id is an accessible folder. Blank →
  // no checkmark (neutral). Any valid folder → green checkmark.
  useEffect(() => {
    const id = docFolderId.trim();
    if (!id) {
      setDocFolderValid(null);
      setDocFolderName("");
      return;
    }
    const timer = window.setTimeout(() => {
      api
        .validateDriveFolder(formId, id)
        .then((r) => {
          setDocFolderValid(r.valid);
          setDocFolderName(r.name ?? "");
        })
        .catch(() => {
          setDocFolderValid(false);
          setDocFolderName("");
        });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [docFolderId, formId]);

  const rebuildField = (index: number, patch: Partial<FormField>) => {
    setFields((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
    setDirty(true);
  };

  // The form's parent-facing fields and its staff-only fields. Each tab renders
  // a filtered view of the single `fields` source of truth, but once a field is
  // created its group (staff_only) is fixed, so toggling the tab never migrates it.
  const formFields = fields.filter((f) => !f.staff_only);
  const staffFields = fields.filter((f) => f.staff_only);

  const addField = () => {
    const isStaff = activeTab === "staff";
    setFields((prev) => [
      ...prev,
      {
        id: 0,
        form_id: formId,
        label: "New field",
        type: "text",
        options: null,
        required: false,
        staff_only: isStaff,
        // Seed a staff-only field with access for every current role so it is
        // visible to admin + staff by default (matching pre-existing behavior).
        roles: isStaff ? defaultFieldRoles() : null,
        sort_order: prev.length,
        placeholder: null,
      },
    ]);
    setDirty(true);
  };

  const removeField = (field: FormField) => {
    setFields((prev) => prev.filter((f) => f !== field));
    setDirty(true);
  };

  const moveField = (field: FormField, dir: -1 | 1) => {
    setFields((prev) => {
      const idx = prev.indexOf(field);
      if (idx < 0) return prev;
      // Move within the same group (skip fields of the other tab).
      let target = idx + dir;
      while (target >= 0 && target < prev.length && prev[target].staff_only !== field.staff_only) {
        target += dir;
      }
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      await api.updateForm(formId, {
        title: title || "Untitled",
        description: description || null,
        doc_folder_id: docFolderId.trim() || null,
        fields: fields.map((f, i) => ({
          id: f.id || undefined,
          label: f.label,
          type: f.type,
          options: f.options,
          required: f.required,
          staff_only: f.staff_only,
          roles: f.staff_only ? (f.roles && f.roles.length ? f.roles : defaultFieldRoles()) : null,
          sort_order: i,
          placeholder: f.placeholder,
        })),
      });
      // Re-fetch to get canonical ids / reset dirty
      const fresh = await api.getForm(formId);
      setForm(fresh);
      setFields(fresh.fields || []);
      setTitle(fresh.title || "");
      setDescription(fresh.description ?? "");
      setDocFolderId(fresh.doc_folder_id ?? "");
      setDirty(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save form");
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    const next = form?.status === "published" ? "draft" : "published";
    try {
      const updated = await api.updateFormStatus(formId, next);
      setForm(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update status");
    }
  };

  // Toggle a single column on/off in the view-columns selection.
  const toggleViewKey = (key: string) =>
    setViewKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );

  const handleSaveViewColumns = async () => {
    setSavingView(true);
    setViewMessage("");
    try {
      const updated = await api.setFormViewColumns(formId, viewKeys);
      setViewColumns(updated);
      setViewKeys(updated.viewKeys);
      setViewMessage(updated.viewKeys.length ? "View columns saved." : "All columns will be shown.");
    } catch (err) {
      setViewMessage(err instanceof ApiError ? err.message : "Could not save view columns");
    } finally {
      setSavingView(false);
    }
  };

  if (loading) {
    return (
      <div className="loading-state">
        <div className="spinner" /> Loading form...
      </div>
    );
  }

  if (error && !form) {
    return <div className="empty-state">{error}</div>;
  }

  return (
    <div>
      <PageHead
        title={title || "Form Designer"}
        subtitle={`ID ${formId} · ${form ? formStatusBadge(form.status).label : ""}${user?.organization_slug ? ` · ${user.organization_slug}` : ""}`}
        actions={
          <>
            <button className="secondary-button" onClick={() => navigate("/admin/forms")}>
              Back
            </button>
            <button
              className="secondary-button"
              onClick={handlePublish}
              style={
                form?.status === "published"
                  ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }
                  : {}
              }
            >
              {form?.status === "published" ? "Unpublish" : "Publish"}
            </button>
            <button className="primary-button" onClick={handleSave} disabled={saving || !dirty}>
              {saving ? "Saving..." : "Save"}
            </button>
          </>
        }
      />

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

      <div className="card">
        <div className="card-head">
          <h3>Form Details</h3>
        </div>
        <div className="card-body">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="filter-group" style={{ minWidth: 0 }}>
              <label>Title</label>
              <input
                type="text"
                value={title}
                placeholder="Form title"
                onChange={(e) => {
                  setTitle(e.target.value);
                  setDirty(true);
                }}
              />
            </div>
            <div className="filter-group" style={{ minWidth: 0 }}>
              <label>Description</label>
              <textarea
                value={description}
                rows={2}
                placeholder="Optional description shown to parents"
                onChange={(e) => {
                  setDescription(e.target.value);
                  setDirty(true);
                }}
              />
            </div>
            <div className="filter-group" style={{ minWidth: 0 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                Drive Folder ID
                {docFolderValid === true && (
                  <span
                    style={{
                      color: "var(--success, #16a34a)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                    title={docFolderName ? `Valid folder: ${docFolderName}` : "Valid folder"}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <circle cx="12" cy="12" r="10" fill="#16a34a" />
                      <path
                        d="M8 12.5l2.5 2.5L16 9.5"
                        stroke="#fff"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    Valid
                  </span>
                )}
                {docFolderValid === false && (
                  <span
                    style={{
                      color: "var(--danger, #b93040)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                    title="This folder id isn't an accessible Google Drive folder"
                  >
                    Invalid folder
                  </span>
                )}
              </label>
              <input
                type="text"
                value={docFolderId}
                placeholder="Google Drive folder ID (optional — blank uses the default folder)"
                onChange={(e) => {
                  setDocFolderId(e.target.value);
                  setDirty(true);
                }}
              />
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                Generated documents for this form are saved to this folder. Leave blank to use the default.
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Fields</h3>
          <div className="tabs" style={{ marginLeft: "auto" }}>
            <button
              type="button"
              className={`tab ${activeTab === "form" ? "active" : ""}`}
              onClick={() => setActiveTab("form")}
            >
              Form Fields ({formFields.length})
            </button>
            <button
              type="button"
              className={`tab ${activeTab === "staff" ? "active" : ""}`}
              onClick={() => setActiveTab("staff")}
            >
              Staff Only Fields ({staffFields.length})
            </button>
          </div>
        </div>
        <div className="card-body">
          {activeTab === "form" ? (
            <>
              <div className="sub" style={{ marginBottom: 12, fontSize: 12, color: "var(--text-muted)" }}>
                These fields are shown to parents when they submit the form.
              </div>
              {formFields.length === 0 ? (
                <div className="empty-state">No parent-facing fields yet. Add your first field below.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {formFields.map((f) => (
                    <FieldRow
                      key={f.id}
                      field={f}
                      index={fields.indexOf(f)}
                      count={fields.length}
                      showStaffOnlyToggle={false}
                      onChange={(patch) => rebuildField(fields.indexOf(f), patch)}
                      onRemove={() => removeField(f)}
                      onMove={(dir) => moveField(f, dir)}
                    />
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="sub" style={{ marginBottom: 12, fontSize: 12, color: "var(--text-muted)" }}>
                These fields are hidden from parents. Staff fill them in on each submission's detail page.
              </div>
              {staffFields.length === 0 ? (
                <div className="empty-state">No staff-only fields yet. Add one to capture private info per submission.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {staffFields.map((f) => (
                    <FieldRow
                      key={f.id}
                      field={f}
                      index={fields.indexOf(f)}
                      count={fields.length}
                      showStaffOnlyToggle={false}
                      onChange={(patch) => rebuildField(fields.indexOf(f), patch)}
                      onRemove={() => removeField(f)}
                      onMove={(dir) => moveField(f, dir)}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          <button className="secondary-button" onClick={addField} style={{ marginTop: 14 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Add {activeTab === "staff" ? "Staff Only" : "Form"} Field
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h3>View Columns</h3>
          <span className="sub">
            Choose which columns appear in the Submissions grid. Export is unchanged and always includes every field.
          </span>
        </div>
        <div className="card-body">
          <div className="sub" style={{ marginBottom: 12, fontSize: 12, color: "var(--text-muted)" }}>
            {viewColumns && viewColumns.columns.length === 0
              ? "This form has no fields yet."
              : "Unchecking every column shows all columns."}
          </div>
          {viewColumns && viewColumns.columns.length > 0 ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
              {viewColumns.columns.map((c) => (
                <label
                  key={c.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 13,
                    cursor: "pointer",
                    padding: "8px 10px",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius)",
                    background: "var(--panel-bg)",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={viewKeys.includes(c.key)}
                    onChange={() => toggleViewKey(c.key)}
                  />
                  <span style={{ flex: 1 }}>{c.label}</span>
                  {c.staff_only && (
                    <span className="badge badge-orange" style={{ fontSize: 10 }}>
                      Staff
                    </span>
                  )}
                </label>
              ))}
            </div>
          ) : (
            <div className="empty-state" style={{ padding: "16px" }}>
              Add fields above to configure which columns display.
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
            <button
              className="secondary-button"
              onClick={handleSaveViewColumns}
              disabled={savingView || !viewColumns || viewColumns.columns.length === 0}
            >
              {savingView ? "Saving..." : "Save View Columns"}
            </button>
            {viewMessage && (
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{viewMessage}</span>
            )}
          </div>
        </div>
      </div>

      {form?.status === "published" && user?.organization_slug && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <h3>Public link</h3>
            <span className="sub">Share this link with parents</span>
          </div>
          <div className="card-body">
            <code className="cell-mono" style={{ wordBreak: "break-all" }}>
              {`/org/${user.organization_slug}/forms/${form.id}`}
            </code>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function FieldRow({
  field,
  index,
  count,
  showStaffOnlyToggle,
  onChange,
  onRemove,
  onMove,
}: {
  field: FormField;
  index: number;
  count: number;
  showStaffOnlyToggle: boolean;
  onChange: (patch: Partial<FormField>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  // Hold the raw options text while the user types, so commas aren't stripped by
  // the array→string round-trip on every keystroke. Synced from field.options
  // whenever it changes externally (e.g. loading the form, or a different field).
  const isOptionsField = field.type === "select" || field.type === "radio" || field.type === "checkbox";
  const [optionsText, setOptionsText] = useState(isOptionsField ? (field.options || []).join(", ") : "");
  useEffect(() => {
    if (field.type === "select" || field.type === "radio" || field.type === "checkbox") {
      setOptionsText((field.options || []).join(", "));
    }
  }, [field.options, field.type]);

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: 14,
        background: "var(--panel-bg)",
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
        <span className="cell-mono" style={{ fontSize: 11 }}>
          #{index + 1}
        </span>
        <div style={{ display: "flex", gap: 4 }}>
          <button className="icon-button" title="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
            ↑
          </button>
          <button className="icon-button" title="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>
            ↓
          </button>
        </div>
        {showStaffOnlyToggle && (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              cursor: "pointer",
              marginLeft: 8,
            }}
          >
            <input
              type="checkbox"
              checked={field.staff_only}
              onChange={(e) => onChange({ staff_only: e.target.checked })}
            />
            Staff Only
          </label>
        )}
        {field.staff_only && !showStaffOnlyToggle && (
          <span className="badge badge-orange" style={{ fontSize: 11, marginLeft: 8 }}>
            Staff Only
          </span>
        )}
        <div className="filter-spacer" />
        <button className="icon-button" title="Remove field" onClick={onRemove}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="field-edit-grid">
        <div className="filter-group" style={{ minWidth: 0 }}>
          <label>Label</label>
          <input
            type="text"
            value={field.label}
            onChange={(e) => onChange({ label: e.target.value })}
          />
        </div>
        <div className="filter-group" style={{ minWidth: 0 }}>
          <label>Type</label>
          <select value={field.type} onChange={(e) => onChange({ type: e.target.value as FieldType })}>
            {FIELD_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {(field.type === "select" || field.type === "radio" || field.type === "checkbox") && (
        <div className="filter-group" style={{ minWidth: 0, marginTop: 12 }}>
          <label>Options (comma separated)</label>
          <input
            type="text"
            value={optionsText}
            onChange={(e) => setOptionsText(e.target.value)}
            onBlur={() =>
              onChange({
                options: optionsText.split(",").map((s) => s.trim()).filter(Boolean),
              })
            }
          />
          <div className="filter-hint" style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
            Separate each option with a comma (e.g. Option A, Option B, Option C).
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 18, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={field.required}
            onChange={(e) => onChange({ required: e.target.checked })}
          />
          Required
        </label>
        {field.staff_only && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Access:</span>
            {ROLES.map((role) => {
              const has = (field.roles ?? defaultFieldRoles()).includes(role);
              return (
                <button
                  key={role}
                  type="button"
                  title={`${has ? "Remove" : "Grant"} ${role} access to this field`}
                  onClick={() => {
                    const current = field.roles?.length ? field.roles : defaultFieldRoles();
                    const next = has ? current.filter((r) => r !== role) : [...current, role];
                    onChange({ roles: next.length ? next : defaultFieldRoles() });
                  }}
                  className="badge-button"
                  style={{
                    cursor: "pointer",
                    fontSize: 11,
                    padding: "3px 9px",
                    background: has ? "rgb(234,243,255)" : "transparent",
                    color: has ? "rgb(49,93,198)" : "var(--text-muted)",
                    borderColor: has ? "rgb(169,201,255)" : "var(--border)",
                  }}
                >
                  {has ? "+" : "−"} {role}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
