import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Columns3, Download, Archive } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import type { Form, SubmissionRow } from "../../types";
import { PageHead } from "../../components/layout";
import { Toggle } from "../../components/Toggle";
import ExportModal from "../../components/ExportModal";
import ColumnsDrawer from "../../components/ColumnsDrawer";
import SubmissionsGrid from "../../components/SubmissionsGrid";
import { useSubmissionGrid } from "../../lib/useSubmissionGrid";
import { formLabel, selectableForms } from "../../lib/forms";
import { ARCHIVE_TOGGLE_LABEL, archivedMatches, submissionNoun } from "../../lib/archive";

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
  // "" means "all forms". A school normally has exactly one form, in which
  // case we select it outright rather than offering a choice that isn't one.
  const [formFilter, setFormFilter] = useState("");
  // Archived submissions are put away, not deleted — so the queue has to be able
  // to show them, and has to SAY how many it is hiding. Staff are the people who
  // notice a submission they were working on has gone; this is the two controls
  // that let them find out where it went.
  const [showArchived, setShowArchived] = useState(false);
  // Both sides of the flag, so the strip can say what is hidden whichever view
  // you are in. Null until they arrive: rendering "0 archived" before the request
  // lands is a false all-clear on the one number whose job is to reveal an
  // omission.
  const [archiveCounts, setArchiveCounts] = useState<{ active: number; archived: number } | null>(null);

  // ★ A FAILED LOAD IS NOT AN EMPTY LOAD, and this page used to conflate them.
  // The list request's `.catch` set `rows` to `[]`, so a 500, a 403, an expired
  // session or a dead connection rendered the grid's empty message — which is a
  // claim about the DATA ("your school has no submissions"). The catch has no
  // evidence for that claim: it never read anything. A School Contact chasing a
  // missing submission would then be told, in the app's own words, that there is
  // nothing there. So the failure gets its own state and its own branch below,
  // and the empty message is reachable only from a request that actually
  // succeeded and really returned nothing.
  const [loadError, setLoadError] = useState<{ status: number | null; message: string } | null>(null);
  // Bumped by "Try again". The error box REPLACES the grid, so there is nothing
  // on screen to retry in place — the only way back is a fresh request.
  const [reloadKey, setReloadKey] = useState(0);

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
    // Clear the previous failure on every run, so a retry that succeeds cannot
    // leave a stale error box behind it.
    setLoadError(null);
    api
      .listSubmissions({
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(formFilter ? { form_id: Number(formFilter) } : {}),
        archived: showArchived,
      })
      .then((s) => {
        if (!cancelled) setRows(s);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Clear the rows as well: if a filter change failed, showing the
        // previous filter's rows under the new filter would be a second false
        // claim. The error branch hides the grid either way.
        setRows([]);
        setLoadError(
          err instanceof ApiError
            ? { status: err.status, message: err.message }
            : { status: null, message: "The request did not reach the server." }
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [statusFilter, formFilter, showArchived, reloadKey]);

  // What the list above cannot tell us — a filtered list is the wrong instrument
  // for reporting its own omissions, because with the archived rows hidden they
  // are absent by construction.
  //
  // `showArchived` is deliberately neither a dependency nor a parameter: the
  // pair is the answer to "how many on each side", so this is the one request
  // that must see both lists at once. Narrowing it by the flag it is measuring
  // would return whichever half is already on screen and neither number useful.
  useEffect(() => {
    let cancelled = false;
    api
      .getSubmissionArchiveCounts({
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(formFilter ? { form_id: Number(formFilter) } : {}),
      })
      .then((c) => {
        if (!cancelled) setArchiveCounts(c);
      })
      .catch(() => {
        // Null, not zero — an unreachable count must not render as "nothing is
        // hidden", which is a claim about the data this page cannot make.
        if (!cancelled) setArchiveCounts(null);
      });
    return () => {
      cancelled = true;
    };
  }, [statusFilter, formFilter, reloadKey]);

  // Load forms so the queue can be scoped to one form and the Export drawer
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

  // Only published forms are offered in the Forms dropdown — drafts are still
  // being written and archived forms have been retired, so neither is a sensible
  // "form" to scope the queue to. Submissions belonging to an unpublished form
  // are still reachable: they stay in the queue under "All forms". The
  // auto-select above deliberately keys off the *unfiltered* list so that one
  // live form beside an archived one does not silently scope the queue and hide
  // the archived form's submissions.
  const selectable = selectableForms(forms);

  const counts = {
    submitted: rows.filter((r) => r.status === "submitted").length,
    in_review: rows.filter((r) => r.status === "in_review").length,
    flagged: rows.filter((r) => r.status === "flagged").length,
    completed: rows.filter((r) => r.status === "completed").length,
  };

  const openSubmission = (publicId: string) => navigate(`/staff/${publicId}`);

  // Both loads re-run, because the error box replaces the grid and the archive
  // strip together — one retry should restore the whole page, not half of it.
  const retryLoad = () => setReloadKey((k) => k + 1);

  // Only a School Contact is tied to one school; staff work across the entire
  // organization, so their headline is the organization, not a school.
  const schoolScoped = user?.role === "cdm_contact";

  // `extrasLoading` covers the frame where the form changed but its columns
  // have not arrived yet, so the grid does not flash the previous form's.
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
            {/* Column choice is per form, so with "All forms" selected there is
                nothing to choose from. Say so beside the button — a disabled
                button on its own explains nothing, and its title only appears on
                hover. On a single-form school the form is auto-selected, so the
                button is enabled from the first render. */}
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
            <label htmlFor="sq-form">Forms</label>
            <select
              id="sq-form"
              value={formFilter}
              onChange={(e) => setFormFilter(e.target.value)}
            >
              <option value="">All forms</option>
              {selectable.map((f) => (
                <option key={f.id} value={f.id}>
                  {formLabel(f)}
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
        {/* Pushed to the right: the chips are "narrow the queue", this switch is
            "look at the other list". Its label is its children, so the visible
            words are the checkbox's accessible name. */}
        <div style={{ marginLeft: "auto" }}>
          <Toggle checked={showArchived} onChange={setShowArchived}>
            {ARCHIVE_TOGGLE_LABEL}
          </Toggle>
        </div>
      </div>

      {/* What this filter is hiding.
          Rendered unconditionally in the archive view, because there the EMPTY
          queue is the case that needs explaining: "nothing archived here, 12
          still active" is a complete answer, whereas a bare table says nothing.
          With the toggle off it appears only when something IS hidden — a strip
          reading "0 archived" on every ordinary visit would be noise, and here
          0 genuinely means nothing is being withheld. */}
      {archiveCounts &&
        (showArchived ? (
          <div className="archive-note">
            <Archive size={14} />
            <span className="an-text">
              Showing <strong>archived</strong> submissions only — {archivedMatches(archiveCounts.archived)}{" "}
              these filters.
              {archiveCounts.active > 0
                ? ` ${archiveCounts.active} active ${submissionNoun(archiveCounts.active)} are hidden; switch off “${ARCHIVE_TOGGLE_LABEL}” to go back to them.`
                : " No active submissions match these filters."}
            </span>
          </div>
        ) : archiveCounts.archived > 0 ? (
          <div className="archive-note">
            <Archive size={14} />
            <span className="an-text">
              <strong>{archiveCounts.archived}</strong> archived{" "}
              {submissionNoun(archiveCounts.archived)} hidden by these filters — switch on
              “{ARCHIVE_TOGGLE_LABEL}” to list them.
            </span>
          </div>
        ) : null)}

      {busy ? (
        <div className="loading-state">
          <div className="spinner" /> Loading submissions...
        </div>
      ) : loadError ? (
        /* ★ Deliberately NOT the grid's `emptyMessage`. That string is a claim
           about the data, and this branch has no data — the request failed. It
           names what went wrong and offers the one thing that can fix it. */
        <div className="alert-error" role="alert">
          <div>
            <strong>Could not load submissions.</strong>{" "}
            {loadError.status !== null && `(HTTP ${loadError.status}) `}
            {loadError.message}
          </div>
          <div style={{ marginTop: 6 }}>
            This is a failed request, not an empty queue — nothing was read, so an
            empty list here says nothing about your school's submissions.
          </div>
          <button className="secondary-button" style={{ marginTop: 10 }} onClick={retryLoad}>
            Try again
          </button>
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
            showArchived
              ? "No archived submissions match these filters."
              : formFilter
                ? "No submissions for this form yet."
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
      />

      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        formId={formFilter || (selectable[0] ? String(selectable[0].id) : "")}
        forms={forms}
        isStaff
      />
    </div>
  );
}
