import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import type { PublicForm, FieldType } from "../../types";

type AnswerValue = string | number | boolean | string[] | null;

export default function ParentSubmit() {
  const navigate = useNavigate();
  const { formId, slug } = useParams<{ formId: string; slug: string }>();
  const [searchParams] = useSearchParams();

  const id = formId ? Number(formId) : searchParams.get("form") ? Number(searchParams.get("form")) : null;
  const orgSlug = slug || undefined;

  const [form, setForm] = useState<PublicForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState<Record<number, AnswerValue>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!id) {
      setError("No form selected.");
      setLoading(false);
      return;
    }
    api
      .getPublicForm(id, orgSlug)
      .then((f) => setForm(f))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load form"))
      .finally(() => setLoading(false));
  }, [id, orgSlug]);

  const setAnswer = (fieldId: number, value: AnswerValue) => {
    setAnswers((prev) => ({ ...prev, [fieldId]: value }));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form || submitting) return;
    setSubmitting(true);
    setError("");

    // Build answers array; validate required fields
    const payload = [];
    let missing = "";
    for (const field of form.fields) {
      const value = answers[field.id];
      if (field.required && (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0))) {
        missing = field.label;
        break;
      }
      payload.push({ field_id: field.id, value: value ?? null });
    }

    if (missing) {
      setError(`"${missing}" is required.`);
      setSubmitting(false);
      return;
    }

    try {
      const result = await api.submitForm({ form_id: form.id, answers: payload }, orgSlug);
      navigate(orgSlug ? `/org/${orgSlug}/submission/${result.public_id}` : `/submission/${result.public_id}`, { replace: false });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit. Please try again.");
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="loading-state">
        <div className="spinner" /> Loading form...
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="banner">
        <div className="logo">
          <div className="logo-badge">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M12 4L3 9l9 5 9-5-9-5z" fill="#fff" />
              <path d="M3 13l9 5 9-5" stroke="#fff" strokeWidth="1.6" fill="none" />
            </svg>
          </div>
          School Forms
        </div>
        <div className="actions">
          <span className="muted-note" style={{ color: "#fff", opacity: 0.8 }}>
            Anonymous submission — no sign-in required
          </span>
        </div>
      </header>

      <main className="main" style={{ maxWidth: 760, margin: "0 auto", padding: "28px 24px" }}>
        <div className="card">
          <div className="card-head">
            <h3>{form ? form.title : "Form"}</h3>
            <span className="sub" style={{ marginLeft: "auto" }}>
              Please fill in all required fields.
            </span>
          </div>
          <div className="card-body">
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

            {form ? (
              <form onSubmit={handleSubmit}>
                <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                  {form.fields.map((field) => (
                    <FieldInput
                      key={field.id}
                      field={field}
                      value={answers[field.id]}
                      onChange={(v) => setAnswer(field.id, v)}
                    />
                  ))}
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20 }}>
                  <button type="submit" className="primary-button" disabled={submitting} style={{ alignItems: "center", display: "inline-flex", gap: 8 }}>
                    {submitting ? "Submitting..." : "Submit Form"}
                  </button>
                </div>
              </form>
            ) : (
              <div className="empty-state">{error || "Form not found."}</div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
function FieldInput({
  field,
  value,
  onChange,
}: {
  field: PublicForm["fields"][number];
  value: AnswerValue | undefined;
  onChange: (v: AnswerValue) => void;
}) {
  return (
    <div className="filter-group" style={{ minWidth: 0 }}>
      <label>
        {field.label}
        {field.required && <span style={{ color: "rgb(186,48,64)", marginLeft: 4 }}>*</span>}
      </label>
      {renderInput(field.type as FieldType, field, value, onChange)}
    </div>
  );
}

function renderInput(
  type: FieldType,
  field: PublicForm["fields"][number],
  value: AnswerValue | undefined,
  onChange: (v: AnswerValue) => void
) {
  const placeholder = field.placeholder || undefined;

  switch (type) {
    case "textarea":
      return (
        <textarea
          value={typeof value === "string" ? value : ""}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "number":
      return (
        <input
          type="number"
          value={typeof value === "number" || typeof value === "string" ? String(value) : ""}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
    case "date":
      return (
        <input
          type="date"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case "email":
      return (
        <input
          type="email"
          value={typeof value === "string" ? value : ""}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "select":
      return (
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">Select...</option>
          {(field.options || []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case "radio":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {(field.options || []).map((o) => (
            <label key={o} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
              <input
                type="radio"
                name={`field-${field.id}`}
                checked={value === o}
                onChange={() => onChange(o)}
              />
              {o}
            </label>
          ))}
        </div>
      );
    case "checkbox":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {(field.options || []).map((o) => (
            <label key={o} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={Array.isArray(value) && value.includes(o)}
                onChange={(e) => {
                  const cur = Array.isArray(value) ? [...value] : [];
                  if (e.target.checked) {
                    onChange([...cur, o]);
                  } else {
                    onChange(cur.filter((x) => x !== o));
                  }
                }}
              />
              {o}
            </label>
          ))}
        </div>
      );
    case "text":
    default:
      return (
        <input
          type="text"
          value={typeof value === "string" ? value : ""}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}
