import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Pencil } from "lucide-react";
import type { ExportColumn, FormField, SubmissionRow } from "../types";
import { StatusBadge } from "./layout";
import { renderEditor, toStr, displayValue, type AnswerValue } from "./FieldValue";

// ---------------------------------------------------------------------------
// Shared Submissions grid — used by the admin dashboard and the staff queue.
//
// Layout: the pinned Student / School column, then the standard columns
// (Submission ID, Status, Submitted, Actions) + the form's field columns. The
// field columns come in already ordered by the server — `getExportColumns`
// partitions the staff-only columns to the bottom — so "staff-only fields at the
// end" needs no ordering logic here, and the picker, the grid and the export file
// all stay in one order.
//
// Every column except the first can be turned off from the Columns drawer, which
// is what `hiddenBase` carries. Student / School stays because it names the row
// and links to the submission, and because it is the frozen column — a grid with
// it removed would have nothing left to freeze.
//
// Row values come from /api/export/preview, joined on submission_public_id
// (`buildExportRows` always emits it, whatever columns were asked for). The base
// columns come from /api/submissions, which is why the two are merged rather than
// one replacing the other.
//
// The owning page supplies `submissionPath` rather than this file hardcoding
// /admin: staff and School Contacts reach the same grid through /staff/:publicId.
// ---------------------------------------------------------------------------

// Identifies the single cell currently open for editing.
export interface EditingCell {
  publicId: string;
  fieldId: number;
}

// The transient editing machinery, handed to each cell. One editor at a time.
export interface CellEditApi {
  editing: EditingCell | null;
  draft: AnswerValue;
  saving: boolean;
  error: string | null;
  savedKeys: Set<string>;
  begin: (cell: EditingCell, anchor: DOMRect, initial: AnswerValue) => void;
  change: (value: AnswerValue) => void;
  commit: (value?: AnswerValue) => void;
  cancel: () => void;
  /** Re-open the option menu for a multi-option field (used after a failed save). */
  anchor: { left: number; top: number } | null;
}

// The stable identity of one cell: public id + field id. Shared with the hook
// that owns the editing state (`useSubmissionGrid`), because the hook writes the
// `savedKeys` entries this component looks up. Each side building its own string
// would be one refactor away from silently flashing the wrong cell.
function cellKey(publicId: string, fieldId: number): string {
  return `${publicId}|${fieldId}`;
}

export { cellKey };

// The standard columns that can be turned off, in render order. The keys are
// `base_*`, deliberately distinct from `field_N`: a field is owned by the server
// and validated against the form's real fields, while these are a purely
// presentational concern of this file — they are rendered from /api/submissions,
// not from the export preview. That is also why the server stores `base_*` keys
// opaquely rather than enumerating them (see BASE_COLUMN_KEY in db/queries.ts).
//
// A single source for the key strings, so the constants and the render below
// cannot drift apart.
const BASE_KEYS = {
  submissionId: "base_submission_id",
  status: "base_status",
  submitted: "base_submitted",
  actions: "base_actions",
} as const;

/** The removable standard columns, as the picker and the hook see them. */
export const GRID_BASE_COLUMNS: { key: string; label: string }[] = [
  { key: BASE_KEYS.submissionId, label: "Submission ID" },
  { key: BASE_KEYS.status, label: "Status" },
  { key: BASE_KEYS.submitted, label: "Submitted" },
  { key: BASE_KEYS.actions, label: "Actions" },
];

/**
 * The one column that cannot be removed: the row's name and its link to the
 * submission, and the frozen column on desktop.
 */
export const GRID_PINNED_COLUMN = { key: "pinned_student", label: "Student / School" };

// Module level, so the default prop below keeps one identity across renders
// rather than allocating a fresh Set on every one.
const NO_HIDDEN: Set<string> = new Set();

function fieldIdFromKey(key: string): number {
  const m = key.match(/^field_(\d+)$/);
  return m ? Number(m[1]) : 0;
}

// Multi-option fields get a portalled option menu instead of an inline control:
// the labels are long, and the cell is one column wide. Everything else edits in
// place. A single-option checkbox is a boolean toggle (see renderEditor), so it
// commits immediately like a select does.
function editorMode(type: string, options: string[] | null): "immediate" | "menu" {
  if (type === "radio") return "menu";
  if (type === "checkbox" && (options ?? []).length > 1) return "menu";
  return "immediate";
}

// Selects and single-option checkbox toggles are one-gesture controls: the change
// *is* the decision, so there is nothing to confirm. Text-like types hold a draft
// until Enter / blur.
function commitsOnChange(type: string, options: string[] | null): boolean {
  if (type === "select") return true;
  if (type === "checkbox" && (options ?? []).length <= 1) return true;
  return false;
}

export default function SubmissionsGrid({
  rows,
  columns,
  valuesByPublicId,
  fieldMeta,
  onOpen,
  submissionPath,
  edit,
  /** Standard columns (`base_*`) this user turned off. Never the pinned one. */
  hiddenBase = NO_HIDDEN,
  /** Overrides the empty-state wording; the admin view is the default. */
  emptyMessage = "No submissions for the selected filters.",
}: {
  rows: SubmissionRow[];
  columns: ExportColumn[];
  valuesByPublicId: Map<string, Record<string, unknown>>;
  fieldMeta: Map<number, FormField>;
  onOpen: (publicId: string) => void;
  /** Builds the detail-page URL for a submission's row link. */
  submissionPath: (publicId: string) => string;
  edit: CellEditApi;
  /** Standard columns (`base_*` keys) this user turned off. */
  hiddenBase?: Set<string>;
  emptyMessage?: string;
}) {
  const gridScrollRef = useRef<HTMLDivElement | null>(null);
  const topScrollRef = useRef<HTMLDivElement | null>(null);
  const topSpacerRef = useRef<HTMLDivElement | null>(null);

  // Called before the empty-state return below, deliberately: this component
  // returns early when there are no rows, and a hook may not be skipped on some
  // renders. `rowCount` is threaded in as a dependency because that early return
  // swaps the whole subtree out and back.
  useGridScrollMirror({ gridScrollRef, topScrollRef, topSpacerRef, rowCount: rows.length });

  if (!rows.length) {
    return <div className="empty-state">{emptyMessage}</div>;
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>Submissions</h3>
        <span className="sub" style={{ marginLeft: "auto" }}>
          {rows.length} result{rows.length !== 1 ? "s" : ""}
        </span>
      </div>
      {/* The top mirror of the grid's horizontal scrollbar. It holds no content
          — only a spacer sized to the grid's scroll width (see
          useGridScrollMirror) — so it is kept out of the accessibility tree and
          out of the tab order. */}
      <div className="grid-scroll-top" ref={topScrollRef} aria-hidden="true" tabIndex={-1}>
        <div className="grid-scroll-top-inner" ref={topSpacerRef} />
      </div>
      {/* .grid-scroll, not .grid-wrap: it adds only the horizontal overflow the
          sticky first column needs, without a second border/radius/background
          stacked inside .card. It must be the element that actually overflows,
          since `position: sticky` resolves against its nearest scroll container. */}
      <div className="grid-scroll" ref={gridScrollRef}>
        <table className="grid" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th>Student / School</th>
              {!hiddenBase.has(BASE_KEYS.submissionId) && <th>Submission ID</th>}
              {!hiddenBase.has(BASE_KEYS.status) && <th>Status</th>}
              {!hiddenBase.has(BASE_KEYS.submitted) && <th>Submitted</th>}
              {columns.map((c) => (
                <th key={c.key}>
                  {c.label}
                  {c.staff_only && (
                    <span className="badge badge-slate tag" style={{ marginLeft: 6 }}>
                      Staff
                    </span>
                  )}
                </th>
              ))}
              {!hiddenBase.has(BASE_KEYS.actions) && <th style={{ width: 120 }}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const rowValues = valuesByPublicId.get(s.public_id);
              return (
                <tr key={s.public_id}>
                  {/* The frozen column. `grid-cell-pinned` caps its width so a long
                      school name can't grow the pinned area past the viewport. */}
                  <td
                    className="cell-strong grid-cell-pinned"
                    style={{ whiteSpace: "nowrap" }}
                    data-label="Student / School"
                  >
                    <a
                      className="link-name"
                      href={submissionPath(s.public_id)}
                      onClick={(e) => {
                        e.preventDefault();
                        onOpen(s.public_id);
                      }}
                    >
                      {s.student_name || "Unnamed submission"}
                    </a>
                    <span className="cell-mono" style={{ marginLeft: 8, whiteSpace: "nowrap" }}>
                      {s.school_name ?? "—"}
                    </span>
                  </td>
                  {!hiddenBase.has(BASE_KEYS.submissionId) && (
                    <td className="cell-mono" data-label="Submission ID">{shortId(s.public_id)}</td>
                  )}
                  {!hiddenBase.has(BASE_KEYS.status) && (
                    <td data-label="Status">
                      <StatusBadge status={s.status} />
                    </td>
                  )}
                  {!hiddenBase.has(BASE_KEYS.submitted) && (
                    <td className="cell-mono" data-label="Submitted">{formatDate(s.submitted_at)}</td>
                  )}

                  {columns.map((c) => {
                    const fieldId = fieldIdFromKey(c.key);
                    const meta = fieldMeta.get(fieldId);
                    const value = rowValues?.[c.key] ?? null;
                    const raw = meta ?? {
                      id: fieldId,
                      label: c.label,
                      type: "text" as const,
                      options: null,
                    };
                    return (
                      <StaffCell
                        key={c.key}
                        column={c}
                        publicId={s.public_id}
                        value={value}
                        field={raw}
                        edit={edit}
                      />
                    );
                  })}

                  {!hiddenBase.has(BASE_KEYS.actions) && (
                    <td data-label="Actions">
                      <button className="badge-button" onClick={() => onOpen(s.public_id)}>
                        Review
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The grid's horizontal scrollbar, mirrored above it.
//
// A grid wider than its container puts its one horizontal scrollbar at the
// *bottom* of the table, so reaching it costs a scroll past every row. This
// pairs the grid's scroll container with a second, empty one directly above it
// holding a single spacer sized to the grid's scroll width. Same client width,
// same scroll range — so either bar can drive the other, and the frozen first
// column is untouched because the mirror is a sibling, not a parent.
//
// Sync is by assignment rather than accumulation: setting `scrollLeft` to the
// value it already holds is a no-op that fires no event, which is what stops the
// two listeners bouncing off each other. No lock flag is needed.
// ---------------------------------------------------------------------------
function useGridScrollMirror({
  gridScrollRef,
  topScrollRef,
  topSpacerRef,
  rowCount,
}: {
  gridScrollRef: RefObject<HTMLDivElement | null>;
  topScrollRef: RefObject<HTMLDivElement | null>;
  topSpacerRef: RefObject<HTMLDivElement | null>;
  /** Carried only to re-run the effect when the row count changes. */
  rowCount: number;
}) {
  useEffect(() => {
    const grid = gridScrollRef.current;
    const top = topScrollRef.current;
    const spacer = topSpacerRef.current;
    if (!grid || !top || !spacer) return;

    const measure = () => {
      const range = grid.scrollWidth;
      // Thickness of the grid's own horizontal scrollbar, read off the grid
      // rather than hard-coded. It is 0 on platforms with overlay scrollbars,
      // which is exactly the signal to leave the mirror collapsed instead of
      // reserving a blank strip for a bar that draws over the content anyway.
      const thickness = Math.max(0, grid.offsetHeight - grid.clientHeight);
      spacer.style.width = `${range}px`;
      top.style.height = thickness ? `${thickness}px` : "";
      // Hidden unless there is something to mirror. This is also what keeps the
      // bar off on mobile, where the rows become stacked cards and the table
      // stops overflowing at all — the CSS has a hard off there as well, so it
      // can never surface as a stray strip.
      const active = range - grid.clientWidth > 1;
      top.classList.toggle("grid-scroll-top-active", active);
      // Only after the class flip: a `display: none` element has no scrollable
      // overflow, so a scrollLeft written while hidden is clamped straight to 0.
      if (active && top.scrollLeft !== grid.scrollLeft) top.scrollLeft = grid.scrollLeft;
    };

    measure();

    // The column set is dynamic and every width is auto, so the scroll range
    // changes with the data and with the viewport — neither of which is
    // expressible as a dependency. The table is observed as well as the
    // container because adding a column to an already-overflowing grid changes
    // the table's box and not the container's. Nothing observed here is resized
    // by this callback, so it cannot feed itself.
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    const table = grid.querySelector("table");
    if (table) observer.observe(table);

    const fromGrid = () => {
      if (top.scrollLeft !== grid.scrollLeft) top.scrollLeft = grid.scrollLeft;
    };
    const fromTop = () => {
      if (grid.scrollLeft !== top.scrollLeft) grid.scrollLeft = top.scrollLeft;
    };
    grid.addEventListener("scroll", fromGrid, { passive: true });
    top.addEventListener("scroll", fromTop, { passive: true });

    return () => {
      observer.disconnect();
      grid.removeEventListener("scroll", fromGrid);
      top.removeEventListener("scroll", fromTop);
    };
  }, [gridScrollRef, topScrollRef, topSpacerRef, rowCount]);
}

// ---------------------------------------------------------------------------
// One field cell. Read-only for parent fields; click-to-edit for staff-only ones.
// ---------------------------------------------------------------------------
function StaffCell({
  column,
  publicId,
  value,
  field,
  edit,
}: {
  column: ExportColumn;
  publicId: string;
  value: unknown;
  field: Pick<FormField, "id" | "label" | "type" | "options">;
  edit: CellEditApi;
}) {
  const isEditing = edit.editing?.publicId === publicId && edit.editing?.fieldId === field.id;
  const key = cellKey(publicId, field.id);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const type = field.type;
  const mode = editorMode(type, field.options);

  // Focus the control as soon as the cell becomes an editor, so a click lands the
  // caret rather than requiring a second click. Text inputs select their existing
  // value so it can be typed over.
  useEffect(() => {
    if (!isEditing || mode === "menu") return;
    const el = editorRef.current?.querySelector<HTMLElement>("input, select, textarea");
    if (!el) return;
    el.focus();
    if (el instanceof HTMLInputElement && (el.type === "text" || el.type === "number" || el.type === "date" || el.type === "email")) {
      el.select();
    }
  }, [isEditing, mode]);

  // Parent fields are shown but never edited — they belong to the parent, and the
  // staff-only save path would mislabel the audit trail.
  if (!column.staff_only) {
    return (
      <td data-label={column.label} style={{ whiteSpace: "nowrap" }}>
        {displayValue(value, type)}
      </td>
    );
  }

  const begin = (e: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>) => {
    if (edit.saving) return;
    const rect = e.currentTarget.getBoundingClientRect();
    edit.begin({ publicId, fieldId: field.id }, rect, toAnswerValue(value));
  };

  if (isEditing) {
    // While the save is in flight the value is authoritative on neither side, so
    // show the in-flight value rather than a control the user can keep typing in.
    if (edit.saving) {
      return (
        <td data-label={column.label} className="grid-cell-saving">
          Saving…
        </td>
      );
    }
    if (mode === "menu") {
      return (
        <td data-label={column.label} className="grid-editable">
          <GridOptionMenu
            type={type}
            options={field.options ?? []}
            value={edit.draft}
            position={edit.anchor}
            onChange={edit.change}
            onCancel={edit.cancel}
            onSave={() => edit.commit()}
          />
          <span className="cell-mono">{displayValue(edit.draft, type)}</span>
        </td>
      );
    }
    return (
      <td data-label={column.label} className="grid-editable">
        <div
          className="grid-editor"
          ref={editorRef}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              edit.cancel();
              return;
            }
            // Enter commits; Shift+Enter is a newline in a textarea.
            if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement && e.shiftKey)) {
              e.preventDefault();
              edit.commit();
            }
          }}
          onBlur={(e) => {
            // Commit only when focus leaves the editor entirely (e.g. clicking
            // another cell), not when it moves between controls inside it.
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) edit.commit();
          }}
        >
          {renderEditor(
            type,
            field.options,
            edit.draft,
            (val) => (commitsOnChange(type, field.options) ? edit.commit(val) : edit.change(val)),
            `cell-${publicId}-${field.id}`
          )}
        </div>
        {edit.error && <span className="grid-cell-error">{edit.error}</span>}
      </td>
    );
  }

  return (
    <td data-label={column.label} className="grid-editable">
      <span
        className={`grid-cell-value ${edit.savedKeys.has(key) ? "grid-cell-saved" : ""}`}
        role="button"
        tabIndex={0}
        title="Click to edit"
        aria-label={`Edit ${column.label}`}
        onClick={begin}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            begin(e);
          }
        }}
      >
        {displayValue(value, type)}
        <Pencil size={12} className="cell-edit-hint" />
      </span>
    </td>
  );
}

// ---------------------------------------------------------------------------
// Option menu for multi-option fields, portalled to <body>.
//
// It cannot live inside the cell: .grid-scroll sets overflow-x: auto, which
// computes overflow-y to auto as well, so an absolutely-positioned child is
// clipped at the scroll edge. `position: fixed` against the cell's rect avoids
// the clipping entirely.
// ---------------------------------------------------------------------------
function GridOptionMenu({
  type,
  options,
  value,
  position,
  onChange,
  onCancel,
  onSave,
}: {
  type: string;
  options: string[];
  value: AnswerValue;
  position: { left: number; top: number } | null;
  onChange: (val: AnswerValue) => void;
  onCancel: () => void;
  onSave: () => void;
}): ReactNode {
  const arr = Array.isArray(value) ? value : [];
  return createPortal(
    <>
      <div className="grid-menu-backdrop" onClick={onCancel} />
      <div
        className="grid-menu"
        style={position ? { left: position.left, top: position.top } : undefined}
        role="dialog"
        aria-label="Select a value"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
          if (e.key === "Enter") {
            e.preventDefault();
            onSave();
          }
        }}
      >
        {options.map((o, i) => (
          <label key={o}>
            <input
              autoFocus={i === 0}
              type={type === "radio" ? "radio" : "checkbox"}
              name={type === "radio" ? "grid-cell-radio" : undefined}
              checked={type === "radio" ? toStr(value) === o : arr.includes(o)}
              onChange={(e) => {
                if (type === "radio") {
                  onChange(o);
                  return;
                }
                onChange(e.target.checked ? [...arr, o] : arr.filter((x) => x !== o));
              }}
            />
            {o}
          </label>
        ))}
        <div className="grid-menu-foot">
          <button type="button" className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary-button" onClick={onSave}>
            Save
          </button>
        </div>
      </div>
    </>,
    document.body
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Preview values are `unknown`; narrow them to what the save endpoint accepts so
// an edit round-trips the same shape it was read as.
function toAnswerValue(v: unknown): AnswerValue {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return String(v);
}

export function shortId(id: string): string {
  if (id.length <= 10) return id;
  return `${id.slice(0, 8)}…`;
}

export function formatDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
