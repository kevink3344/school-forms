import { useEffect, useState, type CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { Columns3, Download, Webhook, Archive, X } from "lucide-react";
import type { Form, School, SubmissionRow, WebhookEventSummary } from "../../types";
import { PageHead } from "../../components/layout";
import { Toggle } from "../../components/Toggle";
import ExportModal from "../../components/ExportModal";
import ColumnsDrawer from "../../components/ColumnsDrawer";
import SubmissionsGrid from "../../components/SubmissionsGrid";
import { useSubmissionGrid } from "../../lib/useSubmissionGrid";
import { formLabel, selectableForms } from "../../lib/forms";
import { useAuth } from "../../context/AuthContext";
import { ARCHIVE_TOGGLE_LABEL, archivedMatches, submissionNoun } from "../../lib/archive";

interface Filters {
  school_id: string;
  form_id: string;
  status: string;
  from: string;
  to: string;
  // The one non-string member, and deliberately not a `status` value: an
  // archived row KEEPS its workflow status, so this selects WHICH of the two
  // lists you are looking at rather than which rows match. There is no merged
  // view — see the strip below the toolbar for the number that makes two lists
  // safe to live with.
  archived: boolean;
}

// The five filters a text value can go into. Named so `setFilter` cannot be
// handed the boolean archive flag it would type as a string — see the toggle
// below, which has its own setter.
type TextFilterKey = "school_id" | "form_id" | "status" | "from" | "to";

// Inline styles for the delete confirmation, matching the form-delete dialog on
// the Forms page so the two destructive prompts read as the same kind of thing.
const BODY_TEXT: CSSProperties = { margin: 0, fontSize: 14, lineHeight: 1.5 };
const BODY_HINT: CSSProperties = { margin: "10px 0 0", fontSize: 13, color: "var(--text-muted)" };
const DANGER = "var(--danger, #b93040)";

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [forms, setForms] = useState<Form[]>([]);
  const [schools, setSchools] = useState<School[]>([]);
  const [submissions, setSubmissions] = useState<SubmissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  // Q9: the org-wide webhook intake counts for the last 7 days. Null until they
  // arrive — a strip reporting "0 failed" before the request lands would be a
  // false all-clear on the one number that matters most.
  const [webhook, setWebhook] = useState<WebhookEventSummary | null>(null);
  // How many rows this filter is hiding, and how many it would show if the
  // archive toggle went the other way. Null until they arrive: a strip reading
  // "0 archived" before the request lands is a false all-clear on the number
  // whose whole job is to tell you something is missing.
  const [archiveCounts, setArchiveCounts] = useState<{ active: number; archived: number } | null>(null);

  // The row a delete is waiting to be confirmed for. Holds the NAME alongside the
  // id, captured at click time: after a successful delete the row is gone from
  // `submissions`, so a dialog that looked its subject up by id would blink to
  // blank in the frame between the call returning and the modal being dismissed.
  const [pendingDelete, setPendingDelete] = useState<{ publicId: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Its own slot, never the page's generic error: a 409 here means the row was
  // restored in another tab while this one still showed it as archived, and that
  // message belongs inside the dialog that asked the question.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Bumped after a write that the two effects below cannot see. A delete changes
  // the rows AND the hidden counts at once (the row leaves the archived list and
  // stops being counted), and neither effect can observe that from `filters`
  // alone — so the invalidation is explicit rather than inferred.
  const [reloadKey, setReloadKey] = useState(0);

  const [filters, setFilters] = useState<Filters>({
    school_id: "",
    form_id: "",
    status: "",
    from: "",
    to: "",
    archived: false,
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
        // One form is not a choice, so default to it rather than making the user
        // pick from a one-item list. It also means the grid opens on that form's
        // own columns — and the Columns button is enabled — without a click.
        //
        // Keyed off the selectable list, never the raw response: the picker below
        // offers published forms only, so a draft or an archived form sitting
        // beside a single published one is not a second option anyone could have
        // chosen. Counting the raw list there would leave the dashboard on "All
        // forms" with exactly one thing to pick.
        //
        // The `prev.form_id ?` guard keeps this from overwriting a choice; the
        // effect runs once, so it is belt-and-braces rather than load-bearing.
        const sole = selectableForms(f);
        if (sole.length === 1) {
          setFilters((prev) =>
            prev.form_id ? prev : { ...prev, form_id: String(sole[0].id) },
          );
        }
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
        archived: filters.archived,
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
  }, [filters.school_id, filters.form_id, filters.status, filters.from, filters.to, filters.archived, reloadKey]);

  // What the list above cannot tell us. A filtered list is the wrong instrument
  // for reporting its own omissions: with archived rows hidden they are absent by
  // construction, so the count can only come from the server.
  //
  // `filters.archived` is deliberately NOT a dependency and NOT a parameter. The
  // pair is the answer to "how many on each side", so this is the one request
  // that must see both lists at once — narrowing it by the very flag it is
  // measuring would return { active: 0, archived: n } or { active: n, archived: 0 }
  // depending on which toggle is on, which is exactly the useless half-answer.
  useEffect(() => {
    let cancelled = false;
    api
      .getSubmissionArchiveCounts({
        school_id: filters.school_id ? Number(filters.school_id) : undefined,
        form_id: filters.form_id ? Number(filters.form_id) : undefined,
        status: filters.status || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
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
  }, [filters.school_id, filters.form_id, filters.status, filters.from, filters.to, reloadKey]);

  // The counters are org-scoped server-side and deliberately ignore the grid's
  // form/school filters: a Google Forms response is rejected before any of the
  // app's own filters could apply, so narrowing by form would hide exactly the
  // failures that happened while a form was unpublished.
  useEffect(() => {
    let cancelled = false;
    api
      .getWebhookEventSummary({ days: 7 })
      .then((s) => {
        if (!cancelled) setWebhook(s);
      })
      .catch(() => {
        // A missing strip is better than a broken page; the log itself will
        // surface the error.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setFilter = (key: TextFilterKey, value: string) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  const setArchived = (archived: boolean) => setFilters((prev) => ({ ...prev, archived }));

  // Clear resets every filter including the form. Leaving the form selected used
  // to mean "Clear" could not get you back to the full list.
  //
  // It also returns you to the ACTIVE list. A Clear button that left you looking
  // at archived rows would be the one control on the page that did not clear what
  // it implies it clears.
  const clearFilters = () =>
    setFilters({ school_id: "", form_id: "", status: "", from: "", to: "", archived: false });

  const busy = loading || extrasLoading;

  // Permanent delete. Admin-only, and the server enforces archive-first with a
  // 409 — this handler never assumes the dialog's premise is still true, because
  // the row may have been restored from another tab since the page loaded.
  const runDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteSubmission(pendingDelete.publicId);
      setPendingDelete(null);
      setReloadKey((n) => n + 1);
    } catch (e) {
      // The dialog stays open so the message has somewhere to land — a toast that
      // vanished with the modal would leave the row looking deleted.
      setDeleteError(e instanceof Error ? e.message : "Could not delete the submission.");
    } finally {
      setDeleting(false);
    }
  };

  const closeDelete = () => {
    if (deleting) return;
    setPendingDelete(null);
    setDeleteError(null);
  };

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

      {/* A silently-rejected response looks exactly like a form nobody filled in,
          so the intake counters sit on the dashboard rather than only inside the
          log. It is a link because the useful next step is always the log. */}
      {webhook && (
        <Link
          to={webhook.window.failed > 0 ? "/admin/webhooks?status=failed" : "/admin/webhooks"}
          className="card"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            padding: "10px 14px",
            marginBottom: 16,
            textDecoration: "none",
            color: "var(--text)",
            fontSize: 13,
          }}
        >
          <Webhook size={16} />
          <span>
            <strong>Webhook intake</strong> — last {webhook.days} days
          </span>
          <span className="badge badge-green">{webhook.window.succeeded} delivered</span>
          {webhook.window.failed > 0 && (
            <span className="badge badge-red">{webhook.window.failed} failed</span>
          )}
          {webhook.unattributed > 0 && (
            <span className="badge badge-slate" title="Attempts that could not be attributed to a form">
              {webhook.unattributed} unattributed
            </span>
          )}
          <span className="head-hint">
            {webhook.window.failed > 0
              ? "Click to see what was rejected — and re-send it"
              : "View the full log"}
          </span>
        </Link>
      )}

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
            {selectableForms(forms).map((f) => (
              <option key={f.id} value={f.id}>
                {formLabel(f)}
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
        {/* A switch, not a sixth dropdown. The other five all narrow WHICH rows
            match; this one chooses WHICH list you are looking at — an archived
            row keeps its workflow status, so there is no status value to fold it
            into. Its label is its children, so the visible words are the
            checkbox's accessible name. */}
        <Toggle checked={filters.archived} onChange={setArchived}>
          {ARCHIVE_TOGGLE_LABEL}
        </Toggle>
        <button className="clear" onClick={clearFilters}>
          Clear
        </button>
      </div>

      {/* What this filter is hiding.
          A filtered list is the wrong instrument for reporting its own
          omissions: with the toggle off the archived rows are absent by
          construction, so "4 of these were archived" can only come from the
          server. That count is the whole reason two separate lists are safe —
          without it, archiving would just look like data loss.

          Rendered unconditionally in the archive view, because there the EMPTY
          grid is the case that needs explaining: "nothing archived here, 12 still
          active" is a complete answer, whereas a bare table says nothing. */}
      {archiveCounts &&
        (filters.archived ? (
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
          emptyMessage={
            filters.archived
              ? "No archived submissions match these filters."
              : "No submissions for the selected filters."
          }
          /* Delete is offered only where the server would accept it: the Archive
             view, and only to an admin. Supplying the handler from those two
             conditions (rather than rendering a disabled button) is what keeps
             the Active view and every non-admin queue free of a control that
             would always refuse. */
          onDelete={
            filters.archived && user?.role === "admin"
              ? (publicId) => {
                  const row = submissions.find((s) => s.public_id === publicId);
                  setDeleteError(null);
                  setPendingDelete({
                    publicId,
                    name: row?.student_name || "Unnamed submission",
                  });
                }
              : undefined
          }
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

      {/* Permanent-delete confirmation. Nothing in this app used a
          `window.confirm`, and one here would be the only prompt that could not
          name the submission or explain what is left behind — which is the whole
          point of putting it in the page's own modal. */}
      {pendingDelete && (
        <div className="modal-overlay open" onClick={closeDelete}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Delete submission permanently?</h2>
              <button
                className="icon-button close"
                onClick={closeDelete}
                disabled={deleting}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <p style={BODY_TEXT}>
                <strong>{pendingDelete.name}</strong> and every answer it holds will be removed from
                this database. This cannot be undone — there is no archive to restore it from, and no
                copy of the answers is kept.
              </p>
              <p style={BODY_HINT}>
                Its answers, any ad-hoc fields added to it, and its generated-document record all go
                with it. The generated Google Doc file itself is <strong>not</strong> deleted — it
                stays in the organization's Drive folder, and this app simply loses its link to it.
              </p>
              {deleteError && (
                <div className="alert-error" style={{ marginTop: 12 }}>
                  {deleteError}
                </div>
              )}
            </div>
            <div className="modal-foot">
              <span className="spacer" />
              <button className="secondary-button" onClick={closeDelete} disabled={deleting}>
                Cancel
              </button>
              <button
                className="primary-button"
                onClick={runDelete}
                disabled={deleting}
                style={{ background: DANGER, borderColor: DANGER }}
              >
                {deleting ? "Deleting..." : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

