import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import type { FormField, FieldType, FormWithFields } from "../../types";
import { PageHead, formStatusBadge } from "../../components/layout";

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

export default function AdminFormDesigner() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const formId = Number(id);

  const [form, setForm] = useState<FormWithFields | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Editor state for the field list
  const [fields, setFields] = useState<FormField[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .getForm(formId)
      .then((f) => {
        if (cancelled) return;
        setForm(f);
        setFields(f.fields || []);
      })
      .catch(() => setError("Could not load form"))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [formId]);

  const rebuildField = (index: number, patch: Partial<FormField>) => {
    setFields((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
    setDirty(true);
  };

  const addField = () => {
    setFields((prev) => [
      ...prev,
      {
        id: 0,
        form_id: formId,
        label: "New field",
        type: "text",
        options: null,
        required: false,
        staff_only: false,
        sort_order: prev.length,
        placeholder: null,
      },
    ]);
    setDirty(true);
  };

  const removeField = (index: number) => {
    setFields((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  };

  const moveField = (index: number, dir: -1 | 1) => {
    setFields((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      await api.createForm({
        title: form?.title || "Untitled",
        description: form?.description ?? null,
        school_id: form?.school_id ?? null,
        fields: fields.map((f, i) => ({
          label: f.label,
          type: f.type,
          options: f.options,
          required: f.required,
          staff_only: f.staff_only,
          sort_order: i,
          placeholder: f.placeholder,
        })),
      });
      // Re-fetch to get canonical ids / reset dirty
      const fresh = await api.getForm(formId);
      setForm(fresh);
      setFields(fresh.fields || []);
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
        title={form?.title || "Form Designer"}
        subtitle={`ID ${formId} · ${form ? formStatusBadge(form.status).label : ""}`}
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
          <h3>Fields</h3>
          <span className="sub" style={{ marginLeft: "auto" }}>
            Mark fields <strong>Staff Only</strong> to hide them from parents.
          </span>
        </div>
        <div className="card-body">
          {fields.length === 0 ? (
            <div className="empty-state">
              No fields yet. Add your first field below.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {fields.map((f, i) => (
                <FieldRow
                  key={i}
                  field={f}
                  index={i}
                  count={fields.length}
                  onChange={(patch) => rebuildField(i, patch)}
                  onRemove={() => removeField(i)}
                  onMove={(dir) => moveField(i, dir)}
                />
              ))}
            </div>
          )}

          <button className="secondary-button" onClick={addField} style={{ marginTop: 14 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Add Field
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function FieldRow({
  field,
  index,
  count,
  onChange,
  onRemove,
  onMove,
}: {
  field: FormField;
  index: number;
  count: number;
  onChange: (patch: Partial<FormField>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
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
        <div className="filter-spacer" />
        <button className="icon-button" title="Remove field" onClick={onRemove}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
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
            value={(field.options || []).join(", ")}
            onChange={(e) =>
              onChange({
                options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
              })
            }
          />
        </div>
      )}

      <div style={{ display: "flex", gap: 18, marginTop: 12, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={field.required}
            onChange={(e) => onChange({ required: e.target.checked })}
          />
          Required
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={field.staff_only}
            onChange={(e) => onChange({ staff_only: e.target.checked })}
          />
          Staff Only
        </label>
      </div>
    </div>
  );
}
