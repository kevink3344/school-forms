import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Check, Pencil, Paperclip, Trash2, X } from "lucide-react";
import type { ExportColumn, FormField, SubmissionRow } from "../types";
import { StatusBadge } from "./layout";
import { renderEditor, renderValue, toStr, displayValue, type AnswerValue } from "./FieldValue";
import type { ColumnEditApi } from "../lib/useColumnEdit";
import { menuPosition } from "../lib/useCellEdit";

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
// The pinned column's link TEXT is `link_label`, which the server builds from the
// form's configured answers (docs/plans/submission-link-label.md) and falls back
// to the first non-staff answer when the form has configured none. A blank label
// renders "None" rather than a placeholder: the admin chose those fields, so an
// empty result is an answer about the submission, not a missing name.
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

// Shared with the Reports grid, which edits the same staff-only fields over its
// own rows. The `field_N` key format is the contract with the server (see
// `withFieldId` in server/src/export/table.ts); a second copy of this regex on
// another page would be one edit away from disagreeing with this one.
export { cellKey, fieldIdFromKey };

// Multi-option fields get a portalled option menu instead of an inline control:
// the labels are long, and the cell is one column wide. Everything else edits in
// place. A single-option checkbox is a boolean toggle (see renderEditor), and a
// `toggle` field is a switch, so both commit immediately like a select does.
function editorMode(type: string, options: string[] | null): "immediate" | "menu" {
  if (type === "radio") return "menu";
  if (type === "checkbox" && (options ?? []).length > 1) return "menu";
  return "immediate";
}
// Selects, single-option checkbox toggles and `toggle` switches are one-gesture
// controls: the change *is* the decision, so there is nothing to confirm.
// Text-like types hold a draft until Enter / blur.
function commitsOnChange(type: string, options: string[] | null): boolean {
  if (type === "select") return true;
  if (type === "toggle") return true;
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
  /**
   * Supplying this adds a destructive Delete action to every row. Omitted means
   * no Delete control is rendered at all — which is how the Active view and the
   * staff queue stay free of a button their user cannot use, rather than showing
   * a disabled one that has to explain itself.
   *
   * The owner decides when to supply it (the admin Archive view only); this file
   * does not check the role, because it does not know which queue it is drawing.
   * It also does not confirm — the owner owns the confirmation step, so the
   * wording can name what is being deleted.
   */
  onDelete,
  /**
   * Supplying this turns every staff-only column header into a bulk-edit target
   * (docs/plans/column-bulk-edit.md). Omitted means the header carries no pencil
   * and the grid behaves exactly as before — which is how the Reports page keeps
   * its single-cell editing without knowing this mode exists.
   */
  columnEdit,
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
  /** Adds a permanent-delete action to each row when supplied. */
  onDelete?: (publicId: string) => void;
  /** Adds the bulk column editor to staff-only headers when supplied. */
  columnEdit?: ColumnEditApi;
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
                /* Staff-only columns carry no in-header badge: it cost a column's
                   worth of width in a grid where width is the scarce resource, and
                   it repeated the same word once per column. The column marks
                   itself instead (`.grid-col-staff`) and these two attributes keep
                   the meaning available to a screen reader and to a mouse hover.

                   A staff-only column whose header is given `columnEdit` also
                   carries the bulk-edit pencil (docs/plans/column-bulk-edit.md):
                   a real button, revealed on hover AND on focus, so the mode is
                   reachable by keyboard rather than being a hover-only affordance. */
                <th
                  key={c.key}
                  className={c.staff_only ? "grid-col-staff grid-col-staff-head" : undefined}
                  aria-label={c.staff_only ? `${c.label} (staff only)` : undefined}
                  title={c.staff_only ? "Staff-only column" : undefined}
                >
                  <span className="grid-head-inner">
                    <span className="grid-head-label">{c.label}</span>
                    {c.staff_only && columnEdit && (
                      <ColumnEditButton
                        label={c.label}
                        active={columnEdit.activeFieldId === fieldIdFromKey(c.key)}
                        onToggle={() => columnEdit.begin(fieldIdFromKey(c.key))}
                      />
                    )}
                  </span>
                </th>
              ))}
              {!hiddenBase.has(BASE_KEYS.actions) && (
                /* The width follows the number of buttons in the cell. A
                   destructive action makes it two, and a declared width that is
                   narrower than nowrap content does not shrink it — the column
                   wins and the grid just scrolls further, so the header would
                   stop describing the cell it heads. 178 leaves the ~164px of
                   real content slack rather than a zero-slack box, where
                   sub-pixel rounding pushes a button out of its own cell. */
                <th style={{ width: onDelete ? 178 : 120 }}>Actions</th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const rowValues = valuesByPublicId.get(s.public_id);
              return (
                <tr key={s.public_id}>
                  {/* The frozen column. `grid-cell-pinned` caps its width so a long
                      school name can't grow the pinned area past the viewport. */}
                  {/* No inline `white-space` here: single-line values are a desktop
                      presentation and live in the stylesheet, because the mobile card
                      view has to reverse it and an inline declaration cannot be
                      overridden by a rule (see `.grid-cell-pinned` in global.css). */}
                  <td className="cell-strong grid-cell-pinned" data-label="Student / School">
                    {/* The name and its marker share a row so the marker sits
                        BESIDE the name rather than on the school line below it,
                        and so a long name truncates in the space that is left
                        instead of pushing the icon out of the pinned column. */}
                    <span className="grid-name-row">
                      <a
                        className="link-name"
                        href={submissionPath(s.public_id)}
                        onClick={(e) => {
                          e.preventDefault();
                          onOpen(s.public_id);
                        }}
                      >
                        {s.link_label || "None"}
                      </a>
                      {/* Attachments and/or links exist on this submission
                          (docs/plans/staff-attachments.md §3.7). The server
                          resolves the flag, so the grid never guesses; the label
                          is on the wrapper because the icon alone says nothing to
                          a screen reader. */}
                      {s.has_attachments && (
                        <span
                          className="grid-name-marker"
                          title="This submission has attachments or links"
                          aria-label="Has attachments or links"
                          role="img"
                        >
                          <Paperclip size={12} aria-hidden="true" />
                        </span>
                      )}
                    </span>
                    {/* Both inline declarations that used to sit here are gone.
                        `marginLeft: 8` was already dead: `.grid-cell-pinned
                        .cell-mono` resets it to 0 with `!important` in both the
                        desktop and mobile rules. `whiteSpace: "nowrap"` was the
                        live one — and an inline declaration beats every rule, so
                        the school name stayed on one line on a phone and ran
                        8px past the card (342px inside a 345px table) while the
                        stylesheet's own `white-space: normal` could not reach it.
                        The stylesheet now owns both properties. */}
                    <span className="cell-mono">{s.school_name ?? "—"}</span>
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
                        columnEdit={columnEdit}
                        rowArchived={Boolean(s.archived_at)}
                      />
                    );
                  })}

                  {!hiddenBase.has(BASE_KEYS.actions) && (
                    <td data-label="Actions" className="grid-cell-actions">
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <button className="badge-button" onClick={() => onOpen(s.public_id)}>
                          Review
                        </button>
                        {/* Only in a view that supplied the handler — i.e. only the
                            admin Archive view. Deliberately not disabled elsewhere:
                            a disabled Delete on a live row invites the question
                            "why can't I?" at every row, forever. */}
                        {onDelete && (
                          <button
                            className="badge-button danger"
                            onClick={() => onDelete(s.public_id)}
                            title="Delete this archived submission permanently"
                          >
                            <Trash2 size={13} aria-hidden="true" />
                            Delete
                          </button>
                        )}
                      </span>
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
//
// Exported because the Reports preview renders staff-only columns too: a School
// Contact can export those columns and can see them in the report grid, and the
// server authorizes the same roles for the save. Rendering them through this same
// cell is what makes "click the value, type, save" behave identically on both
// pages, including the pencil, the saved flash and the error line.
// ---------------------------------------------------------------------------
export function StaffCell({
  column,
  publicId,
  value,
  field,
  edit,
  columnEdit,
  rowArchived = false,
}: {
  column: ExportColumn;
  publicId: string;
  value: unknown;
  field: Pick<FormField, "id" | "label" | "type" | "options">;
  edit: CellEditApi;
  /** Supplied by the Submissions grid; absent on the Reports page. */
  columnEdit?: ColumnEditApi;
  /** An archived row is never written in bulk — the editor renders it disabled. */
  rowArchived?: boolean;
}) {
  const isEditing = edit.editing?.publicId === publicId && edit.editing?.fieldId === field.id;
  const key = cellKey(publicId, field.id);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const type = field.type;
  const mode = editorMode(type, field.options);

  // Bulk mode owns the whole column: when it is active, this cell renders the
  // draft control instead of the click-to-edit span, so a cell is never both.
  const bulkActive = columnEdit?.activeFieldId === field.id;
  const bulkDraft = bulkActive ? columnEdit!.drafts.get(key) : undefined;
  const bulkValue = bulkDraft === undefined ? toAnswerValue(value) : bulkDraft;
  const bulkDirty = bulkActive ? columnEdit!.dirtyKeys.has(key) : false;
  const bulkSaved = bulkActive ? columnEdit!.savedKeys.has(key) : false;
  const bulkRowError = bulkActive ? columnEdit!.rowErrors.get(publicId) : undefined;
  const bulkMenuRef = useRef<HTMLButtonElement | null>(null);
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);

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
  // staff-only save path would mislabel the audit trail. Staff-only columns opt
  // into the `.grid-col-staff` wash via each of the branches below.
  if (!column.staff_only) {
    return (
      /* `grid-field-cell` carries the desktop single-line rule in the stylesheet
         rather than inline here, so the mobile card view can wrap a long value
         such as a Parent/Guardian name instead of clipping it at the cell edge. */
      <td data-label={column.label} className="grid-field-cell">
        {renderValue(value, type)}
      </td>
    );
  }

  const begin = (e: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>) => {
    if (edit.saving) return;
    const rect = e.currentTarget.getBoundingClientRect();
    edit.begin({ publicId, fieldId: field.id }, rect, toAnswerValue(value));
  };

  // Bulk column mode. Every cell in the active staff-only column becomes a
  // control bound to the hook's draft map — no per-cell save, no per-cell audit
  // stamp; the column's one Save writes the batch.
  if (bulkActive && columnEdit) {
    const api = columnEdit;
    const disabled = api.saving || rowArchived;
    return (
      <td
        data-label={column.label}
        className={`grid-col-staff grid-col-bulk${bulkDirty ? " grid-cell-dirty" : ""}${
          bulkSaved ? " grid-cell-saved-td" : ""
        }`}
      >
        {rowArchived ? (
          <span className="grid-bulk-disabled" title="Archived submissions cannot be edited">
            {renderValue(value, type)}
          </span>
        ) : mode === "menu" ? (
          <button
            ref={bulkMenuRef}
            type="button"
            className="grid-bulk-menu-trigger"
            disabled={disabled}
            aria-label={`Edit ${column.label}`}
            onClick={() => setBulkMenuOpen(true)}
          >
            <span className="grid-bulk-value">{displayValue(bulkValue, type)}</span>
          </button>
        ) : (
          <div className="grid-bulk-editor">
            {renderEditor(
              type,
              field.options,
              bulkValue,
              (val) => api.change(publicId, val),
              `bulk-${publicId}-${field.id}`
            )}
          </div>
        )}
        {bulkMenuOpen && mode === "menu" && (
          <GridOptionMenu
            type={type}
            options={field.options ?? []}
            value={bulkValue}
            position={bulkMenuRef.current ? menuPosition(bulkMenuRef.current.getBoundingClientRect()) : null}
            onChange={(val) => api.change(publicId, val)}
            onCancel={() => setBulkMenuOpen(false)}
            onSave={() => setBulkMenuOpen(false)}
          />
        )}
        {bulkRowError && <span className="grid-cell-error">{bulkRowError}</span>}
      </td>
    );
  }

  if (isEditing) {
    // While the save is in flight the value is authoritative on neither side, so
    // show the in-flight value rather than a control the user can keep typing in.
    if (edit.saving) {
      return (
        <td data-label={column.label} className="grid-col-staff grid-cell-saving">
          Saving…
        </td>
      );
    }
    if (mode === "menu") {
      return (
        <td data-label={column.label} className="grid-col-staff grid-editable">
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
      <td data-label={column.label} className="grid-col-staff grid-editable">
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
    <td data-label={column.label} className="grid-col-staff grid-editable">
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
        {renderValue(value, type)}
        <Pencil size={12} className="cell-edit-hint" />
      </span>
    </td>
  );
}

// ---------------------------------------------------------------------------
// The bulk-editor affordance in a staff-only column header.
//
// A button, not an icon: it is the only way into the mode, so it has to be
// reachable by keyboard and announced. `aria-pressed` carries the mode, and the
// label names the column so a screen-reader user hears which one they are about
// to edit — the visible pencil is hidden from the tree.
// ---------------------------------------------------------------------------
function ColumnEditButton({
  label,
  active,
  onToggle,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`grid-col-edit-hint${active ? " is-active" : ""}`}
      aria-pressed={active}
      aria-label={active ? `Stop editing all ${label} values` : `Edit all ${label} values`}
      title={active ? "Stop editing this column" : "Edit every value in this column"}
      onClick={(e) => {
        // The header is not a link, but stopping propagation keeps a future
        // sort-on-header-click from firing when the pencil is used.
        e.stopPropagation();
        onToggle();
      }}
    >
      <Pencil size={12} aria-hidden="true" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// The bulk editor's save bar.
//
// Rendered by the owning page directly under the grid rather than inside it: the
// grid's scroll container clips absolutely-positioned children, and the bar has
// to stay visible while the user scrolls the column they are editing. It shows
// only while a column is active, so a grid that never uses the mode is unchanged.
// ---------------------------------------------------------------------------
export function ColumnEditBar({
  columnEdit,
  label,
}: {
  columnEdit: ColumnEditApi;
  /** The column's header text, so the bar names what it is about to write. */
  label: string | null;
}) {
  if (columnEdit.activeFieldId === null) return null;
  const dirty = columnEdit.dirtyKeys.size;
  const failed = columnEdit.rowErrors.size;
  return (
    <div className="grid-bulk-bar" role="region" aria-label={`Editing all ${label ?? ""} values`}>
      <span className="grid-bulk-bar-text">
        {columnEdit.saving
          ? `Saving ${dirty} ${dirty === 1 ? "value" : "values"}…`
          : dirty > 0
            ? `${dirty} unsaved ${dirty === 1 ? "change" : "changes"}`
            : "No changes yet"}
        {failed > 0 && !columnEdit.saving && (
          <span className="grid-bulk-bar-failed"> · {failed} not saved</span>
        )}
      </span>
      {columnEdit.error && <span className="grid-cell-error">{columnEdit.error}</span>}
      <span className="grid-bulk-bar-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={columnEdit.cancel}
          disabled={columnEdit.saving}
        >
          <X size={13} aria-hidden="true" /> Done
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={columnEdit.save}
          disabled={columnEdit.saving || dirty === 0}
          title={dirty === 0 ? "Change a value to save" : `Save ${dirty} values`}
        >
          <Check size={14} aria-hidden="true" /> {columnEdit.saving ? "Saving…" : "Save column"}
        </button>
      </span>
    </div>
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
