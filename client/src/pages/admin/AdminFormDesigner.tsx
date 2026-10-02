import { useEffect, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowDown, ArrowUp, Check, CheckCircle2, Plus, X } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import type { FormField, FieldType, FormVisibility, FormWithFields, RoleRow } from "../../types";
import { PageHead, formStatusBadge } from "../../components/layout";
import { useAuth } from "../../context/AuthContext";
import { useRoleCatalog, roleLabelFor, BUILT_IN_ROLES } from "../../lib/roles";

const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "textarea", label: "Text Area" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "email", label: "Email" },
  // A Google Drive document id, rendered as a clickable Docs link. Placed with
  // the single-value types (text/number/date/email) rather than with the choice
  // types, because it has no option list — the options editor below is an
  // ALLOWLIST (select/radio/checkbox), so this type correctly shows none.
  { value: "google_doc", label: "Google Document" },
  { value: "select", label: "Select" },
  { value: "radio", label: "Radio" },
  { value: "checkbox", label: "Checkbox" },
];

// The roles a staff-only field can be granted to.
//
// ★ This list is read from the LIVE role catalog, not from a constant here. It
// used to be `const ROLES = ["admin", "staff", "cdm_contact"]`, so a role an
// administrator created in Settings → Roles got no toggle at all: the Reviewer
// role could not be granted on any field, and neither could any role added
// afterwards. `lib/roles.ts` is the same catalog every other role-aware screen
// reads, so a newly created role appears in this row the moment it exists.
//
// `BUILT_IN_ROLES` is only the first-paint fallback, for the moment before the
// catalog request returns, so the row is never briefly empty. Any key the field
// already names is UNIONED IN even when the catalog does not list it: a grant
// written before a role was renamed or deleted — or read before the catalog
// loads — must stay visible and removable rather than silently hidden.
function accessRoleKeys(field: FormField, catalog: readonly RoleRow[]): string[] {
  const base = catalog.length > 0 ? catalog.map((r) => r.role_key) : [...BUILT_IN_ROLES];
  const extra = (field.roles ?? []).filter((key) => !base.includes(key));
  return [...base, ...extra];
}

export default function AdminFormDesigner() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const formId = Number(id);

  const [form, setForm] = useState<FormWithFields | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Q4: set when the webhook log holds responses that were rejected while this
  // form was unpublished. Publishing restores the ability to deliver them, but
  // it never re-delivers them on its own — so the prompt is raised both right
  // after a publish and on arrival, for an admin coming back to a form that was
  // unpublished earlier (possibly by someone else) while it was still off.
  const [webhookPrompt, setWebhookPrompt] = useState<{ failed: number } | null>(null);

  // Which field tab is active: parent-facing ("form") or staff-only ("staff").
  const [activeTab, setActiveTab] = useState<"form" | "staff">("form");

  // Editor state for the field list
  const [fields, setFields] = useState<FormField[]>([]);

  // Editable form-level metadata (prefix / title / description). The prefix is
  // the form's submission-id code, so `GOVS` makes the next response
  // `GOVS-00001`.
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [prefix, setPrefix] = useState("");

  // Per-form Google Drive folder override + live validation. `null` = not yet
  // checked; `true`/`false` reflect a valid/invalid folder id.
  const [docFolderId, setDocFolderId] = useState("");
  const [docFolderValid, setDocFolderValid] = useState<boolean | null>(null);
  const [docFolderName, setDocFolderName] = useState("");

  // Optional link to the source Google Form, plus the "generate fields" toggle.
  // The toggle is stored on the form; generation itself needs the Google Forms
  // OAuth scope (not yet configured), so the button surfaces a clear message.
  const [googleFormUrl, setGoogleFormUrl] = useState("");
  const [generateFormFields, setGenerateFormFields] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateMsg, setGenerateMsg] = useState("");
  // Visibility is saved on its own (it has a side effect on form_access), so it
  // carries its own busy flag and message rather than joining the form's dirty
  // state — a pending change here must never look like an unsaved form edit.
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [visibilityMsg, setVisibilityMsg] = useState("");

  /**
   * Set the form's visibility and report the grandfather count.
   *
   * ★ NOT optimistic and NOT part of `handleSave`: the server writes a grant row
   * for every School Contact who could see the form a moment ago, and the count
   * is the only evidence that happened. A wrong count here is wrong in the
   * direction of locking someone out, so it is shown rather than assumed.
   */
  const changeVisibility = async (visibility: FormVisibility) => {
    setVisibilityBusy(true);
    setVisibilityMsg("");
    setError("");
    try {
      const updated = await api.setFormVisibility(formId, visibility);
      setForm(updated);
      setVisibilityMsg(
        visibility === "private"
          ? updated.granted > 0
            ? `Now private. ${updated.granted} account${updated.granted === 1 ? "" : "s"} kept access.`
            : "Now private. No existing accounts needed to keep access."
          : "Now public. Everyone in the organization can read it."
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change visibility");
    } finally {
      setVisibilityBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    api
      .getForm(formId)
      .then((f) => {
        if (cancelled) return;
        setForm(f);
        setFields(f.fields || []);
        setTitle(f.title || "");
        setDescription(f.description ?? "");
        setPrefix(f.code ?? "");
        setDocFolderId(f.doc_folder_id ?? "");
        setGoogleFormUrl(f.google_form_url ?? "");
      })
      .catch(() => setError("Could not load form"))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [formId]);

  // Ask the webhook log whether anything was rejected for this form. Runs on
  // arrival as well as after a publish: a rejected response is invisible
  // everywhere else, and the admin may be opening this form precisely to fix it.
  // Deliberately fire-and-forget — a log we cannot read must never block editing.
  useEffect(() => {
    if (!Number.isFinite(formId)) return;
    let cancelled = false;
    api
      .getWebhookEventSummary({ form_id: formId })
      .then((summary) => {
        // `form` is null when the server has never seen a response for this id.
        if (!cancelled && summary.form && summary.form.failed > 0) {
          setWebhookPrompt({ failed: summary.form.failed });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [formId]);

  // Debounced live validation of the Drive Folder ID. Once the admin stops
  // typing, ask the server to confirm the id is an accessible folder. Blank →
  // no checkmark (neutral). Any valid folder → green checkmark.
  useEffect(() => {
    const id = docFolderId.trim();
    if (!id) {
      setDocFolderValid(null);
      setDocFolderName("");
      return;
    }
    const timer = window.setTimeout(() => {
      api
        .validateDriveFolder(formId, id)
        .then((r) => {
          setDocFolderValid(r.valid);
          setDocFolderName(r.name ?? "");
        })
        .catch(() => {
          setDocFolderValid(false);
          setDocFolderName("");
        });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [docFolderId, formId]);

  // Ask the server to generate fields from the linked Google Form. Not yet
  // implemented server-side (needs the Google Forms OAuth scope), so this
  // surfaces the server's actionable message instead of failing silently.
  const handleGenerateFields = async () => {
    const url = googleFormUrl.trim();
    if (!url) {
      setGenerateMsg("Enter a Google Form URL first.");
      return;
    }
    setGenerating(true);
    setGenerateMsg("");
    try {
      const result = await api.generateFormFields(formId, url);
      // Populate the designer with the returned fields (nothing is saved until
      // the admin clicks Save).
      const imported = result.fields as FormField[];
      if (Array.isArray(imported) && imported.length) {
        setFields((prev) => [...prev, ...imported]);
        setDirty(true);
        setGenerateMsg(`Imported ${imported.length} field(s) — review and Save.`);
      } else {
        setGenerateMsg("No fields found in that Google Form.");
      }
    } catch (err) {
      setGenerateMsg(err instanceof ApiError ? err.message : "Could not generate fields");
    } finally {
      setGenerating(false);
    }
  };

  const rebuildField = (index: number, patch: Partial<FormField>) => {
    setFields((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
    setDirty(true);
  };

  // The form's parent-facing fields and its staff-only fields. Each tab renders
  // a filtered view of the single `fields` source of truth, but once a field is
  // created its group (staff_only) is fixed, so toggling the tab never migrates it.
  const formFields = fields.filter((f) => !f.staff_only);
  const staffFields = fields.filter((f) => f.staff_only);

  const addField = () => {
    const isStaff = activeTab === "staff";
    setFields((prev) => [
      ...prev,
      {
        id: 0,
        form_id: formId,
        label: "New field",
        type: "text",
        options: null,
        required: false,
        staff_only: isStaff,
        // `null` means UNRESTRICTED — every role, including ones created later —
        // and the Access row renders that with every button on. Writing an
        // explicit list of today's roles here is what froze a field against
        // every role added afterwards (see `fieldAccessRoles` on the server).
        roles: null,
        sort_order: prev.length,
        placeholder: null,
      },
    ]);
    setDirty(true);
  };

  const removeField = (field: FormField) => {
    setFields((prev) => prev.filter((f) => f !== field));
    setDirty(true);
  };

  const moveField = (field: FormField, dir: -1 | 1) => {
    setFields((prev) => {
      const idx = prev.indexOf(field);
      if (idx < 0) return prev;
      // Move within the same group (skip fields of the other tab).
      let target = idx + dir;
      while (target >= 0 && target < prev.length && prev[target].staff_only !== field.staff_only) {
        target += dir;
      }
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      await api.updateForm(formId, {
        title: title || "Untitled",
        description: description || null,
        // Omitted when blank so the stored prefix is left alone rather than
        // dropped to the `SUB` fallback (an empty string means the same thing
        // server-side, but omitting the key states the intent at the call site).
        ...(prefix.trim() ? { code: prefix.trim() } : {}),
        doc_folder_id: docFolderId.trim() || null,
        google_form_url: googleFormUrl.trim() || null,
        fields: fields.map((f, i) => ({
          id: f.id || undefined,
          label: f.label,
          type: f.type,
          options: f.options,
          required: f.required,
          staff_only: f.staff_only,
          // Preserve the selection exactly, including BOTH sentinel states:
          // `null` stays null (unrestricted, so a role created later is still
          // admitted) and `[]` stays `[]` (a deliberate "no access" that must
          // survive the round-trip). Materialising the role list here would
          // silently narrow an unrestricted field to the roles that happened to
          // exist at save time.
          roles: f.staff_only ? (f.roles ?? null) : null,
          sort_order: i,
          placeholder: f.placeholder,
        })),
      });
      // Re-fetch to get canonical ids / reset dirty
      const fresh = await api.getForm(formId);
      setForm(fresh);
      setFields(fresh.fields || []);
      setTitle(fresh.title || "");
      setDescription(fresh.description ?? "");
      setPrefix(fresh.code ?? "");
      setDocFolderId(fresh.doc_folder_id ?? "");
      setGoogleFormUrl(fresh.google_form_url ?? "");
      setDirty(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save form");
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    const next = form?.status === "published" ? "draft" : "published";
    try {
      const updated = await api.updateFormStatus(formId, next);
      setForm(updated);
      setWebhookPrompt(null);
      // Q4: publishing again does not silently re-deliver anything. Responses
      // that arrived while the form was unpublished were rejected, so they are
      // recoverable — but only by an explicit action, which is why this reports
      // the count and links to the log instead of replaying.
      if (next === "published") {
        try {
          const summary = await api.getWebhookEventSummary({ form_id: formId });
          if (summary.form && summary.form.failed > 0) {
            setWebhookPrompt({ failed: summary.form.failed });
          }
        } catch {
          // The prompt is a convenience; never let it break publishing.
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update status");
    }
  };

  if (loading) {
    return (
      <div className="loading-state">
        <div className="spinner" /> Loading form...
      </div>
    );
  }

  if (error && !form) {
    return <div className="empty-state">{error}</div>;
  }

  // Subtitle parts, joined only when present. The previous template always emitted
  // the ID and its trailing separator, so a form that had not loaded yet rendered
  // as "ID 2 ·  · academics" with a hole where the status belonged.
  const headerMeta = [form && formStatusBadge(form.status).label, user?.organization_slug]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  // Mirror of the server's `formCodeSchema` in schemas.ts: trimmed, uppercased,
  // stripped to A–Z/0–9, and capped at 8. It has to sanitise the SAME way or the
  // preview would promise an id the API stores differently. Over-length is an
  // error rather than a silent truncation, again matching the server, which
  // rejects it — silently slicing here would show "GOVSCHOO" while the save
  // failed with "Use 8 characters or fewer".
  const sanitizedPrefix = prefix.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const prefixTooLong = sanitizedPrefix.length > 8;

  // A blank box omits `code` from the payload, so the stored prefix is kept —
  // that is `form.code`, NOT the `SUB` fallback (which only applies to a form
  // that has never had a prefix). Falling back to "SUB" here would describe a
  // re-prefixing this save does not perform.
  const effectivePrefix = sanitizedPrefix || form?.code || "SUB";
  const nextSubmissionId = `${effectivePrefix}-${String(
    (form?.submission_seq ?? 0) + 1
  ).padStart(5, "0")}`;

  return (
    <div>
      {/* The ID leads the title instead of trailing in the muted subtitle. It has to
          match the number the Google Apps Script is configured with, so it is the one
          part of this header that gets read digit by digit and copied out. */}
      <PageHead
        title={`#${formId} ${title || "Form Designer"}`}
        subtitle={headerMeta}
        actions={
          <>
            <button className="secondary-button" onClick={() => navigate("/admin/forms")}>
              Back
            </button>
            <button
              className="secondary-button"
              onClick={handlePublish}
              style={
                form?.status === "published"
                  ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }
                  : {}
              }
            >
              {form?.status === "published" ? "Unpublish" : "Publish"}
            </button>
            <button className="primary-button" onClick={handleSave} disabled={saving || !dirty}>
              {saving ? "Saving..." : "Save"}
            </button>
          </>
        }
      />

      {webhookPrompt && (
        <div
          className="card"
          style={{
            borderColor: "var(--orange-tint-line)",
            background: "var(--orange-tint)",
            padding: "12px 14px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            fontSize: "0.8125rem",
            marginBottom: 16,
          }}
        >
          <AlertTriangle size={16} />
          {/* The prompt is raised on arrival as well as after a publish, so the
              wording has to follow the form's current status rather than assume
              the admin just published it. */}
          <span>
            {form?.status === "published" ? (
              <>
                Published, but {webhookPrompt.failed} response{webhookPrompt.failed === 1 ? "" : "s"} that
                arrived while this form was unpublished {webhookPrompt.failed === 1 ? "was" : "were"}{" "}
                rejected. Since this form is published again, those responses can now be delivered.
              </>
            ) : (
              <>
                This form is not published, and {webhookPrompt.failed} response
                {webhookPrompt.failed === 1 ? "" : "s"} posted while it was off {webhookPrompt.failed === 1 ? "was" : "were"}{" "}
                rejected and never stored. Publishing it again makes them deliverable.
              </>
            )}
          </span>
          <Link className="badge-button" to={`/admin/webhooks?form_id=${formId}&status=failed`}>
            Review and re-send
          </Link>
          <button className="icon-button" onClick={() => setWebhookPrompt(null)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      {error && (
        <div
          style={{
            background: "rgb(255,232,234)",
            color: "rgb(186,48,64)",
            padding: "10px 12px",
            borderRadius: "var(--radius)",
            fontSize: "0.8125rem",
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>Form Details</h3>
        </div>
        <div className="card-body">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="filter-group" style={{ minWidth: 0 }}>
              <label>Prefix</label>
              <input
                type="text"
                value={prefix}
                placeholder="e.g. GOVS"
                maxLength={12}
                onChange={(e) => {
                  setPrefix(e.target.value);
                  setDirty(true);
                }}
              />
              {prefixTooLong ? (
                <div style={{ fontSize: "0.75rem", color: "var(--danger, #b93040)", marginTop: 4 }}>
                  Use 8 characters or fewer (A–Z and 0–9 only).
                </div>
              ) : (
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>
                  The next submission will be{" "}
                  {/* The id is the actionable part of this caption, so it gets
                      --text rather than the caption's --text-muted (~3.7:1 at
                      this size, under the 4.5:1 floor) — the same call made for
                      .badge.sysmsg-audience in global.css. */}
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontWeight: 600,
                      color: "var(--text)",
                    }}
                  >
                    {nextSubmissionId}
                  </span>
                  . Existing submissions keep the prefix they were created with.
                </div>
              )}
            </div>
            <div className="filter-group" style={{ minWidth: 0 }}>
              <label>Title</label>
              <input
                type="text"
                value={title}
                placeholder="Form title"
                onChange={(e) => {
                  setTitle(e.target.value);
                  setDirty(true);
                }}
              />
            </div>
            <div className="filter-group" style={{ minWidth: 0 }}>
              <label>Description</label>
              <textarea
                value={description}
                rows={2}
                placeholder="Optional description shown to parents"
                onChange={(e) => {
                  setDescription(e.target.value);
                  setDirty(true);
                }}
              />
            </div>
            <div className="filter-group" style={{ minWidth: 0 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                Drive Folder ID
                {docFolderValid === true && (
                  <span
                    style={{
                      color: "var(--success, #16a34a)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: "0.75rem",
                      fontWeight: 600,
                    }}
                    title={docFolderName ? `Valid folder: ${docFolderName}` : "Valid folder"}
                  >
                    <CheckCircle2 size={16} color="#16a34a" aria-hidden="true" />
                    Valid
                  </span>
                )}
                {docFolderValid === false && (
                  <span
                    style={{
                      color: "var(--danger, #b93040)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: "0.75rem",
                      fontWeight: 600,
                    }}
                    title="This folder id isn't an accessible Google Drive folder"
                  >
                    Invalid folder
                  </span>
                )}
              </label>
              <input
                type="text"
                value={docFolderId}
                placeholder="Google Drive folder ID (optional — blank uses the default folder)"
                onChange={(e) => {
                  setDocFolderId(e.target.value);
                  setDirty(true);
                }}
              />
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>
                Generated documents for this form are saved to this folder. Leave blank to use the default.
              </div>
            </div>

            <div className="filter-group" style={{ minWidth: 0 }}>
              <label>Google Form URL</label>
              <input
                type="text"
                value={googleFormUrl}
                placeholder="https://docs.google.com/forms/d/.../edit"
                onChange={(e) => {
                  setGoogleFormUrl(e.target.value);
                  setDirty(true);
                }}
              />
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>
                Optional link to the source Google Form. Shown to staff so they can open it.
              </div>

              {/* Visibility — its OWN control, not part of the form's save.
                  ★ Switching to private has a SIDE EFFECT on a different table
                  (it grandfathers every School Contact who can see the form), so
                  it goes through PATCH /api/forms/:id/visibility rather than
                  riding along on a general form edit. The confirmation names the
                  count, because a wrong number here locks people out. */}
              <label style={{ marginTop: 12, display: "block" }}>Visibility</label>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <select
                  className="edit-select"
                  value={form?.visibility ?? "public"}
                  disabled={visibilityBusy}
                  onChange={(e) => void changeVisibility(e.target.value as FormVisibility)}
                >
                  <option value="public">Public — everyone in the organization</option>
                  <option value="private">Private — School Contacts need a grant</option>
                </select>
                {visibilityBusy && <span className="cell-sub">Saving…</span>}
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>
                A private form is hidden from School Contacts unless an administrator grants access.
                Administrators and staff always see it. Families can still submit either way.
              </div>
              {visibilityMsg && (
                <div
                  className="cell-sub"
                  style={{ marginTop: 4, color: "var(--text)" }}
                  role="status"
                >
                  {visibilityMsg}
                </div>
              )}

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginTop: 12,
                  fontSize: "0.8125rem",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={generateFormFields}
                  onChange={(e) => {
                    setGenerateFormFields(e.target.checked);
                    setDirty(true);
                  }}
                />
                Generate form fields
              </label>
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>
                When enabled, the fields below are created automatically from the Google Form.
                Requires Google Forms access to be configured.
              </div>

              {generateFormFields && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void handleGenerateFields()}
                    disabled={generating || !googleFormUrl.trim()}
                  >
                    {generating ? "Generating…" : "Generate fields now"}
                  </button>
                  {generateMsg && (
                    <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{generateMsg}</span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head" style={{ flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
          <h3>Fields</h3>
          <div className="tabs">
            <button
              type="button"
              className={`tab ${activeTab === "form" ? "active" : ""}`}
              onClick={() => setActiveTab("form")}
            >
              Form Fields ({formFields.length})
            </button>
            <button
              type="button"
              className={`tab ${activeTab === "staff" ? "active" : ""}`}
              onClick={() => setActiveTab("staff")}
            >
              Staff Only Fields ({staffFields.length})
            </button>
          </div>
        </div>
        <div className="card-body">
          {activeTab === "form" ? (
            <>
              <div className="sub" style={{ marginBottom: 12, fontSize: "0.75rem", color: "var(--text-muted)" }}>
                These fields are shown to parents when they submit the form.
              </div>
              {formFields.length === 0 ? (
                <div className="empty-state">No parent-facing fields yet. Add your first field below.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {formFields.map((f) => (
                    <FieldRow
                      key={f.id}
                      field={f}
                      index={fields.indexOf(f)}
                      count={fields.length}
                      showStaffOnlyToggle={false}
                      onChange={(patch) => rebuildField(fields.indexOf(f), patch)}
                      onRemove={() => removeField(f)}
                      onMove={(dir) => moveField(f, dir)}
                    />
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="sub" style={{ marginBottom: 12, fontSize: "0.75rem", color: "var(--text-muted)" }}>
                These fields are hidden from parents. Staff fill them in on each submission's detail page.
              </div>
              {staffFields.length === 0 ? (
                <div className="empty-state">No staff-only fields yet. Add one to capture private info per submission.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {staffFields.map((f) => (
                    <FieldRow
                      key={f.id}
                      field={f}
                      index={fields.indexOf(f)}
                      count={fields.length}
                      showStaffOnlyToggle={false}
                      onChange={(patch) => rebuildField(fields.indexOf(f), patch)}
                      onRemove={() => removeField(f)}
                      onMove={(dir) => moveField(f, dir)}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          <button className="secondary-button" onClick={addField} style={{ marginTop: 14 }}>
            <Plus size={14} />
            Add {activeTab === "staff" ? "Staff Only" : "Form"} Field
          </button>
        </div>
      </div>

      {form?.status === "published" && user?.organization_slug && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <h3>Public link</h3>
            <span className="sub">Share this link with parents</span>
          </div>
          <div className="card-body">
            <code className="cell-mono" style={{ wordBreak: "break-all" }}>
              {`/org/${user.organization_slug}/forms/${form.id}`}
            </code>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function FieldRow({
  field,
  index,
  count,
  showStaffOnlyToggle,
  onChange,
  onRemove,
  onMove,
}: {
  field: FormField;
  index: number;
  count: number;
  showStaffOnlyToggle: boolean;
  onChange: (patch: Partial<FormField>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  // Hold the raw options text while the user types, so commas aren't stripped by
  // the array→string round-trip on every keystroke. Synced from field.options
  // whenever it changes externally (e.g. loading the form, or a different field).
  const isOptionsField = field.type === "select" || field.type === "radio" || field.type === "checkbox";
  const [optionsText, setOptionsText] = useState(isOptionsField ? (field.options || []).join(", ") : "");
  useEffect(() => {
    if (field.type === "select" || field.type === "radio" || field.type === "checkbox") {
      setOptionsText((field.options || []).join(", "));
    }
  }, [field.options, field.type]);

  // Subscribing here (rather than passing the list down) is what makes the
  // Access row pick up a role created in another tab without a reload. A hook
  // cannot be called inside the `field.staff_only &&` block below, which is
  // why it sits at the top of the component.
  const { roles: roleCatalog } = useRoleCatalog();
  const roleKeys = accessRoleKeys(field, roleCatalog);

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: 14,
        background: "var(--panel-bg)",
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
        <span className="cell-mono" style={{ fontSize: "0.6875rem" }}>
          #{index + 1}
        </span>
        <div style={{ display: "flex", gap: 4 }}>
          <button className="icon-button" title="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp size={16} />
          </button>
          <button className="icon-button" title="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>
            <ArrowDown size={16} />
          </button>
        </div>
        {showStaffOnlyToggle && (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: "0.8125rem",
              cursor: "pointer",
              marginLeft: 8,
            }}
          >
            <input
              type="checkbox"
              checked={field.staff_only}
              onChange={(e) => onChange({ staff_only: e.target.checked })}
            />
            Staff Only
          </label>
        )}
        {field.staff_only && !showStaffOnlyToggle && (
          <span className="badge badge-orange" style={{ fontSize: "0.6875rem", marginLeft: 8 }}>
            Staff Only
          </span>
        )}
        <div className="filter-spacer" />
        <button className="icon-button" title="Remove field" onClick={onRemove}>
          <X size={16} />
        </button>
      </div>

      <div className="field-edit-grid">
        <div className="filter-group" style={{ minWidth: 0 }}>
          <label>Label</label>
          <input
            type="text"
            value={field.label}
            onChange={(e) => onChange({ label: e.target.value })}
          />
        </div>
        <div className="filter-group" style={{ minWidth: 0 }}>
          <label>Type</label>
          <select value={field.type} onChange={(e) => onChange({ type: e.target.value as FieldType })}>
            {FIELD_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {(field.type === "select" || field.type === "radio" || field.type === "checkbox") && (
        <div className="filter-group" style={{ minWidth: 0, marginTop: 12 }}>
          <label>Options (comma separated)</label>
          <input
            type="text"
            value={optionsText}
            onChange={(e) => setOptionsText(e.target.value)}
            onBlur={() =>
              onChange({
                options: optionsText.split(",").map((s) => s.trim()).filter(Boolean),
              })
            }
          />
          <div className="filter-hint" style={{ fontSize: "0.6875rem", color: "var(--text-muted)", marginTop: 4 }}>
            Separate each option with a comma (e.g. Option A, Option B, Option C).
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
        {field.staff_only && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span
              style={{
                fontSize: "0.6875rem",
                fontWeight: 700,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--text-muted)",
              }}
            >
              Access
            </span>
            {roleKeys.map((role) => {
              // Three states, rendered distinctly:
              //   null -> unrestricted, so every role reads as granted
              //   []   -> granted to nobody, so no role reads as granted
              //   [..] -> exactly those roles
              const granted = Array.isArray(field.roles) ? field.roles : null;
              const has = granted === null || granted.includes(role);
              return (
                <button
                  key={role}
                  type="button"
                  title={`${has ? "Remove" : "Grant"} ${roleLabelFor(role)} access to this field`}
                  onClick={() => {
                    // Base the toggle on the CURRENT selection, keeping the two
                    // sentinels apart: an unrestricted field (null) starts from
                    // "every role", while an explicit empty array stays empty.
                    // `field.roles?.length` collapsed those two — on a field
                    // granted to nobody, re-granting one role snapped every
                    // other button back on.
                    const current = Array.isArray(field.roles) ? field.roles : roleKeys;
                    const next = has ? current.filter((r) => r !== role) : [...current, role];
                    // Persist the explicit selection. An empty array is a valid
                    // value ("no role may access this field") and must NOT be
                    // coerced back to the full role set — that fallback is what
                    // made removing the last role snap every button back on.
                    onChange({ roles: next });
                  }}
                  style={{
                    cursor: "pointer",
                    fontSize: "0.8125rem",
                    fontWeight: 700,
                    padding: "7px 14px",
                    borderRadius: "var(--radius)",
                    // inline-flex + gap so the lucide check/plus sits on the text
                    // baseline instead of relying on a glyph's side bearing.
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    transition: "background-color .13s ease, border-color .13s ease, color .13s ease",
                    background: has ? "var(--accent)" : "var(--card-bg)",
                    color: has ? "#fff" : "var(--accent)",
                    border: `1px solid ${has ? "var(--accent)" : "var(--accent)"}`,
                  }}
                >
                  {has ? <Check size={14} /> : <Plus size={14} />}
                  <span>{roleLabelFor(role)}</span>
                </button>
              );
            })}
          </div>
        )}

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.8125rem", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={field.required}
            onChange={(e) => onChange({ required: e.target.checked })}
          />
          Required
        </label>
      </div>
    </div>
  );
}
