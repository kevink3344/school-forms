import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { ExportColumn, ExportPreview, FormField } from "../types";
import type { AnswerValue } from "../components/FieldValue";
import type { PickerColumn } from "../components/ColumnsPicker";
import {
  cellKey,
  GRID_BASE_COLUMNS,
  GRID_PINNED_COLUMN,
  type CellEditApi,
  type EditingCell,
} from "../components/SubmissionsGrid";

// ---------------------------------------------------------------------------
// Shared Submissions-grid behaviour: which columns the grid shows, the column
// picker's selection, and inline editing of staff-only fields.
//
// Extracted from AdminDashboard when the same grid was given to staff and School
// Contacts. Two pages now drive it, and the parts that must not diverge are
// exactly the ones here: which columns are available, how a selection is seeded
// and persisted, and how a cell edit is saved.
//
// One selection set covers every column, standard ones included — `checked`
// means "shown" for both, so there is no second flag to keep in step. Standard
// columns are why the default is worth two separate notes: absent from a saved
// config they default to shown, and the pinned first column is in the set but is
// never toggled.
//
// `formId` 0 means "no single form selected" (the "All forms" / "All reports"
// case). Then there are no field columns at all and the standard ones all show.
// ---------------------------------------------------------------------------

// Keys that survive a reseed whatever form is loaded. The standard columns are
// not form data, so unlike a field key they can never be "missing" from the form
// the user just selected.
const STATIC_KEYS = new Set<string>([
  GRID_PINNED_COLUMN.key,
  ...GRID_BASE_COLUMNS.map((c) => c.key),
]);

/** Where an option menu of this size should sit so it stays on screen. */
export function menuPosition(rect: DOMRect): { left: number; top: number } {
  const W = 240;
  const H = 240;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - W - 12));
  const top =
    rect.bottom + 6 + H > window.innerHeight ? Math.max(8, rect.top - H - 6) : rect.bottom + 6;
  return { left, top };
}

export interface SubmissionGridOptions {
  /** The selected form, or 0 for "all forms". */
  formId: number;
  /** Status filter, forwarded to the preview so the values match the row list. */
  status?: string;
  /** Optional school filter. Ignored by the server for school-scoped roles. */
  schoolId?: number;
}

export interface SubmissionGridState {
  /** Every field column this form exposes to *this* user, in server order. */
  availableColumns: ExportColumn[];
  /** The subset the user has chosen to display. */
  visibleColumns: ExportColumn[];
  /** Everything the Columns drawer lists: pinned, standard, then the fields. */
  pickerColumns: PickerColumn[];
  /** The standard columns the grid should hide, as `base_*` keys. */
  hiddenBase: Set<string>;
  /** Field values keyed by submission public id, then by `field_N`. */
  valuesByPublicId: Map<string, Record<string, unknown>>;
  /** Field definitions by id — what makes a value renderable and editable. */
  fieldMeta: Map<number, FormField>;
  /** True while the extras for the selected form are still in flight. */
  extrasLoading: boolean;
  pickerOpen: boolean;
  openPicker: () => void;
  closePicker: () => void;
  checked: Set<string>;
  toggleColumn: (key: string) => void;
  toggleAll: () => void;
  selectedCount: number;
  edit: CellEditApi;
}

export function useSubmissionGrid({
  formId,
  status,
  schoolId,
}: SubmissionGridOptions): SubmissionGridState {
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [fieldMeta, setFieldMeta] = useState<Map<number, FormField>>(new Map());
  const [valuesByPublicId, setValuesByPublicId] = useState<Map<string, Record<string, unknown>>>(
    new Map()
  );
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);

  // Which form the loaded extras belong to. Comparing it against the selected
  // form is what lets the grid be held back on the frame where the form changes,
  // instead of flashing the previous form's columns before the spinner appears.
  const [extrasFormId, setExtrasFormId] = useState(0);

  // Which form the selection in `checked` belongs to, so a refetch of the SAME
  // form (status/school change) preserves the user's choice instead of reseeding
  // over the top of it.
  const selectionFormRef = useRef(0);
  // Only a deliberate change is persisted, so merely opening the picker and
  // closing it again never writes a config for a form nobody configured.
  const pickerDirtyRef = useRef(false);

  useEffect(() => {
    if (!formId) {
      selectionFormRef.current = 0;
      setPreview(null);
      setFieldMeta(new Map());
      setValuesByPublicId(new Map());
      // Every standard column, not an empty set. With no single form selected
      // there is no per-form config and no picker to open (the Columns button is
      // disabled), so the grid has to fall back to showing them all. An empty
      // set would read as "hide every standard column" and leave the grid with
      // nothing but the pinned one.
      setChecked(new Set(STATIC_KEYS));
      pickerDirtyRef.current = false;
      setExtrasFormId(0);
      return;
    }

    let cancelled = false;
    Promise.all([
      api.getFormViewColumns(formId),
      api.exportPreview({ form_id: formId, status, school_id: schoolId }),
    ])
      .then(([cfg, prev]) => {
        if (cancelled) return;
        setPreview(prev);
        // The preview carries `type`/`options` on every column, so the two calls
        // above are enough. This used to also call `api.getForm(formId)`, which
        // is admin-only — staff and School Contacts need the grid just as much,
        // and the metadata now travels with the columns instead.
        const meta = new Map<number, FormField>();
        for (const c of prev.columns) {
          const m = /^field_(\d+)$/.exec(c.key);
          if (!m) continue;
          const id = Number(m[1]);
          meta.set(id, {
            id,
            form_id: formId,
            label: c.label,
            type: c.type ?? "text",
            options: c.options ?? null,
            required: false,
            staff_only: c.staff_only,
            roles: c.roles,
            sort_order: 0,
            placeholder: null,
          });
        }
        setFieldMeta(meta);

        const byPublicId = new Map<string, Record<string, unknown>>();
        for (const row of prev.rows) {
          const pid = row.submission_public_id;
          if (typeof pid === "string") byPublicId.set(pid, row);
        }
        setValuesByPublicId(byPublicId);

        const available = new Set(prev.columns.map((c) => c.key));
        // A standard column is never dropped for being absent from this form.
        const keep = (k: string) => available.has(k) || STATIC_KEYS.has(k);
        if (selectionFormRef.current === formId) {
          // Same form refetched — keep the selection, dropping only keys that no
          // longer exist.
          setChecked((cur) => new Set([...cur].filter(keep)));
        } else {
          selectionFormRef.current = formId;
          // First load for this form. `configured` is the whole reason the
          // distinction exists: a saved empty selection means "show no extra
          // fields", which is NOT the same as "never configured". An
          // unconfigured form defaults to its staff-only fields, since those are
          // the ones a reviewer works through on this screen.
          //
          // The standard columns come from `hiddenBase` in *both* cases, which
          // is why it is stored negated: an unconfigured form and a config saved
          // before these were hideable both carry an empty list, so both show
          // every standard column without a special case.
          const hidden = new Set(cfg.hiddenBase);
          const seed = [
            GRID_PINNED_COLUMN.key,
            ...GRID_BASE_COLUMNS.map((c) => c.key).filter((k) => !hidden.has(k)),
            ...(cfg.configured
              ? cfg.viewKeys
              : prev.columns.filter((c) => c.staff_only).map((c) => c.key)),
          ];
          setChecked(new Set(seed.filter(keep)));
          pickerDirtyRef.current = false;
        }
      })
      .catch(() => {
        if (cancelled) return;
        setPreview(null);
        setFieldMeta(new Map());
        setValuesByPublicId(new Map());
      })
      .finally(() => {
        if (!cancelled) setExtrasFormId(formId);
      });

    return () => {
      cancelled = true;
    };
  }, [formId, status, schoolId]);

  const availableColumns = useMemo<ExportColumn[]>(() => preview?.columns ?? [], [preview]);
  const visibleColumns = useMemo(
    () => availableColumns.filter((c) => checked.has(c.key)),
    [availableColumns, checked]
  );

  // The negation of `checked`, derived rather than stored: one set to keep
  // coherent instead of two that can disagree. The pinned column is not in
  // GRID_BASE_COLUMNS, so it can never end up in here and be hidden.
  const hiddenBase = useMemo(
    () => new Set(GRID_BASE_COLUMNS.map((c) => c.key).filter((k) => !checked.has(k))),
    [checked]
  );

  // Everything the drawer lists: the pinned column first (locked), then the
  // standard columns, then the form's fields — the order the grid renders them
  // in, so the picker reads as a picture of the table.
  const pickerColumns = useMemo<PickerColumn[]>(() => {
    const staticRows: PickerColumn[] = [
      { key: GRID_PINNED_COLUMN.key, label: GRID_PINNED_COLUMN.label, locked: true },
      ...GRID_BASE_COLUMNS,
    ];
    return [
      ...staticRows,
      ...availableColumns.map((c) => ({
        key: c.key,
        label: c.label,
        staff_only: c.staff_only,
      })),
    ];
  }, [availableColumns]);

  const toggleColumn = (key: string) => {
    // The pinned column is listed so that its locked state is visible, but it is
    // not a choice — and it must stay in `checked`, since that is what draws it.
    if (key === GRID_PINNED_COLUMN.key) return;
    pickerDirtyRef.current = true;
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    pickerDirtyRef.current = true;
    setChecked((prev) => {
      // Over the removable columns only — the same set ColumnsPicker tests for
      // "all", so the tick and the label cannot disagree. The pinned column is
      // re-added rather than skipped so it survives a three-way toggle.
      const removable = [
        ...GRID_BASE_COLUMNS.map((c) => c.key),
        ...availableColumns.map((c) => c.key),
      ];
      const all = removable.length > 0 && removable.every((k) => prev.has(k));
      const next = new Set(prev);
      next.add(GRID_PINNED_COLUMN.key);
      for (const k of removable) {
        if (all) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  };

  // Saving happens once, on close, rather than on every tick: the grid is driven
  // by local state so toggling stays instant, and a drawer session that ends up
  // back where it started writes nothing at all.
  const closePicker = () => {
    setPickerOpen(false);
    if (!formId || !pickerDirtyRef.current) return;
    pickerDirtyRef.current = false;
    const keys = availableColumns.filter((c) => checked.has(c.key)).map((c) => c.key);
    // Negated on the way out, to match how it is stored and read back.
    const hidden = GRID_BASE_COLUMNS.map((c) => c.key).filter((k) => !checked.has(k));
    api.setFormViewColumns(formId, keys, hidden).catch(() => {
      // The on-screen selection still applies for this session; it just will not
      // be remembered. Not worth interrupting the user over.
    });
  };

  // ---------------------------------------------------------------------------
  // Inline staff-only editing.
  //
  // Refs shadow the editing state because one gesture can reach `commit` twice (a
  // select commits on change, then blurs as it unmounts) and because we must not
  // act on a stale closure mid-flight. The refs are authoritative; the state below
  // exists only to render.
  // ---------------------------------------------------------------------------
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [draft, setDraft] = useState<AnswerValue>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ left: number; top: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());

  const editingRef = useRef<EditingCell | null>(null);
  const draftRef = useRef<AnswerValue>(null);
  const savingRef = useRef(false);
  const closedRef = useRef(true);
  const flashTimers = useRef<number[]>([]);

  useEffect(
    () => () => {
      for (const t of flashTimers.current) window.clearTimeout(t);
    },
    []
  );

  const beginEdit = (cell: EditingCell, rect: DOMRect, initial: AnswerValue) => {
    editingRef.current = cell;
    draftRef.current = initial;
    savingRef.current = false;
    closedRef.current = false;
    setEditing(cell);
    setDraft(initial);
    setSaveError(null);
    setMenuAnchor(menuPosition(rect));
  };

  const changeDraft = (val: AnswerValue) => {
    draftRef.current = val;
    setDraft(val);
  };

  const closeEditor = () => {
    editingRef.current = null;
    draftRef.current = null;
    closedRef.current = true;
    setEditing(null);
    setDraft(null);
    setMenuAnchor(null);
  };

  const cancelEdit = () => {
    closeEditor();
    setSaveError(null);
  };

  const commitEdit = async (override?: AnswerValue) => {
    if (savingRef.current || closedRef.current) return;
    const cell = editingRef.current;
    if (!cell) return;
    const value = override === undefined ? draftRef.current : override;
    // Keep the attempted value visible so a failed save leaves the user looking
    // at what they typed rather than at what is still on the server.
    draftRef.current = value;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      // MUST go through PUT /values with staff_only: true. That is what records
      // the staff audit trail (staff_fields_updated_by / _at) and what triggers
      // the staff-only "Generate document" workflow — a bespoke per-cell endpoint
      // would silently skip both.
      await api.updateSubmissionValues(cell.publicId, [{ field_id: cell.fieldId, value }], {
        staffOnly: true,
      });
      const key = cellKey(cell.publicId, cell.fieldId);
      setValuesByPublicId((prev) => {
        const next = new Map(prev);
        const row = { ...(next.get(cell.publicId) ?? {}) };
        row[`field_${cell.fieldId}`] = value;
        next.set(cell.publicId, row);
        return next;
      });
      closeEditor();
      setSavedKeys((prev) => new Set(prev).add(key));
      const t = window.setTimeout(() => {
        setSavedKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }, 1400);
      flashTimers.current.push(t);
    } catch (err) {
      // No optimistic write: the editor stays open with an inline error so the
      // grid never shows a value the server rejected.
      setSaveError(err instanceof ApiError ? err.message : "Could not save this value.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const edit: CellEditApi = {
    editing,
    draft,
    saving,
    error: saveError,
    savedKeys,
    anchor: menuAnchor,
    begin: beginEdit,
    change: changeDraft,
    commit: (value) => void commitEdit(value),
    cancel: cancelEdit,
  };

  return {
    availableColumns,
    visibleColumns,
    pickerColumns,
    hiddenBase,
    valuesByPublicId,
    fieldMeta,
    extrasLoading: formId > 0 && extrasFormId !== formId,
    pickerOpen,
    openPicker: () => setPickerOpen(true),
    closePicker,
    checked,
    toggleColumn,
    toggleAll,
    // Counts every row the drawer lists, pinned column included, so it agrees
    // with the "N of M columns" the drawer footer shows.
    selectedCount: pickerColumns.filter((c) => checked.has(c.key)).length,
    edit,
  };
}
