import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Shared answer-field rendering.
//
// Extracted from the staff/Submission-detail page so the admin Submissions grid
// can render (and edit) the same fields from its own compact cells. There is
// deliberately ONE type -> control mapping in the app: if the grid and the detail
// page each grew their own, a value written from one could serialise differently
// from the same value written from the other.
// ---------------------------------------------------------------------------

// The value shapes the API accepts for an answer (see server/src/schemas.ts
// `answerValue`). Kept structurally identical so a value can round-trip.
export type AnswerValue = string | number | boolean | string[] | null;

// The minimum an editor needs to render a field. `SubmissionValueRow` already
// satisfies this, and a `FormField` can be mapped onto it with `descriptorFrom`.
export interface FieldDescriptor {
  field_id: number;
  field_label: string;
  field_type: string;
  options: string[] | null;
}

// Adapt a form-field definition (which carries `label`/`type`) to the descriptor
// shape the renderer understands. Lets a caller that only has the form definition
// still build an editor.
export function descriptorFrom(f: {
  id: number;
  label: string;
  type: string;
  options: string[] | null;
}): FieldDescriptor {
  return { field_id: f.id, field_label: f.label, field_type: f.type, options: f.options };
}

// ---------------------------------------------------------------------------
// Read / edit pair, with the standard label + value layout.
// ---------------------------------------------------------------------------
export function FieldValue({
  v,
  editing,
  value,
  onChange,
}: {
  v: FieldDescriptor;
  editing: boolean;
  value: AnswerValue;
  onChange: (val: AnswerValue) => void;
}) {
  const { field_type: type, field_label: label, options } = v;

  if (!editing) {
    return (
      <div className="field">
        <span className="f-label">{label}</span>
        <span className={`f-value ${isEmpty(value) ? "empty" : ""}`}>{formatValue(value, type)}</span>
      </div>
    );
  }

  return (
    <div className="field">
      <span className="f-label">{label}</span>
      {renderEditor(type, options, value, onChange, `radio-${v.field_id}`)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The type -> control mapping. Pure, so a caller can supply its own wrapper
// (the Submissions grid renders it straight into a table cell) instead of the
// `.field` / `.f-label` / `.f-value` block above.
// ---------------------------------------------------------------------------
export function renderEditor(
  type: string,
  options: string[] | null,
  value: AnswerValue,
  onChange: (val: AnswerValue) => void,
  radioName: string
): ReactNode {
  switch (type) {
    case "textarea":
      return (
        <textarea
          className="edit-textarea"
          value={toStr(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "number":
      return (
        <input
          className="edit-input"
          type="number"
          value={toStr(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        />
      );
    case "date":
      return (
        <input
          className="edit-input"
          type="date"
          value={toStr(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        />
      );
    case "email":
      return (
        <input
          className="edit-input"
          type="email"
          value={toStr(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "select":
      return (
        <select className="edit-select" value={toStr(value)} onChange={(e) => onChange(e.target.value)}>
          <option value="">— Select —</option>
          {(options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case "radio":
      return (
        <div className="f-value inline">
          {(options ?? []).map((o) => (
            <label key={o} style={{ display: "inline-flex", alignItems: "center", gap: 5, marginRight: 10 }}>
              <input
                type="radio"
                name={radioName}
                checked={toStr(value) === o}
                onChange={() => onChange(o)}
              />
              {o}
            </label>
          ))}
        </div>
      );
    case "checkbox": {
      const opts = options ?? [];
      // A single-option checkbox (e.g. the staff-only "Generate document" field)
      // is semantically a boolean, so render it as a toggle switch to make it
      // deliberate rather than an easy-to-mistake checkbox. Fields with multiple
      // options keep the checkbox list.
      if (opts.length === 1) {
        const o = opts[0];
        const arr = Array.isArray(value) ? value : [];
        const checked = arr.includes(o);
        return (
          <label className="toggle" title="Toggle to set this option">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => {
                const next = e.target.checked ? [...arr, o] : arr.filter((x) => x !== o);
                onChange(next);
              }}
            />
            <span className="track">
              <span className="thumb" />
            </span>
            <span style={{ marginLeft: 8, fontSize: 13 }}>{o}</span>
          </label>
        );
      }
      return (
        <div className="f-value inline">
          {opts.map((o) => {
            const arr = Array.isArray(value) ? value : [];
            const checked = arr.includes(o);
            return (
              <label key={o} style={{ display: "inline-flex", alignItems: "center", gap: 5, marginRight: 10 }}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    const next = e.target.checked ? [...arr, o] : arr.filter((x) => x !== o);
                    onChange(next);
                  }}
                />
                {o}
              </label>
            );
          })}
        </div>
      );
    }
    default:
      return (
        <input
          className="edit-input"
          type="text"
          value={toStr(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Flatten a submission's values into a `field_id -> value` draft map.
export function valuesToDraft(
  values: { field_id: number; value: AnswerValue }[]
): Record<number, AnswerValue> {
  const d: Record<number, AnswerValue> = {};
  for (const v of values) d[v.field_id] = v.value;
  return d;
}

// `false` and `0` are real answers, so only null/undefined/"" count as empty.
export function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

export function toStr(v: AnswerValue): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

export function formatValue(v: unknown, type?: string): string {
  // Unanswered optional fields (e.g. "Course choice #3 (optional)") should render
  // as blank rather than a placeholder, per the product requirement.
  if (v === null || v === undefined || v === "") return "";
  const str = Array.isArray(v) ? "" : String(v);
  // Format date fields and date-like strings (e.g. "2026-08-28") as M/D/YYYY.
  // Parse the YYYY-MM-DD string directly to avoid the timezone shift that
  // `new Date("2026-08-28")` would introduce on negative-offset systems.
  if (type === "date" || /^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
    return str;
  }
  if (Array.isArray(v)) return v.join(", ");
  return str;
}

// A display string for a read-only cell, where blank should read as a dash.
export function displayValue(v: unknown, type?: string): string {
  return formatValue(v, type) || "—";
}
