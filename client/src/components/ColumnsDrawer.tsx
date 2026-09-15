import { X } from "lucide-react";
import ColumnsPicker, { type PickerColumn } from "./ColumnsPicker";

// ---------------------------------------------------------------------------
// The "Select Columns" slide-out, shared by the admin dashboard and the staff
// queue so the two cannot drift.
//
// It is a plain div with role="dialog", not a <dialog> element — that is the
// existing drawer pattern here (overlay + panel, click-outside to close), and
// switching elements would change how focus returns to the trigger button.
//
// It lists every column the grid can show, standard ones included, because the
// ask was for any column but the first to be removable. The first — Student /
// School — comes in flagged `locked` and renders as a settled, untickable row
// rather than being hidden from the list, so its absence from the choices reads
// as a decision instead of an oversight.
//
// Selection state lives in the caller: the grid re-renders live as boxes are
// ticked, and the save happens once when the drawer closes.
// ---------------------------------------------------------------------------
export default function ColumnsDrawer({
  open,
  columns,
  checked,
  onToggle,
  onToggleAll,
  onClose,
  /** Where the selection is remembered — "this form" for both callers today. */
  scopeLabel = "this form",
}: {
  open: boolean;
  columns: PickerColumn[];
  checked: Set<string>;
  onToggle: (key: string) => void;
  onToggleAll: () => void;
  onClose: () => void;
  scopeLabel?: string;
}) {
  if (!open) return null;
  const selectedCount = columns.filter((c) => checked.has(c.key)).length;
  // Everything the user is allowed to turn off (see the `locked` note in
  // ColumnsPicker). Zero means the pinned column is all that is left.
  const removableSelected = columns.filter((c) => !c.locked && checked.has(c.key)).length;

  return (
    <div className="drawer-overlay open" onClick={onClose}>
      <div
        className="drawer drawer-report-columns"
        role="dialog"
        aria-modal="true"
        aria-label="Select columns"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <h2>Select Columns</h2>
          <button className="icon-button close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="drawer-body">
          <p className="file-note" style={{ marginTop: 0 }}>
            Tick the columns to show in the grid. Your choice is remembered for {scopeLabel}, just
            for you.
          </p>
          <ColumnsPicker
            columns={columns}
            checked={checked}
            onToggle={onToggle}
            onToggleAll={onToggleAll}
          />
          {columns.length > 0 && removableSelected === 0 && (
            <p className="file-note">
              Every column that can be turned off is off, so the grid shows nothing but Student /
              School. Staff-only fields are editable straight in the grid once you tick them again.
            </p>
          )}
          <p className="file-note">
            Student / School always stays: it names the row, links to the submission, and is the
            column that holds still when you scroll sideways. Hiding Actions only hides the Review
            button — the student's name opens the same page. Staff-only fields sort to the end and
            can be edited in place.
          </p>
        </div>

        <div className="drawer-foot">
          <span className="file-note" style={{ marginTop: 0 }}>
            {selectedCount} of {columns.length} columns
          </span>
          <div className="spacer" />
          <button className="primary-button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
