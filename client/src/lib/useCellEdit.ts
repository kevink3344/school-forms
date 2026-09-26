// ---------------------------------------------------------------------------
// The in-place cell editor's state machine: one editor open at a time, saved
// through PUT /values with `staff_only`, with a brief "saved" flash and a
// deliberately non-optimistic error path.
//
// Extracted from `useSubmissionGrid` when the Reports grid needed the same
// behaviour over its own rows. Both preview responses now carry each column's
// `type` and `options` (routes/export.ts and routes/reports.ts), so neither grid
// needs a second, admin-only call to build an editor. The only part that differs
// per page is where an accepted save is written, which the caller supplies as
// `onSaved` — the hook holds no values, only the cell being edited and its draft.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { cellKey, type CellEditApi, type EditingCell } from "../components/SubmissionsGrid";
import type { AnswerValue } from "../components/FieldValue";

/** How long an accepted cell keeps its `.grid-cell-saved` wash. */
export const SAVED_FLASH_MS = 1400;

/** Where an option menu of this size should sit so it stays on screen. */
export function menuPosition(rect: DOMRect): { left: number; top: number } {
  const W = 240;
  const H = 240;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - W - 12));
  const top =
    rect.bottom + 6 + H > window.innerHeight ? Math.max(8, rect.top - H - 6) : rect.bottom + 6;
  return { left, top };
}

export interface CellEditOptions {
  /**
   * Called with the value the server accepted. Patch the caller's own row store
   * here — that is the one place the two grids differ (the Submissions grid keeps
   * `valuesByPublicId`, the Reports page keeps an overlay on the preview rows).
   */
  onSaved: (publicId: string, fieldId: number, value: AnswerValue) => void;
}

export function useCellEdit({ onSaved }: CellEditOptions): CellEditApi {
  // Refs shadow the editing state because one gesture can reach `commit` twice (a
  // select commits on change, then blurs as it unmounts) and because we must not
  // act on a stale closure mid-flight. The refs are authoritative; the state below
  // exists only to render.
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

  // Read through a ref rather than closing over the prop: callers pass a fresh
  // arrow on most renders, and a closure would make every edit commit the
  // callback identity it was created with.
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  });

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
      onSavedRef.current(cell.publicId, cell.fieldId, value);
      closeEditor();
      const key = cellKey(cell.publicId, cell.fieldId);
      setSavedKeys((prev) => new Set(prev).add(key));
      const t = window.setTimeout(() => {
        setSavedKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }, SAVED_FLASH_MS);
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

  return {
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
}
