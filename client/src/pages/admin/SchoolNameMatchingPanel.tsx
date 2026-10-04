import { useCallback, useEffect, useState } from "react";
import { Ban, Link2, Trash2, X } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import type { School, SchoolAlias, UnmatchedSchoolName } from "../../types";

// ---------------------------------------------------------------------------
// Settings → School Name Matching (docs/plans/school-name-reconciliation.md)
//
// The district school list is the single source of truth. A parent's spelling is
// only an input; when it names no school it appears in this worklist and an
// admin pairs it with an app school. That pairing then drives live routing AND
// re-files the submissions already carrying the spelling, so the school's own
// staff can open them. Nothing here is guessed — the admin chooses, and the app
// remembers.
//
// Like SchoolsPanel, it renders no <PageHead> (the enclosing
// CollapsibleSection supplies title + subtitle) and is flush with the section
// body so the toolbar, tables and drawer read as one card.
// ---------------------------------------------------------------------------

function fmtDate(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

export default function SchoolNameMatchingPanel() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [unmatched, setUnmatched] = useState<UnmatchedSchoolName[]>([]);
  const [aliases, setAliases] = useState<SchoolAlias[]>([]);
  const [schools, setSchools] = useState<School[]>([]);

  // The "Match school" drawer. `target` is the worklist row being matched.
  const [target, setTarget] = useState<UnmatchedSchoolName | null>(null);
  const [schoolId, setSchoolId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [drawerError, setDrawerError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [u, a, s] = await Promise.all([
        api.listUnmatchedSchoolNames(),
        api.listSchoolAliases(),
        api.listSchools(),
      ]);
      setUnmatched(u);
      setAliases(a);
      setSchools(s);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load school name matching");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openMatch = (item: UnmatchedSchoolName) => {
    setTarget(item);
    setSchoolId("");
    setDrawerError("");
  };

  const closeDrawer = () => {
    if (saving) return;
    setTarget(null);
    setDrawerError("");
  };

  const saveMatch = async () => {
    if (!target) return;
    const id = Number(schoolId);
    if (!Number.isInteger(id) || id <= 0) {
      setDrawerError("Choose a school first.");
      return;
    }
    setSaving(true);
    setDrawerError("");
    try {
      const res = await api.createSchoolAlias({
        submitted_name: target.submitted_name,
        display_name: target.display_name,
        school_id: id,
      });
      const moved = res.relocated;
      setMessage(
        `Matched "${target.display_name}". ${moved} submission${moved === 1 ? "" : "s"} re-filed.`
      );
      setTarget(null);
      await load();
    } catch (err) {
      setDrawerError(err instanceof ApiError ? err.message : "Could not save the match");
    } finally {
      setSaving(false);
    }
  };

  // "Ignore" records that a spelling is not a school. It moves NO submission —
  // the copy says so, because it must not read as a fix.
  const ignoreName = async (item: UnmatchedSchoolName) => {
    setError("");
    setMessage("");
    try {
      await api.createSchoolAlias({
        submitted_name: item.submitted_name,
        display_name: item.display_name,
        school_id: null,
      });
      setMessage(`Ignored "${item.display_name}". No submissions were changed.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not ignore that name");
    }
  };

  const removeAlias = async (a: SchoolAlias) => {
    setError("");
    setMessage("");
    try {
      await api.deleteSchoolAlias(a.id);
      setMessage(
        `Removed the match for "${a.display_name}". Future submissions will no longer use it; rows already re-filed are unchanged.`
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove that match");
    }
  };

  const totalAffected = unmatched.reduce((n, u) => n + u.count, 0);

  return (
    <>
      {(error || message) && (
        <div style={{ padding: "14px 16px 0" }}>
          {error && (
            <div className="alert-error" role="alert">
              {error}
            </div>
          )}
          {message && (
            <div className="alert-success" role="status">
              {message}
            </div>
          )}
        </div>
      )}

      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--border)",
          fontSize: "0.75rem",
          color: "var(--text-muted)",
        }}
      >
        {loading
          ? "Loading…"
          : unmatched.length === 0
            ? "Every school a form has submitted matches a school in the list."
            : `${unmatched.length} submitted spelling${unmatched.length === 1 ? "" : "s"} don't match a school · ${totalAffected} submission${totalAffected === 1 ? "" : "s"} affected`}
      </div>

      <table className="grid">
        <thead>
          <tr>
            <th>Submitted name</th>
            <th>Submissions</th>
            <th>First seen</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={4} style={{ textAlign: "center", padding: 24 }}>
                Loading…
              </td>
            </tr>
          ) : unmatched.length === 0 ? (
            <tr>
              <td colSpan={4} style={{ textAlign: "center", padding: 24 }}>
                Nothing to match. When a form submits a school name this app does not have, it
                appears here.
              </td>
            </tr>
          ) : (
            unmatched.map((u) => (
              <tr key={u.submitted_name}>
                <td data-label="Submitted name" className="cell-strong">
                  {u.display_name}
                </td>
                <td data-label="Submissions">{u.count}</td>
                <td data-label="First seen">{fmtDate(u.first_seen)}</td>
                <td data-label="Actions">
                  <button
                    className="badge-button"
                    onClick={() => openMatch(u)}
                    title={`Match ${u.display_name} to a school`}
                  >
                    <Link2 size={12} />
                    <span>Match…</span>
                  </button>{" "}
                  <button
                    className="badge-button"
                    onClick={() => void ignoreName(u)}
                    title="This is not a school — stop listing it"
                  >
                    <Ban size={12} />
                    <span>Ignore</span>
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {/* Existing matches — the recorded decisions, removable (future routing
          only; a past re-file is not undone). */}
      <div style={{ borderTop: "1px solid var(--border)" }}>
        <div style={{ padding: "10px 14px 6px", fontSize: "0.75rem", color: "var(--text-muted)" }}>
          {aliases.length === 0
            ? "No matches recorded yet."
            : `${aliases.length} match${aliases.length === 1 ? "" : "es"} recorded`}
        </div>
        {aliases.length > 0 && (
          <table className="grid">
            <thead>
              <tr>
                <th>Submitted name</th>
                <th>Mapped to</th>
                <th>By</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {aliases.map((a) => (
                <tr key={a.id}>
                  <td data-label="Submitted name">{a.display_name}</td>
                  <td data-label="Mapped to" className="cell-strong">
                    {a.school_id === null ? "— ignored —" : a.school_name ?? "—"}
                  </td>
                  <td data-label="By">{a.created_by_name ?? "—"}</td>
                  <td data-label="Actions">
                    <button
                      className="badge-button"
                      onClick={() => void removeAlias(a)}
                      title="Remove this match"
                    >
                      <Trash2 size={12} />
                      <span>Remove</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {/* Match drawer — the admin picks the school; the app remembers it. */}
      {target && (
        <div className="drawer-overlay open" onClick={closeDrawer}>
          <div
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Match school"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-head">
              <h2>Match school</h2>
              <button
                className="icon-button close"
                onClick={closeDrawer}
                title="Close"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="drawer-body">
              {drawerError && (
                <div className="alert-error" role="alert" style={{ marginBottom: 12 }}>
                  {drawerError}
                </div>
              )}
              <div className="form-grid">
                <label className="cf" style={{ gridColumn: "1 / -1" }}>
                  <span>Submitted name</span>
                  <input className="edit-input" value={target.display_name} readOnly />
                  <span className="field-note">
                    The spelling the form sent. The app school you choose below takes precedence for
                    the record — the label and the stored school will agree.
                  </span>
                </label>
                <label className="cf" style={{ gridColumn: "1 / -1" }}>
                  <span>Which school does it mean?</span>
                  <select
                    className="edit-input"
                    value={schoolId}
                    onChange={(e) => setSchoolId(e.target.value)}
                    autoFocus
                  >
                    <option value="">Select a school…</option>
                    {schools.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.grade_level ? ` · ${s.grade_level}` : ""}
                        {s.calendar ? ` · ${s.calendar}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="field-note" style={{ marginTop: 14 }}>
                {target.count > 0
                  ? `This will re-file ${target.count} existing submission${target.count === 1 ? "" : "s"} to the school you choose, so its staff can see them.`
                  : "No existing submissions carry this spelling yet."}
              </p>
            </div>
            <div className="drawer-foot">
              <span className="muted-note">Matching a submitted name</span>
              <button className="secondary-button" onClick={closeDrawer} disabled={saving}>
                Cancel
              </button>
              <button
                className="primary-button"
                onClick={() => void saveMatch()}
                disabled={saving || !schoolId}
              >
                {saving ? "Saving…" : "Match school"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
