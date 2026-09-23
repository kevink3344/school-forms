import { useState, type ReactNode } from "react";
import { Maximize2, X } from "lucide-react";

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
  expandable = false,
}: {
  v: FieldDescriptor;
  editing: boolean;
  value: AnswerValue;
  onChange: (val: AnswerValue) => void;
  // Gives a textarea field the "Expand" affordance, which opens the value in a
  // larger dialog. Opt-in, because the admin grid renders this same mapping into
  // a table cell that has its own Enter-to-commit editor wrapped around it.
  expandable?: boolean;
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
      {renderEditor(type, options, value, onChange, `radio-${v.field_id}`, {
        expandable,
        label,
      })}
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
  radioName: string,
  // Read by the textarea branch only: "this needs more room" is a textarea
  // problem. Expanding a date picker or a select into a dialog would be noise,
  // so the flag is deliberately inert for every other type.
  opts?: { expandable?: boolean; label?: string }
): ReactNode {
  switch (type) {
    case "textarea":
      return (
        <TextareaAnswer
          className="edit-textarea"
          value={toStr(value)}
          onChange={onChange}
          label={opts?.label ?? ""}
          expandable={opts?.expandable ?? false}
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
// Textarea answers.
//
// A fixed-height box can never be the right size for every note, so there are two
// independent remedies and they are deliberately kept apart:
//
//   1. A taller default box, applied by the containing list (`.field-list--roomy`
//      in global.css). The ordinary note needs no interaction at all, and the box
//      still grows by dragging its corner.
//   2. `expandable` adds the button that reopens the value in a dialog, for when
//      the note is long enough that the surrounding fields are in the way.
//
// The dialog edits a LOCAL copy: `Done` writes it back through `onChange`, while
// `Cancel`, Escape and a click outside discard it. That split matters because the
// value the caller holds is an UNSAVED page draft — a "Cancel" that had already
// called `onChange` would leave the change on the page after the user asked for it
// to be undone, while the button told them it had been cancelled.
// ---------------------------------------------------------------------------
function TextareaAnswer({
  className,
  value,
  onChange,
  label,
  expandable,
}: {
  className: string;
  value: string;
  onChange: (val: AnswerValue) => void;
  label: string;
  expandable: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(value);

  const inline = (
    <textarea className={className} value={value} onChange={(e) => onChange(e.target.value)} />
  );

  // No wrapper element when the caller did not opt in, so a host that styles the
  // textarea by position (the grid's `.grid-editor` rules) keeps matching it.
  if (!expandable) return inline;

  const close = () => setExpanded(false);

  return (
    <div className="expand-field">
      {inline}
      <button
        type="button"
        className="expand-btn"
        onClick={() => {
          // Re-seed from the current value on every open, so a discarded draft is
          // never offered back as if it were the field's contents.
          setDraft(value);
          setExpanded(true);
        }}
        aria-label={`Expand ${label || "this field"} into a larger editor`}
        title="Open a larger editor"
      >
        <Maximize2 size={13} />
        Expand
      </button>

      {expanded && (
        <div
          className="modal-overlay open"
          style={{ zIndex: 120 }}
          // The dialog owns the keyboard for as long as it is open. The admin
          // grid's cell editor (Enter commits, Escape cancels) is an ancestor of
          // this overlay in the DOM, so without this a newline typed here would
          // commit and close the cell behind the dialog.
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") close();
          }}
          onClick={close}
        >
          <div
            className="modal"
            style={{ width: "min(820px, 92vw)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h2>{label || "Edit text"}</h2>
              <button
                type="button"
                className="icon-button close"
                onClick={close}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <textarea
                className="edit-textarea expand-dialog-textarea"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-label={label || "Text"}
                autoFocus
              />
            </div>
            <div className="modal-foot">
              {/* A count, not a limit. The API accepts an unbounded string for an
                  answer (server/src/schemas.ts `answerValue` has no `.max()`), so
                  showing "N / MAX" would invent a ceiling that is not enforced. */}
              <span className="expand-count">
                {draft.length.toLocaleString()} character{draft.length === 1 ? "" : "s"}
              </span>
              <span className="spacer" />
              <button type="button" className="secondary-button" onClick={close}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  onChange(draft);
                  close();
                }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
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
