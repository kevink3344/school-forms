// ---------------------------------------------------------------------------
// The bulk column editor's state machine: one staff-only column becomes editable
// across every loaded row at once, with a draft per cell and ONE save.
//
// Deliberately a sibling of `useCellEdit` rather than a widening of it. That hook
// is a one-editor machine whose `CellEditApi` is consumed by three pages
// (AdminDashboard, StaffQueue, ReportsPage); bulk mode is a different machine —
// N drafts, one request, dirty tracking, a discard confirmation — and forcing it
// into `CellEditApi` would make every one of those pages care.
//
// Nothing is written until Save. A draft that differs from the row's saved value
// is "dirty"; Save sends every dirty cell for the active column in one batch
// (chunked under the server's 500-row cap) and keeps the drafts of any row the
// server refused, so a failed save never loses what was typed.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { cellKey } from "../components/SubmissionsGrid";
import { SAVED_FLASH_MS } from "./useCellEdit";
import type { AnswerValue } from "../components/FieldValue";
import type { SubmissionAnswer } from "../types";

/** The server rejects more than this per request; the client chunks below it. */
const BATCH_LIMIT = 200;

/** One row the editor can write: its public id and its current saved values. */
export interface ColumnEditRow {
  public_id: string;
  values: Record<string, unknown> | undefined;
}

export interface ColumnEditApi {
  /** The staff-only column currently in edit mode, or null. */
  activeFieldId: number | null;
  /** Draft values by `cellKey(publicId, fieldId)` — only cells that were touched. */
  drafts: Map<string, AnswerValue>;
  /** Cells whose draft differs from the row's saved value. */
  dirtyKeys: Set<string>;
  saving: boolean;
  /** Batch-level error (the request failed outright). */
  error: string | null;
  /** Per-row refusals from the last save, by public id. */
  rowErrors: Map<string, string>;
  /** Cells to flash after an accepted save. */
  savedKeys: Set<string>;
  begin: (fieldId: number) => void;
  change: (publicId: string, value: AnswerValue) => void;
  save: () => void;
  cancel: () => void;
}

export interface ColumnEditOptions {
  /** The rows currently loaded — the scope of a bulk save. */
  rows: ColumnEditRow[];
  /**
   * Called with every value the server accepted, one call per cell. The caller
   * patches its own row store; this hook holds no values beyond the drafts.
   */
  onSaved: (publicId: string, fieldId: number, value: AnswerValue) => void;
  /**
   * Asks the user to confirm discarding unsaved changes. Returns true to
   * discard. Supplied by the page so the wording can name what is being lost;
   * without it a dirty column is discarded silently (used by callers that have
   * their own guard).
   */
  confirmDiscard?: (count: number) => boolean;
}

// Preview values are `unknown`; narrow them to what the save endpoint accepts so
// a draft round-trips the same shape it was read as. Mirrors the helper the
// single-cell path uses — one narrowing rule for both modes.
function toAnswerValue(v: unknown): AnswerValue {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return String(v);
}

// Same answer shape the server accepts. `AnswerValue` is already that union.
function toAnswer(value: AnswerValue): SubmissionAnswer["value"] {
  return value as SubmissionAnswer["value"];
}

function sameValue(a: AnswerValue, b: AnswerValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const left = Array.isArray(a) ? a : [];
    const right = Array.isArray(b) ? b : [];
    return left.length === right.length && left.every((x, i) => x === right[i]);
  }
  // A cleared text field is `null`; an empty one is `""`. Both mean "no answer",
  // so treating them as equal keeps a cell the user did not really change from
  // counting as dirty.
  const norm = (v: AnswerValue) => (v === null || v === undefined || v === "" ? "" : String(v));
  return norm(a) === norm(b);
}

export function useColumnEdit({ rows, onSaved, confirmDiscard }: ColumnEditOptions): ColumnEditApi {
  const [activeFieldId, setActiveFieldId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Map<string, AnswerValue>>(new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Map<string, string>>(new Map());
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());

  // Refs shadow the state for the same reason `useCellEdit` keeps them: a save
  // must act on the values as they are at the moment it runs, not on the closure
  // it was created in, and the dirty set is read by `cancel` from a caller that
  // may hold an older render.
  const activeRef = useRef<number | null>(null);
  const draftsRef = useRef<Map<string, AnswerValue>>(new Map());
  const savingRef = useRef(false);
  const rowsRef = useRef(rows);
  const onSavedRef = useRef(onSaved);
  const confirmRef = useRef(confirmDiscard);
  const flashTimers = useRef<number[]>([]);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  useEffect(() => {
    onSavedRef.current = onSaved;
  });
  useEffect(() => {
    confirmRef.current = confirmDiscard;
  });

  useEffect(
    () => () => {
      for (const t of flashTimers.current) window.clearTimeout(t);
    },
    []
  );

  // The dirty set is derived rather than stored: a draft is dirty exactly when it
  // differs from what the row currently holds, so a value the user changed and
  // then changed back stops counting without any extra bookkeeping.
  const dirtyKeys = new Set<string>();
  if (activeFieldId !== null) {
    const key = `field_${activeFieldId}`;
    for (const [k, v] of drafts) {
      if (!k.endsWith(`|${activeFieldId}`)) continue;
      const publicId = k.slice(0, k.lastIndexOf("|"));
      const row = rows.find((r) => r.public_id === publicId);
      if (!row) continue;
      if (!sameValue(v, toAnswerValue(row.values?.[key]))) dirtyKeys.add(k);
    }
  }

  const reset = useCallback(() => {
    activeRef.current = null;
    draftsRef.current = new Map();
    setActiveFieldId(null);
    setDrafts(new Map());
    setError(null);
    setRowErrors(new Map());
  }, []);

  const begin = useCallback((fieldId: number) => {
    // Re-opening the same column keeps the drafts from the previous attempt —
    // that is what makes "cancel, look at the row, come back" non-destructive.
    if (activeRef.current === fieldId) {
      reset();
      return;
    }
    activeRef.current = fieldId;
    setActiveFieldId(fieldId);
    setError(null);
    setRowErrors(new Map());
  }, [reset]);

  const change = useCallback((publicId: string, value: AnswerValue) => {
    const fieldId = activeRef.current;
    if (fieldId === null) return;
    const next = new Map(draftsRef.current);
    next.set(cellKey(publicId, fieldId), value);
    draftsRef.current = next;
    setDrafts(next);
    // A new edit invalidates the previous batch's per-row refusals.
    setRowErrors(new Map());
    setError(null);
  }, []);

  const cancel = useCallback(() => {
    const fieldId = activeRef.current;
    if (fieldId === null) return;
    if (savingRef.current) return;
    let dirty = 0;
    for (const [k, v] of draftsRef.current) {
      if (!k.endsWith(`|${fieldId}`)) continue;
      const publicId = k.slice(0, k.lastIndexOf("|"));
      const row = rowsRef.current.find((r) => r.public_id === publicId);
      if (row && !sameValue(v, toAnswerValue(row.values?.[`field_${fieldId}`]))) dirty += 1;
    }
    if (dirty > 0 && confirmRef.current && !confirmRef.current(dirty)) return;
    reset();
  }, [reset]);

  const save = useCallback(async () => {
    const fieldId = activeRef.current;
    if (fieldId === null || savingRef.current) return;

    // Collect the dirty cells in row order, so a partial failure reads in the
    // same order the user sees them.
    const key = `field_${fieldId}`;
    const pending: { public_id: string; value: AnswerValue }[] = [];
    for (const row of rowsRef.current) {
      const draft = draftsRef.current.get(cellKey(row.public_id, fieldId));
      if (draft === undefined) continue;
      if (sameValue(draft, toAnswerValue(row.values?.[key]))) continue;
      pending.push({ public_id: row.public_id, value: draft });
    }
    if (pending.length === 0) {
      reset();
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setError(null);
    setRowErrors(new Map());

    const accepted: { public_id: string; value: AnswerValue }[] = [];
    const failed = new Map<string, string>();
    try {
      for (let i = 0; i < pending.length; i += BATCH_LIMIT) {
        const chunk = pending.slice(i, i + BATCH_LIMIT);
        const result = await api.updateSubmissionValuesBatch(
          chunk.map((c) => ({
            public_id: c.public_id,
            answers: [{ field_id: fieldId, value: toAnswer(c.value) }],
          }))
        );
        const refused = new Map(result.failed.map((f) => [f.public_id, f.error]));
        for (const c of chunk) {
          const why = refused.get(c.public_id);
          if (why) failed.set(c.public_id, why);
          else accepted.push(c);
        }
      }
    } catch (err) {
      // The request itself failed (network, 401, 500). Nothing in this chunk was
      // confirmed, so every remaining draft stays dirty and the mode stays open.
      setError(err instanceof ApiError ? err.message : "Could not save these values.");
      setSaving(false);
      savingRef.current = false;
      return;
    }

    for (const a of accepted) onSavedRef.current(a.public_id, fieldId, a.value);

    if (failed.size > 0) {
      // Keep the failed rows' drafts so the user can retry them; drop the ones
      // that landed, which the caller's row store now reflects.
      const nextDrafts = new Map(draftsRef.current);
      for (const a of accepted) nextDrafts.delete(cellKey(a.public_id, fieldId));
      draftsRef.current = nextDrafts;
      setDrafts(nextDrafts);
      setRowErrors(failed);
      setError(
        `${failed.size} ${failed.size === 1 ? "row" : "rows"} could not be saved. The rest were saved.`
      );
    } else {
      reset();
    }

    if (accepted.length > 0) {
      const keys = accepted.map((a) => cellKey(a.public_id, fieldId));
      setSavedKeys((prev) => {
        const next = new Set(prev);
        for (const k of keys) next.add(k);
        return next;
      });
      const t = window.setTimeout(() => {
        setSavedKeys((prev) => {
          const next = new Set(prev);
          for (const k of keys) next.delete(k);
          return next;
        });
      }, SAVED_FLASH_MS);
      flashTimers.current.push(t);
    }

    setSaving(false);
    savingRef.current = false;
  }, [reset]);

  return {
    activeFieldId,
    drafts,
    dirtyKeys,
    saving,
    error,
    rowErrors,
    savedKeys,
    begin,
    change,
    save: () => void save(),
    cancel,
  };
}
