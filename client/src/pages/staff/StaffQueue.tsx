import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Columns3, Download } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import type { Form, SubmissionRow } from "../../types";
import { PageHead } from "../../components/layout";
import ExportModal from "../../components/ExportModal";
import ColumnsDrawer from "../../components/ColumnsDrawer";
import SubmissionsGrid from "../../components/SubmissionsGrid";
import { useSubmissionGrid } from "../../lib/useSubmissionGrid";

// ---------------------------------------------------------------------------
// The staff and School Contact queue.
//
// This uses the same SubmissionsGrid as the admin dashboard, on purpose: staff
// are the people who fill in the staff-only fields, and that grid is where those
// fields are editable in place. The hand-rolled table this replaced could not do
// that at all, and would have drifted from the admin grid over time.
//
// The table/cards toggle went with it. The grid already stacks into cards on
// mobile (each cell carries a data-label), and a cards view cannot host inline
// editing — so it would have been a second-class view that hid the new feature.
//
// What stays staff-specific is the headline (a School Contact is tied to one
// school; staff cover the whole organization) and the status chips, which are a
// faster way into the common filters than the admin's dropdowns.
// ---------------------------------------------------------------------------
export default function StaffQueue() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [rows, setRows] = useState<SubmissionRow[]>([]);
  const [forms, setForms] = useState<Form[]>([]);
  const [exportOpen, setExportOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  // "" means "all reports". A school normally has exactly one form, in which
  // case we select it outright rather than offering a choice that isn't one.
  const [formFilter, setFormFilter] = useState("");

  const formId = formFilter ? Number(formFilter) : 0;

  // Column choice, the picker selection and inline editing — identical to the
  // admin dashboard because it is literally the same code. School Contacts and
  // staff each keep their own selection: the store is keyed on the user, so one
  // reviewer ticking boxes never changes anyone else's grid.
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
  } = useSubmissionGrid({ formId, status: statusFilter || undefined });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listSubmissions({
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(formFilter ? { form_id: Number(formFilter) } : {}),
      })
      .then((s) => {
        if (!cancelled) setRows(s);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [statusFilter, formFilter]);

  // Load forms so the queue can be scoped to one report and the Export drawer
  // can present a form selector (both scoped to this school).
  useEffect(() => {
    let cancelled = false;
    api
      .listForms()
      .then((f) => {
        if (cancelled) return;
        setForms(f);
        // One form is not a choice — land on it.
        if (f.length === 1) setFormFilter(String(f[0].id));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const counts = {
    submitted: rows.filter((r) => r.status === "submitted").length,
    in_review: rows.filter((r) => r.status === "in_review").length,
    flagged: rows.filter((r) => r.status === "flagged").length,
    completed: rows.filter((r) => r.status === "completed").length,
  };

  const openSubmission = (publicId: string) => navigate(`/staff/${publicId}`);

  // Only a School Contact is tied to one school; staff work across the entire
  // organization, so their headline is the organization, not a school.
  const schoolScoped = user?.role === "cdm_contact";

  // `extrasLoading` covers the frame where the report changed but its columns
  // have not arrived yet, so the grid does not flash the previous report's.
  const busy = loading || extrasLoading;

  return (
    <div>
      <PageHead
        title={schoolScoped ? user?.school_name || "My School's Submissions" : "All Submissions"}
        subtitle={
          schoolScoped
            ? "Submissions from your school, ready for you to review."
            : "Submissions from every school in your organization, ready for you to review."
        }
        actions={
          <>
            {/* Column choice is per form, so with "All reports" selected there is
                nothing to choose from. Say so beside the button — a disabled
                button on its own explains nothing, and its title only appears on
                hover. On a single-report school the form is auto-selected, so the
                button is enabled from the first render. */}
            {!formId && (
              <span className="head-hint">Select a single report to choose columns</span>
            )}
            <button
              className="secondary-button"
              disabled={!formId}
              title={
                formId
                  ? "Choose which form fields appear as columns"
                  : "Select a single report to choose columns"
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

      <div
        style={{
          display: "flex",
          gap: 10,
          marginBottom: 16,
          flexWrap: "wrap",
          alignItems: "flex-end",
        }}
      >
        {forms.length > 1 && (
          <div className="filter-group">
            <label htmlFor="sq-report">Report</label>
            <select
              id="sq-report"
              value={formFilter}
              onChange={(e) => setFormFilter(e.target.value)}
            >
              <option value="">All reports</option>
              {forms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.title}
                </option>
              ))}
            </select>
          </div>
        )}
        {[
          { value: "", label: "All" },
          { value: "submitted", label: "Submitted" },
          { value: "in_review", label: "In Review" },
          { value: "flagged", label: "Flagged" },
          { value: "completed", label: "Completed" },
        ].map((t) => (
          <button
            key={t.value}
            className="badge-button filter-chip"
            style={
              statusFilter === t.value
                ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }
                : {}
            }
            onClick={() => setStatusFilter(t.value)}
          >
            {t.label}
            {t.value === "submitted" && counts.submitted > 0 && ` (${counts.submitted})`}
          </button>
        ))}
      </div>

      {busy ? (
        <div className="loading-state">
          <div className="spinner" /> Loading submissions...
        </div>
      ) : (
        <SubmissionsGrid
          rows={rows}
          columns={visibleColumns}
          hiddenBase={hiddenBase}
          valuesByPublicId={valuesByPublicId}
          fieldMeta={fieldMeta}
          onOpen={openSubmission}
          submissionPath={(publicId) => `/staff/${publicId}`}
          edit={edit}
          emptyMessage={
            formFilter
              ? "No submissions for this report yet."
              : schoolScoped
                ? "No submissions for your school yet."
                : "No submissions yet."
          }
        />
      )}

      <ColumnsDrawer
        open={pickerOpen}
        columns={pickerColumns}
        checked={checked}
        onToggle={toggleColumn}
        onToggleAll={toggleAll}
        onClose={closePicker}
        scopeLabel="this report"
      />

      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        formId={formFilter || (forms[0] ? String(forms[0].id) : "")}
        forms={forms}
        isStaff
      />
    </div>
  );
}
