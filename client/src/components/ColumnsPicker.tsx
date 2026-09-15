// ---------------------------------------------------------------------------
// The one column picker. Shared by the Submissions export drawer, the Reports
// page and the Submissions grid's Columns drawer, so the three cannot drift.
//
// Rows are described structurally rather than as `ExportColumn`s because the
// grid's drawer also lists the standard columns, which are not form fields and
// have no type or options to speak of. `ExportColumn` satisfies this shape, so
// the callers that do have export columns pass them straight in.
// ---------------------------------------------------------------------------
export interface PickerColumn {
  key: string;
  label: string;
  /** Renders the "Staff" badge. */
  staff_only?: boolean;
  /**
   * Rendered checked and disabled, with an "Always shown" badge: this column
   * cannot be turned off. Locked rows are excluded from "Select all" so that box
   * can still read as unticked once everything removable is off.
   */
  locked?: boolean;
}

interface Props {
  /** The columns the caller is allowed to see (already authorization-filtered). */
  columns: PickerColumn[];
  /** The subset currently selected, by key. */
  checked: Set<string>;
  onToggle: (key: string) => void;
  onToggleAll: () => void;
  heading?: string;
}

/**
 * Column picker shared by the Submissions export drawer, the Reports page and
 * the Submissions grid's Columns drawer.
 *
 * Purely presentational — the parent owns the selection set so it can drive both
 * the on-screen preview and the export query from one source of truth. Only
 * columns the server already authorized are ever passed in, so this can't be
 * used to reveal a staff-only column.
 */
export default function ColumnsPicker({ columns, checked, onToggle, onToggleAll, heading }: Props) {
  // Locked rows are left out of "all": they are always on, so counting them would
  // leave the box ticked after every removable column had been turned off, and
  // clicking it would then look like it had done nothing.
  const removable = columns.filter((c) => !c.locked);
  const allChecked = removable.length > 0 && removable.every((c) => checked.has(c.key));
  // Every row, locked included, so this agrees with the drawer's footer count.
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
              className={`cp-item ${c.locked ? "locked" : ""} ${
                !c.locked && !checked.has(c.key) ? "dim" : ""
              }`}
            >
              <input
                type="checkbox"
                checked={c.locked || checked.has(c.key)}
                disabled={c.locked}
                onChange={() => onToggle(c.key)}
              />
              <span>{c.label}</span>
              {c.staff_only && <span className="badge badge-slate tag">Staff</span>}
              {c.locked && <span className="badge badge-slate tag">Always shown</span>}
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
