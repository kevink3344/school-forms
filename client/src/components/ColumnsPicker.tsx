import type { ExportColumn } from "../types";

interface Props {
  /** The columns the caller is allowed to see (already authorization-filtered). */
  columns: ExportColumn[];
  /** The subset currently selected, by `field_N` key. */
  checked: Set<string>;
  onToggle: (key: string) => void;
  onToggleAll: () => void;
  heading?: string;
}

/**
 * Column picker shared by the Submissions export drawer and the Reports page.
 *
 * Purely presentational — the parent owns the selection set so it can drive both
 * the on-screen preview and the export query from one source of truth. Only
 * columns the server already authorized are ever passed in, so this can't be
 * used to reveal a staff-only column.
 */
export default function ColumnsPicker({ columns, checked, onToggle, onToggleAll, heading }: Props) {
  const allChecked = columns.length > 0 && columns.every((c) => checked.has(c.key));
  const selectedCount = columns.filter((c) => checked.has(c.key)).length;

  return (
    <>
      {heading && (
        <h3
          style={{
            fontSize: 13,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--text-muted)",
            marginBottom: 8,
            fontWeight: 700,
          }}
        >
          {heading}
        </h3>
      )}
      <div className="col-picker">
        <div className="cp-head">
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={allChecked} onChange={onToggleAll} />
            Select all
          </label>
          <span>{selectedCount} selected</span>
        </div>
        <div className="cp-grid">
          {columns.map((c) => (
            <label
              key={c.key}
              className={`cp-item ${!checked.has(c.key) ? "dim" : ""}`}
            >
              <input type="checkbox" checked={checked.has(c.key)} onChange={() => onToggle(c.key)} />
              <span>{c.label}</span>
              {c.staff_only && <span className="badge badge-slate tag">Staff</span>}
            </label>
          ))}
        </div>
      </div>
    </>
  );
}

/** Render one preview/table cell value as text (objects are shown as JSON). */
export function cellText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
