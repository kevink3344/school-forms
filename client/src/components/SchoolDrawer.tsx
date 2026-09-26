import { useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { School, SchoolFacets } from "../types";

// ---------------------------------------------------------------------------
// Add / edit one school — right slide-out drawer.
//
// One component serves both jobs: `school === null` is "Add School", a School is
// "Edit School". They share every field, so a second drawer would only be a copy
// with the same four inputs and a different heading.
//
// The name field is the one that matters. A submission's typed answer is matched
// to a school by exact name (resolveSubmissionSchoolId compares
// LOWER(schools.name)), so a school added here only starts collecting
// submissions if its name is spelled the way the Google Form spells it. The hint
// under the field says so rather than leaving it to be discovered.
// ---------------------------------------------------------------------------

export interface SchoolDrawerProps {
  open: boolean;
  /** null ⇒ add, a School ⇒ edit. */
  school: School | null;
  /** Distinct grade levels / calendars already in the table, offered as suggestions. */
  facets: SchoolFacets;
  onClose: () => void;
  onSaved: (school: School) => void;
}

interface FormState {
  name: string;
  grade_level: string;
  calendar: string;
  district: string;
}

const EMPTY_FORM: FormState = { name: "", grade_level: "", calendar: "", district: "" };

// The drawer edits text, so a NULL column becomes "" (and is turned back into
// NULL by the route's trim). Keeping that conversion in one place means the
// inputs never have to think about it.
function formFrom(school: School | null): FormState {
  if (!school) return EMPTY_FORM;
  return {
    name: school.name,
    grade_level: school.grade_level ?? "",
    calendar: school.calendar ?? "",
    district: school.district ?? "",
  };
}

function Field({
  label,
  children,
  full,
}: {
  label: string;
  children: ReactNode;
  full?: boolean;
}) {
  return (
    <label className="cf" style={full ? { gridColumn: "1 / -1" } : undefined}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function SchoolDrawer({ open, school, facets, onClose, onSaved }: SchoolDrawerProps) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isEdit = school !== null;
  // A school that arrived from SCHOOL_JSON carries a source_id; the feed's MERGE
  // matches on that key, so this is also the test for "an import can overwrite
  // what you type here".
  const fromFeed = school?.source_id !== null && school?.source_id !== undefined;

  // Reset on every open (and whenever the drawer is pointed at a different
  // school) so a cancelled edit never leaks into the next one.
  useEffect(() => {
    if (!open) return;
    setForm(formFrom(school));
    setError("");
    setSaving(false);
  }, [open, school]);

  if (!open) return null;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const canSave = form.name.trim().length > 0 && !saving;

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      // All four fields are always sent. `` for a blank text field is deliberate:
      // the route trims it to NULL, so clearing a value is possible without a
      // separate "unset" gesture.
      const payload = {
        name: form.name.trim(),
        grade_level: form.grade_level.trim(),
        calendar: form.calendar.trim(),
        district: form.district.trim(),
      };
      const saved =
        isEdit && school
          ? await api.updateSchool(school.id, payload)
          : await api.createSchool(payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the school");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="drawer-overlay open" onClick={onClose}>
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? "Edit school" : "Add school"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <h2>{isEdit ? "Edit School" : "Add School"}</h2>
          <button className="icon-button close" onClick={onClose} title="Close" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="drawer-body">
          {error && (
            <div className="alert-error" role="alert" style={{ marginBottom: 12 }}>
              {error}
            </div>
          )}

          <div className="form-grid">
            <Field label="Name" full>
              <input
                className="edit-input"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Moore Square Magnet Middle School"
                autoFocus
              />
              <span className="field-note">
                Submissions are matched to a school by name, so this must be spelled exactly the way
                the form spells it — a near miss leaves the submission pointing at whichever school
                the answer resolves to, or at none.
              </span>
            </Field>

            <Field label="Grade Level">
              <input
                className="edit-input"
                list="school-grade-options"
                value={form.grade_level}
                onChange={(e) => set("grade_level", e.target.value)}
                placeholder="Elementary"
              />
            </Field>

            <Field label="Calendar">
              <input
                className="edit-input"
                list="school-calendar-options"
                value={form.calendar}
                onChange={(e) => set("calendar", e.target.value)}
                placeholder="Traditional"
              />
            </Field>

            <Field label="District" full>
              <input
                className="edit-input"
                value={form.district}
                onChange={(e) => set("district", e.target.value)}
                placeholder="Wake County"
              />
            </Field>
          </div>

          {/* Suggestions come from the values already in the table, but the inputs
              stay free text — a new school type must not be blocked by the fact
              that no existing row uses it yet. */}
          <datalist id="school-grade-options">
            {facets.gradeLevels.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          <datalist id="school-calendar-options">
            {facets.calendars.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>

          {isEdit && (
            <p className="field-note" style={{ marginTop: 14 }}>
              {fromFeed
                ? "This school came from the district feed. A future Import Schools would overwrite the name you set here."
                : "This school was added by hand, so the district feed does not manage it."}
            </p>
          )}
        </div>

        <div className="drawer-foot">
          <span className="muted-note">{isEdit ? "Editing school" : "New school"}</span>
          <button className="secondary-button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="primary-button" onClick={() => void handleSave()} disabled={!canSave}>
            {saving ? "Saving…" : isEdit ? "Save" : "Add School"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default SchoolDrawer;
