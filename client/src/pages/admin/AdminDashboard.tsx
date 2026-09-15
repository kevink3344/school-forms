import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { Columns3, Download } from "lucide-react";
import type { Form, School, SubmissionRow } from "../../types";
import { PageHead } from "../../components/layout";
import ExportModal from "../../components/ExportModal";
import ColumnsDrawer from "../../components/ColumnsDrawer";
import SubmissionsGrid from "../../components/SubmissionsGrid";
import { useSubmissionGrid } from "../../lib/useSubmissionGrid";
import { useAuth } from "../../context/AuthContext";

interface Filters {
  school_id: string;
  form_id: string;
  status: string;
  from: string;
  to: string;
}

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [forms, setForms] = useState<Form[]>([]);
  const [schools, setSchools] = useState<School[]>([]);
  const [submissions, setSubmissions] = useState<SubmissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);

  const [filters, setFilters] = useState<Filters>({
    school_id: "",
    form_id: "",
    status: "",
    from: "",
    to: "",
  });

  // ---------------------------------------------------------------------------
  // Extra-column state. Everything below only has meaning once a single form is
  // selected — with "All forms" the grid shows its four base columns and there is
  // no per-form data to render.
  // ---------------------------------------------------------------------------
  const formId = filters.form_id ? Number(filters.form_id) : 0;

  // Everything form-scoped — the available columns, the picker selection and
  // inline editing — comes from one shared hook, so the staff queue gets the
  // identical grid rather than a copy of it. `extrasLoading` covers the frame
  // where the form changed but its columns have not arrived yet.
  const {
    visibleColumns,
    pickerColumns,
    hiddenBase,
    valuesByPublicId,
    fieldMeta,
    extrasLoading,
    pickerOpen,
    openPicker,
    closePicker,
    checked,
    toggleColumn,
    toggleAll,
    edit,
  } = useSubmissionGrid({
    formId,
    status: filters.status || undefined,
    schoolId: filters.school_id ? Number(filters.school_id) : undefined,
  });

  // Load forms + schools once
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listForms(), api.listSchools()])
      .then(([f, s]) => {
        if (cancelled) return;
        setForms(f);
        setSchools(s);
      })
      .catch(() => {
        // ignore
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load submissions, respecting all filters. Uses the same list endpoint as the
  // staff queue so the grid is identical (student/form, id, status, submitted).
  useEffect(() => {
    let cancelled = false;
    api
      .listSubmissions({
        school_id: filters.school_id ? Number(filters.school_id) : undefined,
        form_id: filters.form_id ? Number(filters.form_id) : undefined,
        status: filters.status || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
      })
      .then((s) => {
        if (!cancelled) setSubmissions(s);
      })
      .catch(() => {
        if (!cancelled) setSubmissions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [filters.school_id, filters.form_id, filters.status, filters.from, filters.to]);

  const setFilter = (key: keyof Filters, value: string) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  // Clear resets every filter including the form. Leaving the form selected used
  // to mean "Clear" could not get you back to the full list.
  const clearFilters = () =>
    setFilters({ school_id: "", form_id: "", status: "", from: "", to: "" });

  // Load forms + schools once

  const busy = loading || extrasLoading;

  return (
    <div>
      <PageHead
        title="Submissions"
        subtitle={
          <>
            All form submissions across every school. Filter, then export the exact columns you need.
            {user?.organization_slug ? (
              <span className="badge badge-blue" style={{ marginLeft: 10, fontSize: 11, verticalAlign: "middle" }}>
                {user.organization_slug}
              </span>
            ) : null}
          </>
        }
        actions={
          <>
            <button className="secondary-button" onClick={() => navigate("/admin/forms")}>
              + New Form
            </button>
            {/* Column choice is per form — there is no sensible set for "All
                forms", where the union of every form's fields would be enormous
                and mostly empty. The reason is also spelled out beside the
                button: a disabled button explains nothing on its own, and its
                `title` only appears on hover. */}
            {!formId && (
              <span className="head-hint">Select a single form to choose columns</span>
            )}
            <button
              className="secondary-button"
              disabled={!formId}
              title={
                formId
                  ? "Choose which form fields appear as columns"
                  : "Select a single form to choose columns"
              }
              onClick={openPicker}
            >
              <Columns3 size={14} />
              Columns
            </button>
            <button className="primary-button" onClick={() => setExportOpen(true)}>
              <Download size={14} />
              Export
            </button>
          </>
        }
      />

      {/* Filter toolbar */}
      <div className="filter-bar">
        <div className="filter-group">
          <label>School</label>
          <select
            value={filters.school_id}
            onChange={(e) => setFilter("school_id", e.target.value)}
          >
            <option value="">All schools</option>
            {schools.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <label>Form</label>
          <select
            value={filters.form_id}
            onChange={(e) => setFilter("form_id", e.target.value)}
          >
            <option value="">All forms</option>
            {forms
              .filter((f) => f.status === "published")
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.title}
                </option>
              ))}
          </select>
        </div>
        <div className="filter-group">
          <label>Status</label>
          <select
            value={filters.status}
            onChange={(e) => setFilter("status", e.target.value)}
          >
            <option value="">All statuses</option>
            <option value="submitted">Submitted</option>
            <option value="in_review">In Review</option>
            <option value="flagged">Flagged</option>
            <option value="completed">Completed</option>
          </select>
        </div>
        <div className="filter-group">
          <label>Date from</label>
          <input type="date" value={filters.from} onChange={(e) => setFilter("from", e.target.value)} />
        </div>
        <div className="filter-group">
          <label>Date to</label>
          <input type="date" value={filters.to} onChange={(e) => setFilter("to", e.target.value)} />
        </div>
        <div className="filter-spacer" />
        <button className="clear" onClick={clearFilters}>
          Clear
        </button>
      </div>

      {busy ? (
        <div className="loading-state">
          <div className="spinner" /> Loading submissions...
        </div>
      ) : (
        <SubmissionsGrid
          rows={submissions}
          columns={visibleColumns}
          hiddenBase={hiddenBase}
          valuesByPublicId={valuesByPublicId}
          fieldMeta={fieldMeta}
          onOpen={(publicId) => navigate(`/admin/submissions/${publicId}`)}
          submissionPath={(publicId) => `/admin/submissions/${publicId}`}
          edit={edit}
        />
      )}

      {/* Column picker — right slide-out panel, same pattern as the Reports page */}
      <ColumnsDrawer
        open={pickerOpen}
        columns={pickerColumns}
        checked={checked}
        onToggle={toggleColumn}
        onToggleAll={toggleAll}
        onClose={closePicker}
      />

      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        formId={filters.form_id}
        forms={forms}
        schoolId={filters.school_id}
        status={filters.status}
      />
    </div>
  );
}

