import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Download, Save, Star, Trash2, X } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { PageHead } from "../../components/layout";
import ColumnsPicker, { cellText } from "../../components/ColumnsPicker";
import { useAuth } from "../../context/AuthContext";
import { selectableForms } from "../../lib/forms";
import type {
  ExportColumn,
  Form,
  ReportFormat,
  ReportPreview,
  ReportQuery,
  ReportView,
  School,
  SubmissionStatus,
} from "../../types";

// The filter half of a report request. This is the single piece of state the
// preview grid and the export both read from, which is what keeps "what you see
// is what you export" true by construction.
interface ReportState {
  formId: number | null;
  schoolId: number | null;
  status: SubmissionStatus | "";
  from: string;
  to: string;
}

const EMPTY_STATE: ReportState = {
  formId: null,
  schoolId: null,
  status: "",
  from: "",
  to: "",
};

const STATUSES: { value: SubmissionStatus | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "submitted", label: "Submitted" },
  { value: "in_review", label: "In Review" },
  { value: "flagged", label: "Flagged" },
  { value: "completed", label: "Completed" },
];

const FORMATS: { value: ReportFormat; label: string }[] = [
  { value: "csv", label: "CSV" },
  { value: "xlsx", label: "Excel" },
  { value: "pdf", label: "PDF" },
];

// Heading for rows whose grouped column is blank.
const NO_VALUE_GROUP = "(No value)";

// Natural ordering, so "Grade 9" sorts before "Grade 10" instead of after it.
const groupCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// The raw text of a grouped cell value. Deliberately not cellText(): that renders
// an empty value as "-", which would merge a genuinely blank cell into the same
// group as a cell holding a literal dash.
function groupLabel(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ").trim();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).trim();
}

interface RowGroup {
  label: string;
  rows: Record<string, unknown>[];
}

// One builder, used by the preview request and the export request. The free-text
// filter is passed in rather than read from `state` because the caller debounces
// it separately. Nullish and empty values are dropped by reportQueryString, so
// "unset" and "omitted" are the same thing here.
// Staff-only fields are no longer opt-in — they are always part of a report, and
// the column picker (which starts fully ticked) is how you narrow the selection.
function buildReportQuery(
  state: ReportState,
  q: string,
  columns: string[] | null
): ReportQuery {
  return {
    form_id: state.formId as number,
    school_id: state.schoolId,
    status: state.status || null,
    from: state.from || null,
    to: state.to || null,
    q: q || null,
    // Always on. The server still needs the flag to authorize the staff-only
    // columns; it is simply no longer something the user chooses.
    include_staff_only: true,
    columns,
  };
}

export default function ReportsPage() {
  const { user } = useAuth();
  // Only a School Contact is tied to one school. Admin and staff report across
  // the whole organization and so get the school filter.
  const schoolScoped = user?.role === "cdm_contact";

  const [forms, setForms] = useState<Form[]>([]);
  const [schools, setSchools] = useState<School[]>([]);

  const [state, setState] = useState<ReportState>(EMPTY_STATE);
  // Free-text is held in its own input and debounced into state so typing
  // doesn't refetch on every keystroke.
  const [qInput, setQInput] = useState("");
  const [qDebounced, setQDebounced] = useState("");

  const [preview, setPreview] = useState<ReportPreview | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<ReportFormat>("csv");

  // Preview-only grouping. `groupBy` is a column key from the preview response;
  // `collapsedGroups` holds group labels, which only mean anything for the
  // grouping that produced them.
  const [groupBy, setGroupBy] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const [showPicker, setShowPicker] = useState(false);
  const [views, setViews] = useState<ReportView[]>([]);
  const [activeViewId, setActiveViewId] = useState<number | null>(null);
  const [showSave, setShowSave] = useState(false);
  const [viewName, setViewName] = useState("");

  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const patch = (p: Partial<ReportState>) => setState((s) => ({ ...s, ...p }));

  // Escape closes the column panel, matching the export drawer's behaviour.
  useEffect(() => {
    if (!showPicker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowPicker(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showPicker]);

  // --- Reference data -------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    api
      .listForms()
      .then((f) => {
        if (cancelled) return;
        // Only published forms can be reported on — a draft has no settled
        // fields yet and an archived form has been retired. Filtering here keeps
        // the picker and the default selection honest: with nothing published
        // there is nothing to land on, so the page falls through to its "no
        // published forms" prompt.
        //
        // Note the one path that can still point at a non-published form: a
        // saved View is applied by `form_id` on mount (see `applyView`) and is
        // an explicit user configuration, so it is deliberately not re-checked
        // against this list. The picker below is the surface that must never
        // offer a draft or archived form, and it cannot.
        const reportable = selectableForms(f);
        setForms(reportable);
        // Land on the first published form so the grid has something to show.
        // Reads from `reportable`, never from the raw response — the raw list's
        // first entry may be a draft or an archived form.
        setState((s) =>
          s.formId == null && reportable.length ? { ...s, formId: reportable[0].id } : s,
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (schoolScoped) return;
    let cancelled = false;
    api
      .listSchools()
      .then((s) => {
        if (!cancelled) setSchools(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [schoolScoped]);

  const loadViews = () => {
    api
      .listReportViews()
      .then(setViews)
      .catch(() => setViews([]));
  };

  // --- Debounce the row filter ---------------------------------------------

  useEffect(() => {
    const t = window.setTimeout(() => setQDebounced(qInput.trim()), 300);
    return () => window.clearTimeout(t);
  }, [qInput]);

  // --- Preview --------------------------------------------------------------
  // Deliberately never sends `columns`: the response then carries every column
  // the user may see AND every visible field value on each row, so toggling the
  // selection is instant and needs no refetch. The selection is applied to the
  // export request only.
  useEffect(() => {
    if (state.formId == null) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    api
      .reportPreview(buildReportQuery(state, qDebounced, null))
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Could not load report");
        setPreview(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [state, qDebounced]);

  const availableColumns: ExportColumn[] = preview?.columns ?? [];

  // Default the selection to every visible column, and preserve an existing
  // selection across refetches when its keys still exist.
  useEffect(() => {
    if (!preview) return;
    const avail = preview.columns.map((c) => c.key);
    setChecked((prev) => {
      if (prev.size === 0) return new Set(avail);
      const kept = avail.filter((k) => prev.has(k));
      return new Set(kept.length ? kept : avail);
    });
  }, [preview]);

  // An empty selection means "all role-visible columns" (same safety rule as the
  // per-form grid preference), so the grid and the file never come up blank.
  const selectedKeys = useMemo(
    () => availableColumns.map((c) => c.key).filter((k) => checked.has(k)),
    [availableColumns, checked]
  );
  const gridColumns = useMemo(
    () => (selectedKeys.length ? availableColumns.filter((c) => checked.has(c.key)) : availableColumns),
    [availableColumns, checked, selectedKeys]
  );
  const emptySelection = selectedKeys.length === 0 && availableColumns.length > 0;

  const toggleColumn = (key: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleAll = () =>
    setChecked((prev) => (prev.size === availableColumns.length ? new Set() : new Set(availableColumns.map((c) => c.key))));

  // --- Grouping (preview only) ---------------------------------------------
  // Rows arrive ordered by submitted_at DESC, so grouping is a stable partition:
  // the server's ordering survives inside each group. Grouping never touches an
  // export — it is a way to read the grid, not a change to the data.
  const groups = useMemo<RowGroup[] | null>(() => {
    if (!groupBy || !preview) return null;
    const map = new Map<string, RowGroup>();
    for (const r of preview.rows) {
      const label = groupLabel(r[groupBy]) || NO_VALUE_GROUP;
      const existing = map.get(label);
      if (existing) existing.rows.push(r);
      else map.set(label, { label, rows: [r] });
    }
    return [...map.values()].sort((a, b) => {
      // Rows with nothing in the grouped column always sort last.
      if (a.label === NO_VALUE_GROUP) return b.label === NO_VALUE_GROUP ? 0 : 1;
      if (b.label === NO_VALUE_GROUP) return -1;
      return groupCollator.compare(a.label, b.label);
    });
  }, [groupBy, preview]);

  const toggleGroup = (label: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  // Collapse state is keyed by group label, which only means something for the
  // grouping that produced it — carrying it over would silently hide groups in a
  // different column, and a stale key would survive a form switch entirely.
  useEffect(() => {
    setCollapsedGroups(new Set());
  }, [groupBy, state.formId]);

  const canRun = state.formId != null && !loading;

  // --- Export ---------------------------------------------------------------

  const handleExport = async () => {
    if (state.formId == null) return;
    setExporting(true);
    setError("");
    try {
      await api.reportExport(
        buildReportQuery(state, qDebounced, selectedKeys.length ? selectedKeys : null),
        format
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  // --- Saved views ----------------------------------------------------------

  const currentFilters = () => ({
    school_id: state.schoolId,
    status: state.status || null,
    from: state.from || null,
    to: state.to || null,
    q: qDebounced || null,
    include_staff_only: true,
  });

  const applyView = (view: ReportView) => {
    setActiveViewId(view.id);
    const q = view.filters.q ?? "";
    setQInput(q);
    setQDebounced(q.trim());
    setState({
      formId: view.form_id,
      schoolId: view.filters.school_id ?? null,
      status: (view.filters.status ?? "") as SubmissionStatus | "",
      from: view.filters.from ?? "",
      to: view.filters.to ?? "",
    });
    setFormat(view.format);
    setChecked(new Set(view.columns ?? []));
    // A saved view carries no grouping, and the form may change underneath it.
    setGroupBy(null);
    // Fire-and-forget: powers a "most recently used" ordering later.
    api.useReportView(view.id).catch(() => {});
  };

  // Land on the user's default View the first time the page opens — falling
  // back to their only View, since with a single saved report there is no
  // choice to make. Without this, "Save View" + "Make Default" had no effect
  // on the next visit. Runs once; the ref guard also absorbs StrictMode's
  // double-invoke in dev.
  const viewAutoApplied = useRef(false);
  useEffect(() => {
    if (viewAutoApplied.current) return;
    viewAutoApplied.current = true;
    api
      .listReportViews()
      .then((vs) => {
        setViews(vs);
        const landing = vs.find((v) => v.is_default) ?? (vs.length === 1 ? vs[0] : null);
        if (landing) applyView(landing);
      })
      .catch(() => setViews([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreateView = async () => {
    const name = viewName.trim();
    if (!name || state.formId == null) return;
    setBusy(true);
    setError("");
    try {
      const view = await api.createReportView({
        name,
        form_id: state.formId,
        filters: currentFilters(),
        columns: selectedKeys.length ? selectedKeys : null,
        format,
      });
      setViews((v) => [...v, view]);
      setActiveViewId(view.id);
      setViewName("");
      setShowSave(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save view");
    } finally {
      setBusy(false);
    }
  };

  const handleOverwriteView = async () => {
    if (activeViewId == null || state.formId == null) return;
    setBusy(true);
    setError("");
    try {
      const view = await api.updateReportView(activeViewId, {
        form_id: state.formId,
        filters: currentFilters(),
        columns: selectedKeys.length ? selectedKeys : null,
        format,
      });
      setViews((v) => v.map((x) => (x.id === view.id ? view : x)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update view");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteView = async () => {
    if (activeViewId == null) return;
    setBusy(true);
    setError("");
    try {
      await api.deleteReportView(activeViewId);
      setViews((v) => v.filter((x) => x.id !== activeViewId));
      setActiveViewId(null);
      setShowSave(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete view");
    } finally {
      setBusy(false);
    }
  };

  const handleSetDefault = async () => {
    if (activeViewId == null) return;
    setBusy(true);
    try {
      await api.setDefaultReportView(activeViewId);
      loadViews();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not set default view");
    } finally {
      setBusy(false);
    }
  };

  const activeView = views.find((v) => v.id === activeViewId) ?? null;
  const selectedForm = forms.find((f) => f.id === state.formId) ?? null;

  // A plain function rather than a component: it is called directly, so React
  // keeps the same row elements across a regroup instead of remounting them.
  const renderRow = (r: Record<string, unknown>, i: number) => (
    <tr key={String(r.submission_public_id ?? i)}>
      <td className="cell-mono">{cellText(r.submitted_at)}</td>
      {gridColumns.map((c) => (
        <td key={c.key}>{cellText(r[c.key])}</td>
      ))}
    </tr>
  );

  return (
    <div>
      <PageHead
        title="Reports"
        subtitle="Filter a form's submissions, choose your columns, then export exactly what you see."
        actions={
          <>
            <button className="secondary-button" onClick={() => setShowSave((s) => !s)} disabled={!canRun}>
              <Save size={14} />
              Save View
            </button>
            <button className="primary-button" onClick={handleExport} disabled={!canRun || exporting}>
              <Download size={14} />
              {exporting ? "Exporting…" : "Export"}
            </button>
          </>
        }
      />

      {error && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-body" style={{ color: "var(--vacant-fg)" }}>
            {error}
          </div>
        </div>
      )}

      {/* Toolbar: form, saved views, columns, format */}
      <div className="filter-bar">
        <div className="filter-group">
          <label htmlFor="rp-form">Form</label>
          <select
            id="rp-form"
            value={state.formId ?? ""}
            onChange={(e) => {
              const id = e.target.value ? Number(e.target.value) : null;
              patch({ formId: id });
              setActiveViewId(null);
              // Column keys belong to the form, so a grouping chosen for the old
              // form would silently collapse every row into "(No value)".
              setGroupBy(null);
            }}
          >
            <option value="">Select a form…</option>
            {forms.map((f) => (
              <option key={f.id} value={f.id}>
                {f.title}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label htmlFor="rp-view">Saved View</label>
          <select
            id="rp-view"
            value={activeViewId ?? ""}
            onChange={(e) => {
              const id = e.target.value ? Number(e.target.value) : null;
              if (id == null) {
                setActiveViewId(null);
                return;
              }
              const view = views.find((v) => v.id === id);
              if (view) applyView(view);
            }}
          >
            <option value="">— None —</option>
            {views.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.is_default ? " ★" : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-group" style={{ minWidth: 0 }}>
          <label>Columns</label>
          <button
            className="secondary-button"
            onClick={() => setShowPicker(true)}
            disabled={!availableColumns.length}
          >
            {`Select Columns (${selectedKeys.length})`}
          </button>
        </div>

        {/* Every role-visible column is offered, not just the ones ticked in the
            picker: the preview returns a value for each visible column on every
            row regardless of the selection, so grouping by a hidden column still
            works and the section totals stay meaningful. */}
        <div className="filter-group" style={{ minWidth: 0 }}>
          <label htmlFor="rp-group">Group by</label>
          <select
            id="rp-group"
            value={groupBy ?? ""}
            onChange={(e) => setGroupBy(e.target.value || null)}
            disabled={!availableColumns.length}
          >
            <option value="">None</option>
            {availableColumns.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-spacer" />

        <div className="filter-group" style={{ minWidth: 0 }}>
          <label>Format</label>
          <div style={{ display: "flex", gap: 6 }}>
            {FORMATS.map((f) => (
              <button
                key={f.value}
                className="badge-button filter-chip"
                style={format === f.value ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" } : {}}
                onClick={() => setFormat(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="filter-bar">
        {!schoolScoped && (
          <div className="filter-group">
            <label htmlFor="rp-school">School</label>
            <select
              id="rp-school"
              value={state.schoolId ?? ""}
              onChange={(e) => patch({ schoolId: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">All schools</option>
              {schools.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {schoolScoped && (
          <div className="filter-group">
            <label>School</label>
            <div className="static-value">{user?.school_name || "My school"}</div>
          </div>
        )}

        <div className="filter-group">
          <label htmlFor="rp-status">Status</label>
          <select
            id="rp-status"
            value={state.status}
            onChange={(e) => patch({ status: e.target.value as SubmissionStatus | "" })}
          >
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label htmlFor="rp-from">From</label>
          <input id="rp-from" type="date" value={state.from} onChange={(e) => patch({ from: e.target.value })} />
        </div>

        <div className="filter-group">
          <label htmlFor="rp-to">To</label>
          <input id="rp-to" type="date" value={state.to} onChange={(e) => patch({ to: e.target.value })} />
        </div>

        <div className="filter-group" style={{ flex: 1, minWidth: 200 }}>
          <label htmlFor="rp-q">Filter rows</label>
          <input
            id="rp-q"
            type="search"
            placeholder="Search any field…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            maxLength={200}
          />
        </div>

        {/* Staff-only fields are no longer opt-in, so there is no toggle here —
            every report includes them and the column picker narrows from there. */}

        <button
          className="clear"
          onClick={() => {
            setQInput("");
            setState((s) => ({ ...EMPTY_STATE, formId: s.formId }));
            setActiveViewId(null);
          }}
        >
          Clear
        </button>
      </div>

      {/* Save / manage the active view */}
      {showSave && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-body" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
            <div className="filter-group" style={{ flex: 1, minWidth: 220 }}>
              <label htmlFor="rp-view-name">{activeView ? `Update "${activeView.name}"` : "New view name"}</label>
              <input
                id="rp-view-name"
                value={viewName}
                placeholder={activeView ? activeView.name : "e.g. CDM – missing contact info"}
                onChange={(e) => setViewName(e.target.value)}
                maxLength={120}
              />
            </div>
            {activeView ? (
              <>
                <button className="secondary-button" onClick={handleOverwriteView} disabled={busy}>
                  Update View
                </button>
                <button className="secondary-button" onClick={handleSetDefault} disabled={busy || activeView.is_default}>
                  <Star size={14} />
                  {activeView.is_default ? "Default" : "Make Default"}
                </button>
                <button className="secondary-button" onClick={handleDeleteView} disabled={busy}>
                  <Trash2 size={14} />
                  Delete
                </button>
              </>
            ) : (
              <button className="primary-button" onClick={handleCreateView} disabled={busy || !viewName.trim()}>
                <Save size={14} />
                Save as New
              </button>
            )}
          </div>
        </div>
      )}

      {/* Column picker — right slide-out panel */}
      {showPicker && availableColumns.length > 0 && (
        <div className="drawer-overlay open" onClick={() => setShowPicker(false)}>
          <div
            className="drawer drawer-report-columns"
            role="dialog"
            aria-modal="true"
            aria-label="Select columns"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-head">
              <h2>Select Columns</h2>
              <button className="icon-button close" onClick={() => setShowPicker(false)} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <div className="drawer-body">
              <p className="file-note" style={{ marginTop: 0 }}>
                Tick the columns to show in the preview and include in the export.
              </p>
              <ColumnsPicker
                columns={availableColumns}
                checked={checked}
                onToggle={toggleColumn}
                onToggleAll={toggleAll}
              />
              {emptySelection && (
                <p className="file-note">
                  No columns selected — the report will fall back to every column you have access to.
                </p>
              )}
            </div>

            <div className="drawer-foot">
              <span className="file-note" style={{ marginTop: 0 }}>
                {selectedKeys.length} of {availableColumns.length} columns
              </span>
              <div className="spacer" />
              <button className="primary-button" onClick={() => setShowPicker(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview grid */}
      {state.formId == null ? (
        <div className="empty-state">
          {forms.length === 0
            ? "No published forms yet. Publish a form on the Forms page to build a report from it."
            : "Select a form to build a report."}
        </div>
      ) : loading && !preview ? (
        <div className="loading-state">
          <div className="spinner" /> Loading report…
        </div>
      ) : !preview ? (
        <div className="empty-state">No report data.</div>
      ) : preview.rows.length === 0 ? (
        <div className="empty-state">No submissions match these filters.</div>
      ) : (
        <div className="grid-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Submitted</th>
                {gridColumns.map((c) => (
                  <th key={c.key}>
                    {c.label}
                    {c.staff_only && <span className="badge badge-slate" style={{ marginLeft: 8 }}>Staff</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups
                ? groups.map((g) => (
                    <Fragment key={g.label}>
                      <tr className="grid-group-row">
                        <td colSpan={1 + gridColumns.length}>
                          <button
                            type="button"
                            className="grid-group-toggle"
                            aria-expanded={!collapsedGroups.has(g.label)}
                            onClick={() => toggleGroup(g.label)}
                          >
                            {collapsedGroups.has(g.label) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                            <span>{g.label}</span>
                            <span className="grid-group-count">
                              {g.rows.length} {g.rows.length === 1 ? "row" : "rows"}
                            </span>
                          </button>
                        </td>
                      </tr>
                      {!collapsedGroups.has(g.label) && g.rows.map((r, i) => renderRow(r, i))}
                    </Fragment>
                  ))
                : preview.rows.map((r, i) => renderRow(r, i))}
            </tbody>
          </table>
          <div className="grid-footer">
            <span>
              {preview.rows.length} of {preview.total} rows · {gridColumns.length} columns
              {groups ? ` · ${groups.length} ${groups.length === 1 ? "group" : "groups"}` : ""}
            </span>
            <div className="filter-spacer" />
            <span>{selectedForm ? selectedForm.title : preview.form_title}</span>
            {loading && <span className="spinner spinner-sm" />}
          </div>
        </div>
      )}
    </div>
  );
}
